// Job state changes made by the worker. The worker never writes job or document rows any
// other way, so the rules stay in one place.
import "server-only";
import { and, eq, lt, sql } from "drizzle-orm";
import { logAudit } from "../audit";
import type { Db } from "../db";
import { documents, jobs, type DocType, type Entity, type Job, type YellowPart } from "../db/schema";
import { CheckError, makeFinal } from "../documents/check";

/** A job left "running" this long is treated as crashed. */
export const STALE_MINUTES = 30;
export const MAX_ATTEMPTS = 3;

/**
 * Takes the oldest queued job and marks it running, in one statement. FOR UPDATE SKIP LOCKED:
 * two workers can never take the same job.
 */
export async function claimNextJob(db: Db): Promise<Job | null> {
  const rows = await db.execute(sql`
    update jobs set state = 'running', started_at = now(), finished_at = null, attempts = attempts + 1
    where id = (
      select id from jobs where state = 'queued' order by created_at for update skip locked limit 1
    )
    returning id`);
  const id = (rows as unknown as { rows?: { id: string }[] }).rows?.[0]?.id ?? (rows as unknown as { id: string }[])[0]?.id;
  if (!id) return null;
  const [job] = await db.select().from(jobs).where(eq(jobs.id, id));
  return job ?? null;
}

/** Jobs stuck in "running" (worker crashed): back in the queue, or failed after 3 tries. */
export async function requeueStaleJobs(db: Db) {
  const stale = and(eq(jobs.state, "running"), lt(jobs.startedAt, sql`now() - make_interval(mins => ${STALE_MINUTES})`));
  await db
    .update(jobs)
    .set({ state: sql`case when ${jobs.attempts} >= ${MAX_ATTEMPTS} then 'failed'::job_state else 'queued'::job_state end`, log: sql`coalesce(${jobs.log}, '') || ${"\n[worker] run did not finish; "}` })
    .where(stale);
}

/** Only the run that holds the job may close it (review W4): still running, same attempt. */
function stillMine(job: Job) {
  return and(eq(jobs.id, job.id), eq(jobs.state, "running"), eq(jobs.attempts, job.attempts));
}

export async function failJob(db: Db, job: Job, exitCode: number | null, log: string) {
  await db.update(jobs).set({ state: "failed", exitCode, log, finishedAt: new Date() }).where(stillMine(job));
}

export type Draft = {
  name: string;
  type: DocType;
  entity: Entity;
  docxKey: string;
  docxFilename: string;
  pdfKey: string | null; // only when the engine left nothing yellow
  pdfFilename: string | null;
  sourceKey: string;
  sourceFilename: string;
  yellow: boolean;
  yellowParts: YellowPart[];
  previewKey: string | null;
  /** The batch the engine made this document for (one document per batch). */
  batch?: string | null;
};

/**
 * Stores the engine's drafts as "To check" documents and closes the job. Engine output always
 * waits for a person (Willem 17/10): nothing becomes Final here.
 */
export async function saveDrafts(db: Db, job: Job, drafts: Draft[], exitCode: number, log: string) {
  await db.transaction(async (tx) => {
    const closed = await tx
      .update(jobs)
      .set({ state: "to_check", exitCode, log, finishedAt: new Date() })
      .where(stillMine(job))
      .returning({ id: jobs.id });
    if (!closed.length) throw new Error("job is no longer held by this run; drafts not saved");
    for (const d of drafts) {
      const [row] = await tx
        .insert(documents)
        .values({
          name: d.name,
          type: d.type,
          entity: d.entity,
          productName: job.productName,
          fileNr: job.fileNr,
          batch: d.batch ?? job.batch,
          supplierName: job.supplierName,
          status: "To check",
          version: null,
          pdfKey: d.pdfKey,
          pdfFilename: d.pdfFilename,
          docxKey: d.docxKey,
          docxFilename: d.docxFilename,
          sourceKey: d.sourceKey,
          sourceFilename: d.sourceFilename,
          yellowParts: d.yellowParts,
          previewKey: d.previewKey,
          createdBy: job.createdBy,
          jobId: job.id,
        })
        .returning({ id: documents.id });
      await logAudit(tx, { email: job.createdBy }, "document.drafted", row.id, {
        job: job.id,
        by: "neutralizer",
        name: d.name,
        yellow: d.yellow,
        yellowParts: d.yellowParts.length,
      });
    }
  });
}

/** A finalise job succeeded: the checked draft becomes Final (see documents/check.ts). */
export async function saveFinal(
  db: Db,
  job: Job,
  files: { pdfKey: string; pdfFilename: string; docxKey: string; docxFilename: string },
  log: string,
) {
  if (!job.documentId || !job.payload) throw new Error("finalise job without document");
  const documentId = job.documentId;
  const metadata = job.payload.metadata;
  await db.transaction(async (tx) => {
    const closed = await tx
      .update(jobs)
      .set({ state: "done", exitCode: 0, log, finishedAt: new Date() })
      .where(stillMine(job))
      .returning({ id: jobs.id });
    if (!closed.length) throw new Error("job is no longer held by this run");
    const [doc] = await tx.select().from(documents).where(eq(documents.id, documentId));
    if (!doc) throw new CheckError("document not found");
    // The person who confirmed the yellow parts is the approver (anyone may, Willem 17/10).
    await makeFinal(tx, { email: job.createdBy }, doc, files, metadata, job.payload?.replaces ?? null);
  });
}
