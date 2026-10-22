// Documents: create (with versioning), list, read. Rules from BRIEF 7:
//  - never overwrite: same name = new version, the old Final one becomes Superseded (rule 6)
//  - drafts (To check) sit next to the Final version; only Final counts as current
//  - file names exactly as the engine makes them (rule 5, lib/naming.ts)
// Callers check login and role; this module checks the data.
import { and, desc, eq, ilike, inArray, notInArray, or, sql, type SQL } from "drizzle-orm";
import { logAudit, type Actor } from "../audit";
import type { Db } from "../db";
import { auditLog, documents, type DocStatus, type DocType, type Entity } from "../db/schema";
import { detectType, MAX_FILE_MB, maxFileBytes, parseUploadKey, cleanFilename, type FileKind } from "../files";
import { fileStem } from "../naming";
import type { Storage } from "../storage";
import { documentInput, type DocumentInput } from "./input";

export class DocumentError extends Error {}

export type CreateResult = { id: string; name: string; version: number; supersededVersion: number | null };

export async function createDocument(db: Db, storage: Storage, actor: Actor, raw: DocumentInput): Promise<CreateResult> {
  const parsed = documentInput.safeParse(raw);
  if (!parsed.success) throw new DocumentError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const input = parsed.data;

  const files: Partial<Record<FileKind, { key: string; filename: string }>> = {};
  for (const kind of ["pdf", "docx", "source"] as const) {
    const ref = input.files[kind];
    if (!ref) continue;
    await checkUploadedFile(db, storage, kind, ref.key);
    files[kind] = { key: ref.key, filename: cleanFilename(ref.filename) };
  }
  const pdf = files.pdf!;

  const name = fileStem({
    type: input.type,
    entity: input.entity,
    productName: input.productName,
    fileNr: input.fileNr,
    batch: input.batch,
    fallbackStem: pdf.filename.replace(/\.[^.]*$/, ""),
  });

  // Two people saving the same name at once: the unique index stops the second one; retry once.
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        const [current] = await tx
          .select({ id: documents.id, version: documents.version })
          .from(documents)
          .where(and(eq(documents.name, name), eq(documents.status, "Final")))
          .for("update");
        const [{ last }] = await tx
          .select({ last: sql<number | null>`max(${documents.version})` })
          .from(documents)
          .where(eq(documents.name, name));

        if (current) {
          await tx.update(documents).set({ status: "Superseded" }).where(eq(documents.id, current.id));
          await logAudit(tx, actor, "document.superseded", current.id, { name, version: current.version });
        }
        const version = (Number(last) || 0) + 1;
        const now = new Date();
        const [row] = await tx
          .insert(documents)
          .values({
            name,
            type: input.type,
            entity: input.entity,
            productName: input.productName,
            inciName: input.inciName,
            casNumber: input.casNumber,
            batch: input.batch,
            fileNr: input.fileNr,
            poNumber: input.poNumber,
            language: input.language,
            manufacturingDate: input.manufacturingDate,
            expiryOrRetestDate: input.expiryOrRetestDate,
            supplierName: input.supplierName,
            // Finished TMC documents are added directly as Final (Willem 16/10, Q6/Q7).
            status: "Final",
            version,
            previousVersionId: current?.id ?? null,
            pdfKey: pdf.key,
            pdfFilename: pdf.filename,
            docxKey: files.docx?.key ?? null,
            docxFilename: files.docx?.filename ?? null,
            sourceKey: files.source?.key ?? null,
            sourceFilename: files.source?.filename ?? null,
            tags: input.tags,
            createdBy: actor.email,
            createdAt: now,
            approvedBy: actor.email,
            approvedAt: now,
          })
          .returning({ id: documents.id });
        await logAudit(tx, actor, "document.created", row.id, { name, version, files: Object.keys(files) });
        return { id: row.id, name, version, supersededVersion: current?.version ?? null };
      });
    } catch (err) {
      if (attempt === 0 && isUniqueViolation(err)) continue;
      throw err;
    }
  }
}

async function checkUploadedFile(db: Db, storage: Storage, kind: FileKind, key: string) {
  const parsed = parseUploadKey(key);
  if (!parsed || parsed.kind !== kind) throw new DocumentError(`${kind}: invalid upload reference`);
  const head = await storage.head(key, 8);
  if (!head) throw new DocumentError(`${kind}: uploaded file not found`);
  if (head.size > maxFileBytes(kind)) throw new DocumentError(`${kind}: file is larger than ${MAX_FILE_MB[kind]} MB`);
  if (!detectType(kind, head.bytes)) throw new DocumentError(`${kind}: file content is not an allowed type`);
  const [used] = await db
    .select({ id: documents.id })
    .from(documents)
    .where(or(eq(documents.pdfKey, key), eq(documents.docxKey, key), eq(documents.sourceKey, key)))
    .limit(1);
  if (used) throw new DocumentError(`${kind}: this upload already belongs to another document`);
}

function isUniqueViolation(err: unknown) {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

// ------------------------------------------------------------------- reading
export type DocumentFilters = {
  q?: string;
  type?: DocType;
  entity?: Entity;
  status?: DocStatus | "all";
  product?: string;
  batch?: string;
  fileNr?: string;
};

export const PAGE_SIZE = 100;

function like(s: string) {
  return `%${s.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export async function listDocuments(db: Db, f: DocumentFilters, page = 0) {
  const where: SQL[] = [];
  // Library shows current documents and drafts; old versions and rejected drafts are one filter away.
  if (!f.status) where.push(notInArray(documents.status, ["Superseded", "Rejected"]));
  else if (f.status !== "all") where.push(eq(documents.status, f.status));
  if (f.type) where.push(eq(documents.type, f.type));
  if (f.entity) where.push(eq(documents.entity, f.entity));
  if (f.product) where.push(ilike(documents.productName, like(f.product)));
  if (f.batch) where.push(ilike(documents.batch, like(f.batch)));
  if (f.fileNr) where.push(ilike(documents.fileNr, like(f.fileNr)));
  if (f.q) {
    const p = like(f.q);
    where.push(
      or(
        ilike(documents.name, p),
        ilike(documents.productName, p),
        ilike(documents.batch, p),
        ilike(documents.fileNr, p),
        ilike(documents.inciName, p),
        ilike(documents.casNumber, p),
        ilike(documents.poNumber, p),
        ilike(documents.supplierName, p),
        sql`array_to_string(${documents.tags}, ' ') ilike ${p}`,
      )!,
    );
  }
  return db
    .select()
    .from(documents)
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(documents.createdAt))
    .limit(PAGE_SIZE + 1)
    .offset(page * PAGE_SIZE);
}

export async function getDocument(db: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select().from(documents).where(eq(documents.id, id));
  return row ?? null;
}

export async function getVersions(db: Db, name: string) {
  return db
    .select({ id: documents.id, version: documents.version, status: documents.status, createdAt: documents.createdAt, createdBy: documents.createdBy })
    .from(documents)
    .where(eq(documents.name, name))
    .orderBy(sql`${documents.version} desc nulls first`, desc(documents.createdAt));
}

export async function getAuditTrail(db: Db, documentIds: string[]) {
  if (!documentIds.length) return [];
  return db.select().from(auditLog).where(inArray(auditLog.documentId, documentIds)).orderBy(desc(auditLog.at)).limit(200);
}

export async function recordDownload(db: Db, actor: Actor, documentId: string, kind: FileKind) {
  await logAudit(db, actor, "document.downloaded", documentId, { file: kind });
}

/** How many drafts wait for a person (the number on the "To check" tab). */
export async function countToCheck(db: Db) {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(documents).where(eq(documents.status, "To check"));
  return n;
}
