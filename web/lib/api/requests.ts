// Requests from calling apps (API v1, contract sections 5 to 9 and 12). One request = one part
// (order no + part no) and one kind. A person in the Document Center adds the supplier document(s)
// or makes the label; those engine runs point to the request (jobs.api_job_id). The request's
// state is worked out from those runs and their documents each time it is read, never stored.
// What goes back: states, fixed texts and document references. Never a supplier name, a source
// file, a download address, a yellow text or an engine log.
import "server-only";
import { and, desc, eq, inArray, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { z } from "zod";
import { logAudit } from "../audit";
import { API_JOB_KINDS, API_KIND_ROUTE, type ApiJobKind, type ApiJobState, type DocStatus, type Route } from "../constants";
import type { Db } from "../db";
import { apiJobs, auditLog, documents, jobs, type ApiJob } from "../db/schema";
import { getEntity } from "../entities";
import { ApiError } from "./errors";
import type { ApiCaller } from "./keys";
import { sha256 } from "./keys";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Limits of contract section 11. */
export const MAX_CREATES_PER_MINUTE = 30;
export const MAX_OPEN_REQUESTS = 300;
export const MAX_IDS = 100;

export const NOT_NEEDED = "Not needed in TMC Logistics";
// The only problem texts that ever go out (contract section 7).
export const PROBLEM = {
  supplierDocument: "Supplier document needed",
  supplierName: "Supplier name needed",
  label: "Label to be made in Document Center",
  engine: "Engine could not read the document",
} as const;

export const API_REASONS = ["neutral-bc", "neutral-customer", "neutral-country", "originals-by-courier", "coo-draft-to-do", "asked-by-person"] as const;

// Same rule as the app's own forms: no control or invisible characters, no leading "-".
const UNSAFE = /[\u0000-\u001f\u007f\p{Zl}\p{Zp}\p{Cf}]/u;
const text = (max: number) =>
  z
    .string()
    .max(max)
    .refine((s) => !UNSAFE.test(s), "contains control characters")
    .refine((s) => !s.trimStart().startsWith("-"), 'cannot start with "-"');

export const transmareEmail = z
  .email()
  .max(254)
  .refine((s) => s.toLowerCase().endsWith("@transmare.com"), "must be a @transmare.com address");

const line = z.strictObject({
  lineNo: z.int().positive().max(2_147_483_647),
  itemNo: text(50).nullable(),
  description: text(250).nullable(),
});

export const createBody = z.strictObject({
  kind: z.enum(API_JOB_KINDS),
  entity: z.literal("TMC"), // only TMC NV for now (Willem 27/10); the others when agreed
  source: z.strictObject({
    app: z.literal("tmc-logistics"),
    requestId: z.uuid(),
    orderNo: text(40).refine((s) => s.trim().length > 0, "required"),
    partNo: z.int().min(1).max(9999),
    requestedBy: transmareEmail,
    reason: z.enum(API_REASONS),
  }),
  facts: z.strictObject({
    lines: z
      .array(line)
      .min(1)
      .max(500)
      .refine((ls) => new Set(ls.map((l) => l.lineNo)).size === ls.length, "line numbers must be unique"),
    // v1.1 (contract 15.2): the BC vendor name, neutralise kinds only (a label never takes it, BRIEF 7.3)
    supplierName: text(200)
      .transform((s) => s.trim())
      .refine((s) => s.length >= 2, "at least 2 characters")
      .optional(),
  }),
});

export const cancelBody = z.strictObject({ requestedBy: transmareEmail });

/** Zod issues as contract errors: an unknown key is `unknown_field`, never ignored. Paths only. */
export function payloadError(error: z.ZodError, prefix: string[] = []): ApiError {
  const unknown = error.issues.filter((i) => i.code === "unrecognized_keys");
  if (unknown.length) {
    return new ApiError(
      "unknown_field",
      unknown.flatMap((i) => (i as { keys: string[] }).keys.map((k) => [...prefix, ...i.path, k].join("."))),
    );
  }
  return new ApiError("invalid_payload", [...new Set(error.issues.map((i) => [...prefix, ...i.path].join(".")))]);
}

/** JSON with sorted keys, so the same body always gives the same hash. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v);
}

// ---------- state rollup (contract section 7, edge cases Willem 27/10) ----------

type Child = { id: string; apiJobId: string | null; state: string; createdAt: Date; startedAt: Date | null; finishedAt: Date | null };
type Result = { id: string; jobId: string | null; status: DocStatus; createdAt: Date; approvedAt: Date | null; version: number | null };

/** A Final, or a former Final: a Superseded with a version. A draft replaced by "Run again" is
 * Superseded without a version and never counts (security review H1, 02/11/2026). */
export const wasFinal = (d: { status: DocStatus; version: number | null }) => d.status === "Final" || (d.status === "Superseded" && d.version !== null);
export type Rollup = { state: ApiJobState; problem: string | null; resultCount: number; changedAt: Date };

/**
 * cancelled > a run queued or running (in-progress) > a draft waiting for a check (to-check) >
 * at least one Final (ready; a Final later superseded still counts, a replaced draft never) > the latest run failed
 * (failed) > nothing usable yet, also when every draft was rejected (waiting-input). A supplier
 * document handed over through the API with no supplier name known yet: "Supplier name needed".
 */
export function rollup(
  req: Pick<ApiJob, "kind" | "createdAt" | "cancelledAt"> & Partial<Pick<ApiJob, "supplierFile" | "supplierName">>,
  children: Child[],
  results: Result[],
  lastAudit?: Date | null,
): Rollup {
  const times = [req.createdAt, req.cancelledAt, lastAudit, ...children.flatMap((c) => [c.createdAt, c.startedAt, c.finishedAt]), ...results.flatMap((d) => [d.createdAt, d.approvedAt])];
  const changedAt = new Date(Math.max(...times.filter((t): t is Date => !!t).map((t) => t.getTime())));
  const base = { resultCount: results.length, changedAt };
  if (req.cancelledAt) return { ...base, state: "cancelled", problem: null };
  if (children.some((c) => c.state === "queued" || c.state === "running")) return { ...base, state: "in-progress", problem: null };
  if (results.some((d) => d.status === "To check" || d.status === "Draft")) return { ...base, state: "to-check", problem: null };
  if (results.some(wasFinal)) return { ...base, state: "ready", problem: null };
  const latest = [...children].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  if (latest?.state === "failed") return { ...base, state: "failed", problem: PROBLEM.engine };
  if (req.kind === "label") return { ...base, state: "waiting-input", problem: PROBLEM.label };
  // handed over and not run yet: waits for the supplier name, or (name known) for a person to start it
  if (req.supplierFile && children.length === 0) return { ...base, state: "waiting-input", problem: req.supplierName ? null : PROBLEM.supplierName };
  return { ...base, state: "waiting-input", problem: PROBLEM.supplierDocument };
}

async function childrenAndResults(db: Db | Tx, apiJobIds: string[]) {
  if (!apiJobIds.length) return { children: [] as Child[], results: [] as (Result & { type: string; name: string; version: number | null; batch: string | null; pdfKey: string | null })[], audit: new Map<string, Date>() };
  const children = await db
    .select({ id: jobs.id, apiJobId: jobs.apiJobId, state: jobs.state, createdAt: jobs.createdAt, startedAt: jobs.startedAt, finishedAt: jobs.finishedAt })
    .from(jobs)
    .where(inArray(jobs.apiJobId, apiJobIds));
  const results = children.length
    ? await db
        .select({
          id: documents.id,
          jobId: documents.jobId,
          status: documents.status,
          createdAt: documents.createdAt,
          approvedAt: documents.approvedAt,
          type: documents.type,
          name: documents.name,
          version: documents.version,
          batch: documents.batch,
          pdfKey: documents.pdfKey, // internal: only the v1.1 Final file reads it, never answered
        })
        .from(documents)
        .where(
          inArray(
            documents.jobId,
            children.map((c) => c.id),
          ),
        )
        .orderBy(documents.createdAt)
    : [];
  // the last thing that happened to a result document (rejected, finalised ...)
  const audit = new Map<string, Date>();
  if (results.length) {
    const rows = await db
      .select({ documentId: auditLog.documentId, at: sql<Date>`max(${auditLog.at})` })
      .from(auditLog)
      .where(
        inArray(
          auditLog.documentId,
          results.map((d) => d.id),
        ),
      )
      .groupBy(auditLog.documentId);
    for (const r of rows) if (r.documentId) audit.set(r.documentId, new Date(r.at));
  }
  return { children, results, audit };
}

export async function rollupMany(db: Db | Tx, reqs: ApiJob[]) {
  const { children, results, audit } = await childrenAndResults(
    db,
    reqs.map((r) => r.id),
  );
  return new Map(
    reqs.map((r) => {
      const mine = children.filter((c) => c.apiJobId === r.id);
      const ids = new Set(mine.map((c) => c.id));
      const docs = results.filter((d) => d.jobId && ids.has(d.jobId));
      const last = docs.map((d) => audit.get(d.id)).filter((t): t is Date => !!t);
      const lastAudit = last.length ? new Date(Math.max(...last.map((t) => t.getTime()))) : null;
      return [r.id, { ...rollup(r, mine, docs, lastAudit), documents: docs }];
    }),
  );
}

// ---------- what goes out ----------

function appUrl() {
  const url = process.env.APP_URL?.replace(/\/+$/, "") ?? "";
  if (!/^https:\/\/[^/?#\s]+$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) throw new ApiError("unavailable");
  return url;
}

export function jobView(r: ApiJob, s: Rollup) {
  return {
    jobId: r.id,
    kind: r.kind,
    state: s.state,
    problem: s.problem,
    source: { requestId: r.requestId, orderNo: r.orderNo, partNo: r.partNo },
    createdAt: r.createdAt.toISOString(),
    changedAt: s.changedAt.toISOString(),
    resultCount: s.resultCount,
    link: `${appUrl()}/api-jobs/${r.id}`,
  };
}

export type JobView = ReturnType<typeof jobView>;

const UUID = z.uuid();

export async function ownRequest(db: Db | Tx, caller: ApiCaller, id: string): Promise<ApiJob> {
  if (!UUID.safeParse(id).success) throw new ApiError("not_found");
  const [row] = await db
    .select()
    .from(apiJobs)
    .where(and(eq(apiJobs.id, id), eq(apiJobs.client, caller.client)));
  if (!row) throw new ApiError("not_found"); // another client's job looks the same as no job
  return row;
}

// ---------- endpoints ----------

/** POST /jobs. Same key + same body = the existing job (`created: false`). */
export async function createRequest(db: Db, caller: ApiCaller, idempotencyKey: string | null, raw: unknown): Promise<{ job: JobView; created: boolean }> {
  if (!idempotencyKey) throw new ApiError("missing_idempotency_key");
  if (!UUID.safeParse(idempotencyKey).success) throw new ApiError("invalid_payload", ["Idempotency-Key"]);
  const parsed = createBody.safeParse(raw);
  if (!parsed.success) throw payloadError(parsed.error);
  const body = parsed.data;
  const key = idempotencyKey.toLowerCase();
  if (body.source.requestId.toLowerCase() !== key) throw new ApiError("invalid_payload", ["source.requestId"]);
  // a label never takes a supplier name from outside (BRIEF 7.3): for that kind the field does not exist
  if (body.kind === "label" && body.facts.supplierName !== undefined) throw new ApiError("unknown_field", ["facts.supplierName"]);
  const bodyHash = sha256(canonicalJson(raw));

  const existing = async () => {
    const [row] = await db
      .select()
      .from(apiJobs)
      .where(and(eq(apiJobs.client, caller.client), eq(apiJobs.idempotencyKey, key)));
    return row;
  };
  const answer = async (row: ApiJob) => {
    if (row.bodyHash !== bodyHash) throw new ApiError("idempotency_conflict");
    return { job: jobView(row, (await rollupMany(db, [row])).get(row.id)!), created: false };
  };
  const before = await existing();
  if (before) return answer(before);

  if (!caller.allowedKinds.includes(body.kind)) throw new ApiError("kind_not_allowed", ["kind"]);
  if (!(await getEntity(db, body.entity))) throw new ApiError("entity_not_set_up", ["entity"]);
  const requestedBy = body.source.requestedBy.toLowerCase();
  const createdBy = `${caller.client}:${requestedBy}`;
  const row = await db.transaction(async (tx) => {
    // counted and inserted under one lock per client, so creates sent at once cannot pass the limits together (S4)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`api_jobs:${caller.client}`}))`);
    const [{ recent }] = await tx
      .select({ recent: sql<number>`count(*)::int` })
      .from(apiJobs)
      .where(and(eq(apiJobs.client, caller.client), sql`${apiJobs.createdAt} > now() - interval '1 minute'`));
    if (recent >= MAX_CREATES_PER_MINUTE) throw new ApiError("rate_limited", [], 60);
    if ((await countOpenRequests(tx, caller.client)) >= MAX_OPEN_REQUESTS) throw new ApiError("rate_limited", [], 300);
    const [inserted] = await tx
      .insert(apiJobs)
      .values({
        client: caller.client,
        idempotencyKey: key,
        bodyHash,
        kind: body.kind,
        entity: body.entity,
        requestId: key,
        orderNo: body.source.orderNo,
        partNo: body.source.partNo,
        requestedBy,
        reason: body.source.reason,
        lines: body.facts.lines,
        supplierName: body.facts.supplierName ?? null,
        createdBy,
      })
      .onConflictDoNothing()
      .returning();
    if (!inserted) return null; // the same key arrived twice at once: the other one made it
    await logAudit(tx, { email: createdBy }, "api.job.created", null, {
      apiJob: inserted.id,
      client: caller.client,
      requestedBy,
      kind: body.kind,
      requestId: key,
    });
    return inserted;
  });
  if (!row) return answer((await existing())!);
  return { job: jobView(row, (await rollupMany(db, [row])).get(row.id)!), created: true };
}

/**
 * Open = not ready, failed or cancelled (contract 11). Not cancelled and no Final yet is a cheap
 * first count; only when that reaches the limit are the failed ones worked out and left out.
 */
export async function countOpenRequests(db: Db | Tx, client: string) {
  const finals = db
    .select({ one: sql`1` })
    .from(jobs)
    .innerJoin(documents, eq(documents.jobId, jobs.id))
    .where(
      and(
        eq(jobs.apiJobId, apiJobs.id),
        or(eq(documents.status, "Final"), and(eq(documents.status, "Superseded"), isNotNull(documents.version))),
      ),
    );
  const candidates = await db
    .select()
    .from(apiJobs)
    .where(and(eq(apiJobs.client, client), isNull(apiJobs.cancelledAt), notExists(finals)));
  if (candidates.length < MAX_OPEN_REQUESTS) return candidates.length;
  const states = await rollupMany(db, candidates);
  return candidates.filter((r) => states.get(r.id)!.state !== "failed").length;
}

/** GET /jobs/{id} */
export async function getRequest(db: Db, caller: ApiCaller, id: string): Promise<JobView> {
  const row = await ownRequest(db, caller, id);
  return jobView(row, (await rollupMany(db, [row])).get(row.id)!);
}

/** GET /jobs?ids=a,b: unknown (or another client's) ids are left out, never an error. */
export async function getRequests(db: Db, caller: ApiCaller, idsParam: string | null): Promise<JobView[]> {
  const ids = [...new Set((idsParam ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (!ids.length || ids.length > MAX_IDS || ids.some((id) => !UUID.safeParse(id).success)) throw new ApiError("invalid_payload", ["ids"]);
  const rows = await db
    .select()
    .from(apiJobs)
    .where(and(eq(apiJobs.client, caller.client), inArray(apiJobs.id, ids)));
  const states = await rollupMany(db, rows);
  return rows.map((r) => jobView(r, states.get(r.id)!));
}

/** At most this many results per job (contract amendment f40cabf): Finals first, then the newest. */
export const MAX_RESULTS = 100;

/** GET /jobs/{id}/results: references only (contract 4.2). */
export async function requestResults(db: Db, caller: ApiCaller, id: string) {
  const row = await ownRequest(db, caller, id);
  const { documents: all } = (await rollupMany(db, [row])).get(row.id)!;
  const docs = [...all]
    .sort((a, b) => Number(wasFinal(b)) - Number(wasFinal(a)) || b.createdAt.getTime() - a.createdAt.getTime())
    .slice(0, MAX_RESULTS);
  const base = appUrl();
  return docs.map((d) => ({
    documentId: d.id,
    type: d.type,
    // Only a Final's name was made from details a person checked; a draft's name can still hold
    // the supplier file's name or trade name (security review S1), so it never leaves.
    name: wasFinal(d) ? d.name : null,
    status: d.status,
    version: d.version,
    batch: d.batch,
    finalAt: d.approvedAt && wasFinal(d) ? d.approvedAt.toISOString() : null,
    link: `${base}/documents/${d.id}`,
  }));
}

/**
 * POST /jobs/{id}/cancel (contract section 9), idempotent. Queued runs stop; drafts waiting for a
 * check become Rejected "Not needed in TMC Logistics" (never deleted); a run that is busy finishes
 * and its drafts are saved as Rejected (lib/jobs/worker-state.ts); a Final stays Final. A draft a
 * person is finalising right now is left alone: it may still become Final.
 */
export async function cancelRequest(db: Db, caller: ApiCaller, id: string, raw: unknown): Promise<JobView> {
  const parsed = cancelBody.safeParse(raw);
  if (!parsed.success) throw payloadError(parsed.error);
  const requestedBy = parsed.data.requestedBy.toLowerCase();
  const actor = { email: `${caller.client}:${requestedBy}` };
  const row = await ownRequest(db, caller, id);
  await db.transaction(async (tx) => {
    const [locked] = await tx.select().from(apiJobs).where(eq(apiJobs.id, row.id)).for("update");
    if (locked.cancelledAt) return; // already cancelled: same answer, nothing new
    await tx.update(apiJobs).set({ cancelledAt: new Date(), cancelledBy: actor.email }).where(eq(apiJobs.id, row.id));
    const stopped = await tx
      .update(jobs)
      .set({ state: "cancelled", finishedAt: new Date(), log: sql`coalesce(${jobs.log}, '') || ${`\n[api] ${NOT_NEEDED}`}` })
      .where(and(eq(jobs.apiJobId, row.id), eq(jobs.state, "queued")))
      .returning({ id: jobs.id });
    const children = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.apiJobId, row.id));
    const rejected = children.length ? await rejectWaitingDrafts(tx, actor, children.map((c) => c.id)) : [];
    await logAudit(tx, actor, "api.job.cancelled", null, {
      apiJob: row.id,
      client: caller.client,
      requestedBy,
      kind: row.kind,
      requestId: row.requestId,
      stoppedRuns: stopped.length,
      rejectedDrafts: rejected.length,
    });
  });
  return getRequest(db, caller, id);
}

async function rejectWaitingDrafts(tx: Tx, actor: { email: string }, jobIds: string[]) {
  const finalising = tx
    .select({ one: sql`1` })
    .from(jobs)
    .where(and(eq(jobs.documentId, documents.id), eq(jobs.kind, "finalise"), inArray(jobs.state, ["queued", "running"])));
  const rejected = await tx
    .update(documents)
    .set({ status: "Rejected", rejectedReason: NOT_NEEDED, previewKey: null, viewKey: null })
    .where(and(inArray(documents.jobId, jobIds), inArray(documents.status, ["To check", "Draft"]), notExists(finalising)))
    .returning({ id: documents.id, jobId: documents.jobId });
  for (const d of rejected) await logAudit(tx, actor, "document.rejected", d.id, { reason: NOT_NEEDED });
  // a run with no draft left to check is done (same rule as a rejection at the check)
  const open = tx
    .select({ one: sql`1` })
    .from(documents)
    .where(and(eq(documents.jobId, jobs.id), eq(documents.status, "To check")));
  await tx
    .update(jobs)
    .set({ state: "done" })
    .where(and(inArray(jobs.id, jobIds), eq(jobs.state, "to_check"), notExists(open)));
  return rejected;
}

// ---------- the app's own pages ----------

/**
 * A person adds a supplier document or a label to a request: the request must exist, not be
 * cancelled, and be of the matching kind. Run inside the transaction that files the job; the row
 * lock keeps a cancel from slipping in between.
 */
export async function assertRequestOpen(tx: Tx, apiJobId: string, what: { route: Route } | { label: true }): Promise<ApiJob> {
  if (!UUID.safeParse(apiJobId).success) throw new RequestError("request not found");
  const [req] = await tx.select().from(apiJobs).where(eq(apiJobs.id, apiJobId)).for("update");
  if (!req) throw new RequestError("request not found");
  if (req.cancelledAt) throw new RequestError("this request was cancelled in TMC Logistics");
  const want: ApiJobKind | null = "label" in what ? "label" : (Object.entries(API_KIND_ROUTE).find(([, r]) => r === what.route)?.[0] as ApiJobKind | undefined) ?? null;
  if (want !== req.kind) throw new RequestError(`this request is for ${KIND_LABEL[req.kind]}`);
  return req;
}

export class RequestError extends Error {}

export const KIND_LABEL: Record<ApiJobKind, string> = {
  "coa-neutralise": "a COA",
  "sds-neutralise": "an MSDS / SDS",
  "tds-neutralise": "a TDS",
  label: "a label",
};

export type RequestRow = ApiJob & Rollup & { documents: { id: string; name: string; status: DocStatus; type: string }[] };

/** For the Requests pages: newest first, with state and result documents. */
export async function listRequests(db: Db, opts: { limit?: number; openOnly?: boolean } = {}): Promise<RequestRow[]> {
  const rows = await db
    .select()
    .from(apiJobs)
    .where(opts.openOnly ? isNull(apiJobs.cancelledAt) : undefined)
    .orderBy(desc(apiJobs.createdAt))
    .limit(opts.limit ?? 100);
  const states = await rollupMany(db, rows);
  const out = rows.map((r) => ({ ...r, ...states.get(r.id)! }));
  return opts.openOnly ? out.filter((r) => r.state === "waiting-input" || r.state === "failed" || r.state === "to-check" || r.state === "in-progress") : out;
}

export async function getRequestForPage(db: Db, id: string): Promise<RequestRow | null> {
  if (!UUID.safeParse(id).success) return null;
  const [row] = await db.select().from(apiJobs).where(eq(apiJobs.id, id));
  if (!row) return null;
  return { ...row, ...(await rollupMany(db, [row])).get(row.id)! };
}
