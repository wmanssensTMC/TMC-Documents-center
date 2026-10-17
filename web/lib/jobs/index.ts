// Neutralise jobs: the app files them, the worker (worker/) runs the engine on them.
// Queue = the jobs table, so moving to Azure changes nothing here (BRIEF 4).
import "server-only";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { logAudit, type Actor } from "../audit";
import type { Db } from "../db";
import { documents, ENTITIES, jobs, ROUTES, type Job } from "../db/schema";
import { getEntity } from "../entities";
import { cleanFilename, detectType, MAX_FILE_BYTES, parseUploadKey } from "../files";
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
  supplierName: text(200),
  supplierFile: fileRef,
  commercialFiles: z.array(fileRef).max(5).default([]),
});

export type JobInput = z.input<typeof jobInput>;

async function checkInput(storage: Storage, ref: { key: string; filename: string }) {
  const parsed = parseUploadKey(ref.key);
  if (!parsed || parsed.kind !== "input") throw new JobError(`${cleanFilename(ref.filename)}: invalid upload reference`);
  const head = await storage.head(ref.key, 8);
  if (!head) throw new JobError(`${cleanFilename(ref.filename)}: uploaded file not found`);
  if (head.size > MAX_FILE_BYTES) throw new JobError(`${cleanFilename(ref.filename)}: larger than 25 MB`);
  if (!detectType("input", head.bytes)) throw new JobError(`${cleanFilename(ref.filename)}: not a PDF`);
  return { key: ref.key, filename: cleanFilename(ref.filename) };
}

/** Files one job per supplier document. All-or-nothing: one bad file refuses the batch. */
export async function createJobs(db: Db, storage: Storage, actor: Actor, raws: JobInput[]): Promise<string[]> {
  if (!Array.isArray(raws) || raws.length === 0) throw new JobError("add at least one supplier document");
  if (raws.length > 20) throw new JobError("at most 20 supplier documents at once");
  if ((await countOpenJobs(db, actor.email)) + raws.length > MAX_OPEN_JOBS_PER_USER) {
    throw new JobError(`you already have many documents waiting; wait until fewer than ${MAX_OPEN_JOBS_PER_USER} are open`);
  }

  type Prepared = z.output<typeof jobInput>;
  const prepared: Prepared[] = [];
  for (const raw of raws) {
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
    prepared.push({
      ...input,
      supplierFile: await checkInput(storage, input.supplierFile),
      commercialFiles: await Promise.all(input.commercialFiles.map((f) => checkInput(storage, f))),
    });
  }

  const ids = await db.transaction(async (tx) => {
    const out: string[] = [];
    for (const p of prepared) {
      const [row] = await tx
        .insert(jobs)
        .values({ ...p, kind: "neutralise", createdBy: actor.email })
        .returning({ id: jobs.id });
      await logAudit(tx, actor, "job.created", null, { job: row.id, route: p.route, file: p.supplierFile.filename });
      out.push(row.id);
    }
    return out;
  });
  await wakeWorker();
  return ids;
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

export async function listJobs(db: Db, limit = 100) {
  const rows = await db.select().from(jobs).orderBy(desc(jobs.createdAt)).limit(limit);
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
