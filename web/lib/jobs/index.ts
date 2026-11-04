// Neutralise jobs: the app files them, the worker (worker/) runs the engine on them.
// Queue = the jobs table, so moving to Azure changes nothing here (BRIEF 4).
import "server-only";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { assertRequestOpen } from "../api/requests";
import { logAudit, type Actor } from "../audit";
import type { Db } from "../db";
import { documents, ENTITIES, jobs, ROUTES, type Job } from "../db/schema";
import { getEntity } from "../entities";
import { cleanFilename, detectType, MAX_FILE_MB, maxFileBytes, parseUploadKey } from "../files";
import type { Storage } from "../storage";

export class JobError extends Error {}

/** Open (queued + running) jobs one person may have; stops a flood of OCR work. */
export const MAX_OPEN_JOBS_PER_USER = 40;

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "contains control characters")
    // The engine passes these on as separate arguments; a leading "-" would look like an option.
    .refine((s) => !s.startsWith("-"), 'cannot start with "-"')
    .optional()
    .transform((s) => (s ? s : null));

const fileRef = z.object({ key: z.string().max(200), filename: z.string().max(300) });

export const jobInput = z.object({
  route: z.enum(ROUTES),
  entity: z.enum(ENTITIES),
  productName: text(200),
  fileNr: text(50),
  batch: text(100),
  // Mandatory (Willem 27/10): the Final check always refuses this name on the output, and the AI
  // reader only works with it as a block list (security review F4).
  supplierName: text(200).refine((s) => !!s && s.length >= 2, "type the supplier name (internal, never printed)"),
  supplierFile: fileRef,
  commercialFiles: z.array(fileRef).max(5).default([]),
  // A request from TMC Logistics this supplier document answers (API v1); its kind fixes the route.
  apiJobId: z.uuid().optional(),
});

export type JobInput = z.input<typeof jobInput>;

async function checkInput(storage: Storage, ref: { key: string; filename: string }) {
  const parsed = parseUploadKey(ref.key);
  if (!parsed || parsed.kind !== "input") throw new JobError(`${cleanFilename(ref.filename)}: invalid upload reference`);
  const head = await storage.head(ref.key, 8);
  if (!head) throw new JobError(`${cleanFilename(ref.filename)}: uploaded file not found`);
  if (head.size > maxFileBytes("input")) throw new JobError(`${cleanFilename(ref.filename)}: larger than ${MAX_FILE_MB.input} MB`);
  if (!detectType("input", head.bytes)) throw new JobError(`${cleanFilename(ref.filename)}: not a PDF`);
  return { key: ref.key, filename: cleanFilename(ref.filename) };
}

type Prepared = z.output<typeof jobInput>;

/** One job's input checked exactly as the Neutralise form's: values, entity details, stored files. */
async function prepareJob(db: Db, storage: Storage, raw: JobInput): Promise<Prepared> {
  const r = jobInput.safeParse(raw);
  if (!r.success) throw new JobError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const input = r.data;
  // Never invent an entity's address: no record, no job.
  if (!(await getEntity(db, input.entity))) {
    throw new JobError(`no details entered yet for entity ${input.entity}; an admin adds them under Settings > Entities`);
  }
  if (input.commercialFiles.length && !["auto", "coa"].includes(input.route)) {
    throw new JobError("commercial documents (PFI, OC, contract, invoice) only go with a COA");
  }
  return {
    ...input,
    supplierFile: await checkInput(storage, input.supplierFile),
    commercialFiles: await Promise.all(input.commercialFiles.map((f) => checkInput(storage, f))),
  };
}

/** Files one job per supplier document. All-or-nothing: one bad file refuses the batch. */
export async function createJobs(db: Db, storage: Storage, actor: Actor, raws: JobInput[]): Promise<string[]> {
  if (!Array.isArray(raws) || raws.length === 0) throw new JobError("add at least one supplier document");
  if (raws.length > 20) throw new JobError("at most 20 supplier documents at once");
  if ((await countOpenJobs(db, actor.email)) + raws.length > MAX_OPEN_JOBS_PER_USER) {
    throw new JobError(`you already have many documents waiting; wait until fewer than ${MAX_OPEN_JOBS_PER_USER} are open`);
  }

  const prepared: Prepared[] = [];
  for (const raw of raws) prepared.push(await prepareJob(db, storage, raw));

  const ids = await db.transaction(async (tx) => {
    const out: string[] = [];
    for (const p of prepared) {
      if (p.apiJobId) {
        const req = await assertRequestOpen(tx, p.apiJobId, { route: p.route });
        if (req.entity !== p.entity) throw new JobError(`this request is for entity ${req.entity}`);
        // the document TMC Logistics handed over gives one run only: checked under the request's row
        // lock, so a double click or the hand-off racing a person files one (security review M1)
        if (req.supplierFile?.key === p.supplierFile.key) {
          const [used] = await tx
            .select({ id: jobs.id })
            .from(jobs)
            .where(and(eq(jobs.apiJobId, req.id), sql`${jobs.supplierFile}->>'key' = ${p.supplierFile.key}`))
            .limit(1);
          if (used) throw new JobError("this document was already sent to the neutralizer");
        }
      }
      const [row] = await tx
        .insert(jobs)
        .values({ ...p, kind: "neutralise", createdBy: actor.email })
        .returning({ id: jobs.id });
      await logAudit(tx, actor, "job.created", null, { job: row.id, route: p.route, file: p.supplierFile.filename, ...(p.apiJobId ? { apiJob: p.apiJobId } : {}) });
      out.push(row.id);
    }
    return out;
  });
  await wakeWorker();
  return ids;
}

/** Drafts that may be run again: still waiting for a check, or rejected. */
export const RERUN_STATUSES = ["To check", "Rejected"] as const;

/** Whether the "Run again" button belongs on this document (the action checks everything again). */
export async function canRerun(db: Db, doc: { status: string; jobId: string | null }) {
  if (!(RERUN_STATUSES as readonly string[]).includes(doc.status) || !doc.jobId) return false;
  const job = await getJob(db, doc.jobId);
  // a draft that answers a request from TMC Logistics goes through the request (security review H1)
  return !!job && job.kind === "neutralise" && !!job.supplierFile && !job.apiJobId;
}

/**
 * The open "Run again" job that will replace this draft: one for the draft itself or for any draft
 * of the same earlier run, as a run replaces them all (Willem 02/11, review M2). Null when none.
 */
export async function openRerunFor(db: Db | Tx, doc: { id: string; jobId: string | null }) {
  const siblings = doc.jobId ? db.select({ id: documents.id }).from(documents).where(eq(documents.jobId, doc.jobId)) : null;
  const [open] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.kind, "neutralise"),
        inArray(jobs.state, ["queued", "running"]),
        siblings ? or(eq(jobs.rerunOf, doc.id), inArray(jobs.rerunOf, siblings)) : eq(jobs.rerunOf, doc.id),
      ),
    )
    .limit(1);
  return open ?? null;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

const DOCUMENT_ID = z.uuid();

/** Two clicks at once on the same draft: only the partial unique index, nothing else (review L4). */
function isOneOpenRerunViolation(err: unknown) {
  const e = err as { code?: string; constraint?: string; message?: string; cause?: { code?: string; constraint?: string; message?: string } };
  const code = e?.code ?? e?.cause?.code;
  const where = `${e?.constraint ?? ""} ${e?.cause?.constraint ?? ""} ${e?.message ?? ""} ${e?.cause?.message ?? ""}`;
  return code === "23505" && where.includes("jobs_one_open_rerun");
}

/**
 * "Run again with the latest neutralizer" (Willem 02/11): a new job from the draft's own job, same
 * values and the same stored files (no new upload), checked as a new job from the Neutralise form.
 * The draft is replaced (Superseded) only once the new run has made its draft (hard rule 4); a run
 * that fails leaves it as it is. Anyone logged in may run a draft again, as anyone may check one.
 */
export async function rerunJob(db: Db, storage: Storage, actor: Actor, documentId: string): Promise<string> {
  if (!DOCUMENT_ID.safeParse(documentId).success) throw new JobError("document not found");
  const [doc] = await db.select().from(documents).where(eq(documents.id, documentId));
  if (!doc) throw new JobError("document not found");
  if (!(RERUN_STATUSES as readonly string[]).includes(doc.status)) {
    throw new JobError("only a draft that waits for a check, or a rejected one, can be run again");
  }
  const source = doc.jobId ? await getJob(db, doc.jobId) : null;
  if (!source || source.kind !== "neutralise" || !source.supplierFile) {
    throw new JobError("this document was not made from a supplier document, so it cannot be run again");
  }
  if (source.apiJobId) {
    throw new JobError("this draft answers a request from TMC Logistics; send a new supplier document from the request page");
  }
  if (!source.supplierName?.trim()) {
    throw new JobError("this draft was made before the supplier name was required; run it again from Neutralise and type the supplier name");
  }
  const finalising = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.documentId, doc.id), eq(jobs.kind, "finalise"), inArray(jobs.state, ["queued", "running"])));
  if (finalising.length) throw new JobError("this draft is being finalised; wait until that is done");
  if (await openRerunFor(db, doc)) throw new JobError("this draft is already being run again");
  if ((await countOpenJobs(db, actor.email)) + 1 > MAX_OPEN_JOBS_PER_USER) {
    throw new JobError(`you already have many documents waiting; wait until fewer than ${MAX_OPEN_JOBS_PER_USER} are open`);
  }

  const p = await prepareJob(db, storage, {
    route: source.route,
    entity: source.entity,
    productName: source.productName ?? undefined,
    fileNr: source.fileNr ?? undefined,
    batch: source.batch ?? undefined,
    supplierName: source.supplierName,
    supplierFile: source.supplierFile,
    commercialFiles: source.commercialFiles,
  });
  let id: string;
  try {
    id = await db.transaction(async (tx) => {
      // clicks on two drafts of the same earlier run at once: one lock per earlier run, then the
      // check again (the unique index covers the same draft only)
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`rerun:${source.id}`}))`);
      if (await openRerunFor(tx, doc)) throw new JobError("this draft is already being run again");
      const [row] = await tx
        .insert(jobs)
        .values({ ...p, kind: "neutralise", rerunOf: doc.id, createdBy: actor.email })
        .returning({ id: jobs.id });
      await logAudit(tx, actor, "document.rerun", doc.id, { job: row.id, from: source.id, file: p.supplierFile.filename });
      return row.id;
    });
  } catch (err) {
    // two clicks at once on the same draft: the unique index lets one through
    if (isOneOpenRerunViolation(err)) throw new JobError("this draft is already being run again");
    throw err;
  }
  await wakeWorker();
  return id;
}

/**
 * Tells the worker there is work. Best effort: if the worker is asleep or unreachable it
 * still finds the job on its next safety check (every 30 min). Never blocks the user.
 */
export async function wakeWorker() {
  const url = process.env.WORKER_WAKE_URL;
  const secret = process.env.WORKER_WAKE_SECRET;
  if (!url || !secret) return;
  // The secret only travels over https (plain http allowed on a laptop), and never follows a redirect.
  if (!url.startsWith("https://") && process.env.NODE_ENV === "production") return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      redirect: "manual",
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // ignored on purpose
  }
}

/** Newest first. `fileNr`: only the neutralise jobs of that dossier (dossier overview); `apiJobId`:
 * only the jobs of one API request (API v1). */
export async function listJobs(db: Db, limit = 100, filter: { fileNr?: string; apiJobId?: string } = {}) {
  const rows = await db
    .select()
    .from(jobs)
    .where(
      and(
        filter.fileNr === undefined ? undefined : and(eq(jobs.kind, "neutralise"), eq(jobs.fileNr, filter.fileNr)),
        filter.apiJobId ? eq(jobs.apiJobId, filter.apiJobId) : undefined,
      ),
    )
    .orderBy(desc(jobs.createdAt))
    .limit(limit);
  const results = rows.length
    ? await db
        .select({ id: documents.id, jobId: documents.jobId, name: documents.name, status: documents.status })
        .from(documents)
        .where(
          inArray(
            documents.jobId,
            rows.map((r) => r.id),
          ),
        )
    : [];
  return rows.map((job) => ({ job, documents: results.filter((d) => d.jobId === job.id) }));
}

export async function getJob(db: Db, id: string): Promise<Job | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  return row ?? null;
}

export async function countOpenJobs(db: Db, createdBy?: string) {
  const open = inArray(jobs.state, ["queued", "running"]);
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(createdBy ? and(open, eq(jobs.createdBy, createdBy)) : open);
  return n;
}
