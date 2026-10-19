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
import { countOpenJobs, MAX_OPEN_JOBS_PER_USER, wakeWorker } from "../jobs";
import { fileStem, plainName } from "../naming";
import type { Storage } from "../storage";

export class CheckError extends Error {}
/** The new name lands on the Final of another document: the person must confirm (review M1). */
export class ReplaceConfirmError extends CheckError {}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Control characters, invisible format characters (bidi overrides, zero-width) and line
// separators are refused (review I1).
const SAFE = (s: string) => !/[\u0000-\u001f\u007f\u2028\u2029\p{Cf}]/u.test(s);

const clean = (max: number) => z.string().trim().max(max).refine(SAFE, "contains control characters");

/** Yellow-part values are kept exactly as typed: no trimming, so "OK as is" changes nothing (review M1). */
const exact = (max: number) => z.string().max(max).refine(SAFE, "contains control characters");

export const metadataInput = z.object({
  productName: clean(200).min(1, "product name is required"),
  fileNr: clean(50).transform((s) => s || null),
  batch: clean(100).transform((s) => s || null),
});

// Every part carries the person's own confirmation (review L1).
const fixesInput = z.record(
  z.string().regex(/^y\d{1,4}$/),
  z.object({ value: exact(500), confirmed: z.literal(true, { error: "confirm every yellow part" }) }),
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Name and content agree (Willem 19/10): the file name is made from the checked details by the
// naming rule, each value in it must be printed in the document (the worker checks), and the
// batch the document was made for cannot be changed (one document per batch).
type NameSource = Pick<Document, "type" | "entity">;

/** The name a checked document gets. */
export function finalName(doc: NameSource, m: DocMetadata): string {
  const name = fileStem({ type: doc.type, entity: doc.entity, productName: m.productName, fileNr: m.fileNr, batch: m.batch });
  if (!plainName(name)) throw new CheckError("these details do not give a valid file name; check the product name");
  return name;
}

/** The values the file name is made of, as [label, value]: each must be printed in the document. */
export function shownValues(doc: NameSource, m: DocMetadata): [string, string][] {
  const all: [string, string | null][] =
    doc.type === "COA" ? [["product name", m.productName], ["dossier", m.fileNr], ["batch", m.batch]] : [["product name", m.productName]];
  return all.filter((v): v is [string, string] => !!v[1]);
}

/** The batch is fixed once the document has one. */
function lockBatch(doc: Document, m: DocMetadata): DocMetadata {
  if (doc.batch && m.batch !== doc.batch) throw new CheckError(`the batch of this document is ${doc.batch} and cannot be changed`);
  return m;
}

async function loadDraft(db: Db | Tx, id: string): Promise<Document> {
  if (!UUID.test(id)) throw new CheckError("document not found");
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
  if ((await countOpenJobs(db, actor.email)) >= MAX_OPEN_JOBS_PER_USER) {
    throw new CheckError("you already have many documents waiting; try again when some are done"); // review N6
  }
  const r = z
    .object({
      metadata: metadataInput,
      mode: z.enum(["editor", "upload", "edited"]),
      fixes: fixesInput.optional(),
      docx: z.object({ key: z.string().max(200), filename: z.string().max(300) }).optional(),
      confirmReplace: z.boolean().optional(),
      acceptChanges: z.boolean().optional(),
    })
    .safeParse(raw);
  if (!r.success) throw new CheckError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const input = { ...r.data, metadata: lockBatch(doc, r.data.metadata) };
  const confirmReplace = input.confirmReplace === true;
  const replaces = await guardReplace(db, doc, finalName(doc, input.metadata), confirmReplace);
  const parts = doc.yellowParts ?? [];

  let payload: FinalisePayload;
  const notes: (typeof feedback.$inferInsert)[] = [];
  if (input.mode === "editor") {
    const fixes = input.fixes ?? {};
    const missing = parts.filter((p) => !fixes[p.id]);
    if (missing.length) throw new CheckError(`confirm every yellow part first (${missing.length} left)`);
    const unknown = Object.keys(fixes).filter((id) => !parts.some((p) => p.id === id));
    if (unknown.length) throw new CheckError("unknown yellow part");
    if (parts.some((p) => p.truncated)) throw new CheckError("a yellow part is too long for the on-screen check: check it in Word");
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
    if (!ref || !parsed || parsed.kind !== "docx") throw new CheckError(input.mode === "edited" ? "save the edited document first" : "upload the checked Word file");
    const head = await storage.head(ref.key, 8);
    if (!head || head.size > MAX_FILE_BYTES || !detectType("docx", head.bytes)) throw new CheckError("the file is not a Word document");
    const filename = cleanFilename(ref.filename);
    if (input.mode === "edited") {
      // edited on screen: the worker records every change when it becomes Final
      payload = { mode: "edited", docx: { key: ref.key, filename }, metadata: input.metadata, acceptChanges: input.acceptChanges === true };
    } else {
      notes.push({ actor: actor.email, documentId: doc.id, kind: "word_upload", after: filename });
      payload = { mode: "upload", docx: { key: ref.key, filename }, metadata: input.metadata };
    }
  }
  await queueFinalise(db, actor, doc, { ...payload, replaces }, notes);
}

/**
 * A name that lands on another document's Final replaces it: only with the person's ok (review M1).
 * -> the id of the Final the person agreed to replace, so the worker replaces that one and no other (R2).
 */
async function guardReplace(db: Db | Tx, doc: Document, name: string, confirmed: boolean): Promise<string | null> {
  if (name === doc.name) return null;
  const [other] = await db
    .select({ id: documents.id, version: documents.version })
    .from(documents)
    .where(and(eq(documents.name, name), eq(documents.status, "Final")));
  if (other && !confirmed) {
    throw new ReplaceConfirmError(
      `with these details the file name becomes ${name}, which replaces Final version ${other.version} of another document. Tick "Replace it" only if that is intended`,
    );
  }
  return other?.id ?? null;
}

async function queueFinalise(db: Db, actor: Actor, doc: Document, payload: FinalisePayload, notes: (typeof feedback.$inferInsert)[]) {
  try {
    await db.transaction(async (tx) => {
      const [job] = await tx
        .insert(jobs)
        .values({ kind: "finalise", documentId: doc.id, entity: doc.entity, payload, createdBy: actor.email })
        .returning({ id: jobs.id });
      if (notes.length) await tx.insert(feedback).values(notes);
      await logAudit(tx, actor, "document.finalise_requested", doc.id, { job: job.id, mode: payload.mode });
    });
  } catch (err) {
    // jobs_one_open_finalise: someone else just sent it (review L3)
    if (isUniqueViolation(err)) throw new CheckError("this document is already being finalised");
    throw err;
  }
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
  replaces: string | null = null,
) {
  const name = finalName(doc, metadata);
  const [current] = await tx
    .select({ id: documents.id, version: documents.version })
    .from(documents)
    .where(and(eq(documents.name, name), eq(documents.status, "Final")))
    .for("update");
  const [{ last }] = await tx
    .select({ last: sql<number | null>`max(${documents.version})` })
    .from(documents)
    .where(eq(documents.name, name));
  // checked again here: another Final may have appeared since the request (review M1)
  if (current && name !== doc.name && current.id !== replaces) {
    throw new ReplaceConfirmError(`the file name ${name} now replaces Final version ${current.version} of another document; confirm it on the check screen`);
  }
  if (current) {
    await tx.update(documents).set({ status: "Superseded" }).where(eq(documents.id, current.id));
    await logAudit(tx, actor, "document.superseded", current.id, { name, version: current.version });
  }
  const version = (Number(last) || 0) + 1;
  const now = new Date();
  const updated = await tx
    .update(documents)
    .set({
      status: "Final",
      name,
      version,
      previousVersionId: current?.id ?? null,
      ...files,
      productName: metadata.productName,
      fileNr: metadata.fileNr,
      batch: metadata.batch,
      approvedBy: actor.email,
      approvedAt: now,
      yellowParts: [],
      previewKey: null, // the DRAFT preview is no longer shown (review L6)
    })
    .where(and(eq(documents.id, doc.id), eq(documents.status, "To check")))
    .returning({ id: documents.id });
  if (!updated.length) throw new CheckError("the document changed while finalising");
  await logAudit(tx, actor, "document.finalised", doc.id, {
    name,
    ...(name !== doc.name ? { renamedFrom: doc.name, replacedOtherDocument: !!current } : {}),
    version,
    superseded: current?.version ?? null,
  });
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

/**
 * A draft the engine left without any yellow: a person still approves it (Willem 17/10). It goes
 * through the worker too, which checks the details are printed in the document (Willem 19/10).
 */
export async function approveDraft(db: Db, actor: Actor, documentId: string, rawMetadata: unknown, confirmReplace = false) {
  const m = metadataInput.safeParse(rawMetadata);
  if (!m.success) throw new CheckError(m.error.issues.map((i) => i.message).join("; "));
  const doc = await loadDraft(db, documentId);
  if (await openFinaliseJob(db, doc.id)) throw new CheckError("this document is being finalised");
  if ((doc.yellowParts ?? []).length) throw new CheckError("this draft has yellow parts: check them first");
  if (!doc.pdfKey || !doc.pdfFilename || !doc.docxKey || !doc.docxFilename) throw new CheckError("this draft has no PDF yet");
  const metadata = lockBatch(doc, m.data);
  const replaces = await guardReplace(db, doc, finalName(doc, metadata), confirmReplace);
  await queueFinalise(db, actor, doc, { mode: "approve", metadata, replaces }, []);
}

export async function rejectDraft(db: Db, actor: Actor, documentId: string, rawReason: unknown) {
  const reason = clean(500).min(3, "give a short reason").safeParse(rawReason);
  if (!reason.success) throw new CheckError(reason.error.issues.map((i) => i.message).join("; "));
  if (!UUID.test(documentId)) throw new CheckError("document not found");
  if (await openFinaliseJob(db, documentId)) throw new CheckError("this document is being finalised");
  await db.transaction(async (tx) => {
    const doc = await loadDraft(tx, documentId);
    await tx.update(documents).set({ status: "Rejected", rejectedReason: reason.data, previewKey: null }).where(eq(documents.id, doc.id));
    await tx.insert(feedback).values({ actor: actor.email, documentId: doc.id, kind: "rejected", reason: reason.data });
    await logAudit(tx, actor, "document.rejected", doc.id, { reason: reason.data });
    await closeNeutraliseJobIfDone(tx, doc.jobId);
  });
}

function isUniqueViolation(err: unknown) {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}
