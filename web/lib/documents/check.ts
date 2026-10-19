// The check of an engine draft (BRIEF 7.1, 7.2, 7.6; Willem 17/10):
//  - every yellow part is confirmed by a person (corrected or "OK as is") before Finalise
//  - Finalise = the worker writes the fixes in and runs the engine's own --finalise (PDF)
//  - a draft without yellow is approved by a person; engine output is never Final by itself
//  - becoming Final supersedes the previous Final of the same name (never overwrite)
//  - every correction / rejection is kept as feedback for the admin overview
import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { logAudit, type Actor } from "../audit";
import type { Db } from "../db";
import { documents, feedback, jobs, type DocMetadata, type Document, type FinalisePayload } from "../db/schema";
import { detectType, MAX_FILE_BYTES, parseUploadKey, cleanFilename } from "../files";
import { wakeWorker } from "../jobs";
import type { Storage } from "../storage";

export class CheckError extends Error {}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const clean = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "contains control characters");

export const metadataInput = z.object({
  productName: clean(200).min(1, "product name is required"),
  fileNr: clean(50).transform((s) => s || null),
  batch: clean(100).transform((s) => s || null),
});

const fixesInput = z.record(z.string().regex(/^y\d{1,4}$/), z.object({ value: clean(500) }));

async function loadDraft(db: Db | Tx, id: string): Promise<Document> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new CheckError("document not found");
  const [doc] = await db.select().from(documents).where(eq(documents.id, id));
  if (!doc) throw new CheckError("document not found");
  if (doc.status !== "To check") throw new CheckError(`this document is ${doc.status}, not waiting for a check`);
  return doc;
}

async function openFinaliseJob(db: Db, documentId: string) {
  const [open] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.documentId, documentId), eq(jobs.kind, "finalise"), inArray(jobs.state, ["queued", "running"])));
  return open ?? null;
}

/** The person's decisions, before anything is sent to the worker. */
export async function requestFinalise(db: Db, storage: Storage, actor: Actor, documentId: string, raw: unknown) {
  const doc = await loadDraft(db, documentId);
  if (await openFinaliseJob(db, doc.id)) throw new CheckError("this document is already being finalised");
  const r = z
    .object({
      metadata: metadataInput,
      mode: z.enum(["editor", "upload"]),
      fixes: fixesInput.optional(),
      docx: z.object({ key: z.string().max(200), filename: z.string().max(300) }).optional(),
    })
    .safeParse(raw);
  if (!r.success) throw new CheckError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const input = r.data;
  const parts = doc.yellowParts ?? [];

  let payload: FinalisePayload;
  const notes: (typeof feedback.$inferInsert)[] = [];
  if (input.mode === "editor") {
    const fixes = input.fixes ?? {};
    const missing = parts.filter((p) => !fixes[p.id]);
    if (missing.length) throw new CheckError(`confirm every yellow part first (${missing.length} left)`);
    const unknown = Object.keys(fixes).filter((id) => !parts.some((p) => p.id === id));
    if (unknown.length) throw new CheckError("unknown yellow part");
    if (!doc.docxKey) throw new CheckError("the draft has no Word file");
    for (const p of parts) {
      const after = fixes[p.id].value;
      notes.push({
        actor: actor.email,
        documentId: doc.id,
        kind: after === p.text ? "confirmed" : "corrected",
        partId: p.id,
        before: p.text,
        after,
        context: p.context,
      });
    }
    payload = { mode: "editor", fixes, metadata: input.metadata };
  } else {
    const ref = input.docx;
    const parsed = ref && parseUploadKey(ref.key);
    if (!ref || !parsed || parsed.kind !== "docx") throw new CheckError("upload the checked Word file");
    const head = await storage.head(ref.key, 8);
    if (!head || head.size > MAX_FILE_BYTES || !detectType("docx", head.bytes)) throw new CheckError("the file is not a Word document");
    const filename = cleanFilename(ref.filename);
    notes.push({ actor: actor.email, documentId: doc.id, kind: "word_upload", after: filename });
    payload = { mode: "upload", docx: { key: ref.key, filename }, metadata: input.metadata };
  }

  await db.transaction(async (tx) => {
    const [job] = await tx
      .insert(jobs)
      .values({ kind: "finalise", documentId: doc.id, entity: doc.entity, payload, createdBy: actor.email })
      .returning({ id: jobs.id });
    if (notes.length) await tx.insert(feedback).values(notes);
    await logAudit(tx, actor, "document.finalise_requested", doc.id, { job: job.id, mode: payload.mode });
  });
  await wakeWorker();
}

/**
 * Makes a checked draft Final: supersedes the current Final of the same name, gives the next
 * version number. One transaction; the database check refuses a Final without PDF, version
 * or product name.
 */
export async function makeFinal(
  tx: Tx,
  actor: Pick<Actor, "email">,
  doc: Document,
  files: { pdfKey: string; pdfFilename: string; docxKey: string; docxFilename: string },
  metadata: DocMetadata,
) {
  const [current] = await tx
    .select({ id: documents.id, version: documents.version })
    .from(documents)
    .where(and(eq(documents.name, doc.name), eq(documents.status, "Final")))
    .for("update");
  const [{ last }] = await tx
    .select({ last: sql<number | null>`max(${documents.version})` })
    .from(documents)
    .where(eq(documents.name, doc.name));
  if (current) {
    await tx.update(documents).set({ status: "Superseded" }).where(eq(documents.id, current.id));
    await logAudit(tx, actor, "document.superseded", current.id, { name: doc.name, version: current.version });
  }
  const version = (Number(last) || 0) + 1;
  const now = new Date();
  const updated = await tx
    .update(documents)
    .set({
      status: "Final",
      version,
      previousVersionId: current?.id ?? null,
      ...files,
      productName: metadata.productName,
      fileNr: metadata.fileNr,
      batch: metadata.batch,
      approvedBy: actor.email,
      approvedAt: now,
      yellowParts: [],
    })
    .where(and(eq(documents.id, doc.id), eq(documents.status, "To check")))
    .returning({ id: documents.id });
  if (!updated.length) throw new CheckError("the document changed while finalising");
  await logAudit(tx, actor, "document.finalised", doc.id, { name: doc.name, version, superseded: current?.version ?? null });
  await closeNeutraliseJobIfDone(tx, doc.jobId);
  return { version, supersededVersion: current?.version ?? null };
}

/** A neutralise job is done when none of its drafts waits for a check any more. */
async function closeNeutraliseJobIfDone(tx: Tx, jobId: string | null) {
  if (!jobId) return;
  const [{ open }] = await tx
    .select({ open: sql<number>`count(*)::int` })
    .from(documents)
    .where(and(eq(documents.jobId, jobId), eq(documents.status, "To check")));
  if (open === 0) await tx.update(jobs).set({ state: "done" }).where(and(eq(jobs.id, jobId), eq(jobs.state, "to_check")));
}

/** A draft the engine left without any yellow: a person still approves it (Willem 17/10). */
export async function approveDraft(db: Db, actor: Actor, documentId: string, rawMetadata: unknown) {
  const m = metadataInput.safeParse(rawMetadata);
  if (!m.success) throw new CheckError(m.error.issues.map((i) => i.message).join("; "));
  return db.transaction(async (tx) => {
    const doc = await loadDraft(tx, documentId);
    if ((doc.yellowParts ?? []).length) throw new CheckError("this draft has yellow parts: check them first");
    if (!doc.pdfKey || !doc.pdfFilename || !doc.docxKey || !doc.docxFilename) throw new CheckError("this draft has no PDF yet");
    return makeFinal(
      tx,
      actor,
      doc,
      { pdfKey: doc.pdfKey, pdfFilename: doc.pdfFilename, docxKey: doc.docxKey, docxFilename: doc.docxFilename },
      m.data,
    );
  });
}

export async function rejectDraft(db: Db, actor: Actor, documentId: string, rawReason: unknown) {
  const reason = clean(500).min(3, "give a short reason").safeParse(rawReason);
  if (!reason.success) throw new CheckError(reason.error.issues.map((i) => i.message).join("; "));
  if (await openFinaliseJob(db, documentId)) throw new CheckError("this document is being finalised");
  await db.transaction(async (tx) => {
    const doc = await loadDraft(tx, documentId);
    await tx.update(documents).set({ status: "Rejected", rejectedReason: reason.data }).where(eq(documents.id, doc.id));
    await tx.insert(feedback).values({ actor: actor.email, documentId: doc.id, kind: "rejected", reason: reason.data });
    await logAudit(tx, actor, "document.rejected", doc.id, { reason: reason.data });
    await closeNeutraliseJobIfDone(tx, doc.jobId);
  });
}
