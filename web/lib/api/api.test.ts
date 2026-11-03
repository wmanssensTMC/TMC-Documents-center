import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../audit";
import { createPgliteDb, type Db } from "../db";
import { apiClients, apiJobs, auditLog, documents, jobs } from "../db/schema";
import { newUploadKey } from "../files";
import { createJobs, type JobInput } from "../jobs";
import { claimNextJob, requeueStaleJobs, saveDrafts, saveFinal, type Draft } from "../jobs/worker-state";
import { saveEntity } from "../entities";
import { createLabelJob } from "../labels";
import type { Storage } from "../storage";
import { ApiError } from "./errors";
import { authenticate, createApiKey, deactivateApiKey, MAX_ACTIVE_KEYS, type ApiCaller } from "./keys";
import {
  assertRequestOpen,
  cancelRequest,
  createRequest,
  getRequest,
  getRequests,
  MAX_CREATES_PER_MINUTE,
  NOT_NEEDED,
  PROBLEM,
  requestResults,
  RequestError,
  rollup,
  wasFinal,
} from "./requests";

const admin: Actor = { email: "wilman@transmare.com", name: "Willem", role: "admin" };
const person: Actor = { email: "sigber@transmare.com", name: "Sigi", role: "user" };
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const SUPPLIER = "Example Supplier BV";

let db: Db;
let files: Map<string, Uint8Array>;
const storage: Storage = {
  mode: "local",
  put: async () => {},
  get: async () => null,
  head: async (key) => (files.has(key) ? { bytes: files.get(key)!, size: files.get(key)!.length } : null),
};
const tmclog: ApiCaller = { client: "tmclog", keyId: randomUUID(), allowedKinds: ["coa-neutralise", "sds-neutralise", "tds-neutralise", "label"] };
const other: ApiCaller = { client: "other", keyId: randomUUID(), allowedKinds: ["coa-neutralise"] };

function body(requestId = randomUUID(), over: Record<string, unknown> = {}) {
  return {
    kind: "coa-neutralise",
    entity: "TMC",
    source: { app: "tmc-logistics", requestId, orderNo: "901.S0001", partNo: 2, requestedBy: "stivdb@transmare.com", reason: "neutral-customer" },
    facts: { lines: [{ lineNo: 10000, itemNo: "IT-1", description: "Betaine AI test" }] },
    ...over,
  };
}

async function create(b = body(), caller = tmclog) {
  return createRequest(db, caller, b.source.requestId, b);
}

async function apiError(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof ApiError) return err;
    throw err;
  }
  throw new Error("expected an ApiError");
}

function supplierDoc(apiJobId: string, over: Partial<JobInput> = {}): JobInput {
  const key = newUploadKey("input");
  files.set(key, PDF);
  return { route: "coa", entity: "TMC", fileNr: "901.S0001", productName: "Betaine AI test", supplierName: SUPPLIER, supplierFile: { key, filename: "coa.pdf" }, apiJobId, ...over };
}

const draft = (name: string): Draft => ({
  name,
  type: "COA",
  entity: "TMC",
  docxKey: newUploadKey("docx"),
  docxFilename: `${name}.docx`,
  pdfKey: null,
  pdfFilename: null,
  sourceKey: newUploadKey("input"),
  sourceFilename: "coa.pdf",
  yellow: true,
  yellowParts: [{ id: "y1", text: "x", context: "x" }],
  previewKey: newUploadKey("preview"),
  batch: "BT-3877",
});

/** A person adds a supplier document and the worker makes one draft from it. */
async function draftFor(apiJobId: string, name = "TMC_COA_901.S0001_Betaine_AI_test_BT-3877") {
  await createJobs(db, storage, person, [supplierDoc(apiJobId)]);
  const job = (await claimNextJob(db))!;
  await saveDrafts(db, job, [draft(name)], 0, "ok");
  const [doc] = await db.select().from(documents).where(eq(documents.jobId, job.id));
  return { job, doc };
}

beforeEach(async () => {
  db = await createPgliteDb();
  files = new Map();
  process.env.APP_URL = "https://dc.example.com";
});

describe("API keys", () => {
  it("a key is shown once, only its SHA-256 is stored, and it authenticates its client", async () => {
    const { key } = await createApiKey(db, admin, { client: "tmclog", allowedKinds: ["coa-neutralise", "label"] });
    expect(key).toMatch(/^tdc_tmclog_[A-Za-z0-9_-]{43}$/);
    const [row] = await db.select().from(apiClients);
    expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain(key.slice(11));
    expect(await authenticate(db, `Bearer ${key}`)).toMatchObject({ client: "tmclog", allowedKinds: ["coa-neutralise", "label"] });
    expect((await db.select().from(apiClients))[0].lastUsedAt).not.toBeNull();
    const audit = await db.select().from(auditLog).where(eq(auditLog.action, "api.key.created"));
    expect(JSON.stringify(audit)).not.toContain(key.slice(11));
  });

  it("wrong, malformed, other-client and deactivated keys are refused; the refusal is audited without the key", async () => {
    const { id, key } = await createApiKey(db, admin, { client: "tmclog", allowedKinds: ["coa-neutralise"] });
    const flipped = key.slice(0, -1) + (key.endsWith("A") ? "B" : "A");
    expect(await authenticate(db, `Bearer ${flipped}`)).toBeNull();
    expect(await authenticate(db, `Bearer ${key.replace("tmclog", "tmclox")}`)).toBeNull();
    expect(await authenticate(db, key)).toBeNull(); // no "Bearer "
    expect(await authenticate(db, null)).toBeNull();
    await deactivateApiKey(db, admin, id);
    expect(await authenticate(db, `Bearer ${key}`)).toBeNull();
    const refused = await db.select().from(auditLog).where(eq(auditLog.action, "api.key.refused"));
    expect(refused.length).toBeGreaterThan(0);
    expect(JSON.stringify(refused)).not.toContain(key.slice(11, 30));
  });

  it("invented client prefixes cannot flood the audit (security review S2)", async () => {
    for (let i = 0; i < 50; i++) await authenticate(db, `Bearer tdc_zz${i}_${"a".repeat(43)}`);
    const refused = await db.select().from(auditLog).where(eq(auditLog.action, "api.key.refused"));
    expect(refused.length).toBeLessThanOrEqual(1);
    expect(refused.every((r) => (r.details as { client: string }).client === "unknown")).toBe(true);
  });

  it(`at most ${MAX_ACTIVE_KEYS} active keys per client (rotation), bad input refused`, async () => {
    await createApiKey(db, admin, { client: "tmclog", allowedKinds: ["label"] });
    const second = await createApiKey(db, admin, { client: "tmclog", allowedKinds: ["label"] });
    await expect(createApiKey(db, admin, { client: "tmclog", allowedKinds: ["label"] })).rejects.toThrow(/already has 2/);
    await deactivateApiKey(db, admin, second.id);
    await createApiKey(db, admin, { client: "tmclog", allowedKinds: ["label"] });
    await expect(createApiKey(db, admin, { client: "TMC LOG", allowedKinds: ["label"] })).rejects.toThrow(/client/);
    await expect(createApiKey(db, admin, { client: "tmclog2", allowedKinds: [] })).rejects.toThrow(/at least one/);
    await expect(createApiKey(db, admin, { client: "tmclog2", allowedKinds: ["coo-draft"] })).rejects.toThrow();
  });
});

describe("POST /jobs", () => {
  it("creates a request in waiting-input; same key + same body = the same job; other body = 409", async () => {
    const b = body();
    const first = await create(b);
    expect(first.created).toBe(true);
    expect(first.job).toMatchObject({
      kind: "coa-neutralise",
      state: "waiting-input",
      problem: PROBLEM.supplierDocument,
      source: { requestId: b.source.requestId, orderNo: "901.S0001", partNo: 2 },
      resultCount: 0,
      link: `https://dc.example.com/api-jobs/${first.job.jobId}`,
    });
    // key order does not matter for "same body"
    const reordered = { facts: b.facts, source: b.source, entity: b.entity, kind: b.kind };
    const again = await createRequest(db, tmclog, b.source.requestId, reordered);
    expect(again).toEqual({ job: first.job, created: false });
    const conflict = await apiError(createRequest(db, tmclog, b.source.requestId, { ...b, kind: "sds-neutralise" }));
    expect([conflict.status, conflict.code]).toEqual([409, "idempotency_conflict"]);
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "api.job.created"));
    expect(audit.actor).toBe("tmclog:stivdb@transmare.com");
    expect(audit.details).toMatchObject({ client: "tmclog", requestedBy: "stivdb@transmare.com", kind: "coa-neutralise", requestId: b.source.requestId });
    expect(JSON.stringify(audit.details)).not.toContain("Betaine"); // no payload values in the audit
  });

  it("strict: an unknown field anywhere is 422 unknown_field with its path, never ignored", async () => {
    const b = body();
    const e1 = await apiError(createRequest(db, tmclog, b.source.requestId, { ...b, override: true }));
    expect([e1.status, e1.code, e1.fields]).toEqual([422, "unknown_field", ["override"]]);
    const e2 = await apiError(createRequest(db, tmclog, b.source.requestId, { ...b, source: { ...b.source, vendorName: "X" } }));
    expect(e2.fields).toEqual(["source.vendorName"]);
    const e3 = await apiError(
      createRequest(db, tmclog, b.source.requestId, { ...b, facts: { lines: [{ lineNo: 1, itemNo: null, description: null, unitPrice: "12" }] } }),
    );
    expect(e3.fields).toEqual(["facts.lines.0.unitPrice"]);
  });

  it("invalid values are 422 invalid_payload with paths only, never the value", async () => {
    const id = randomUUID();
    const cases: [Record<string, unknown>, string][] = [
      [body(id, { entity: "TMCGULF" }), "entity"],
      [body(id, { kind: "coo-draft" }), "kind"],
      [{ ...body(id), source: { ...body(id).source, requestedBy: "someone@gmail.com" } }, "source.requestedBy"],
      [{ ...body(id), source: { ...body(id).source, reason: "because" } }, "source.reason"],
      [{ ...body(id), source: { ...body(id).source, orderNo: "-rf" } }, "source.orderNo"],
      [{ ...body(id), facts: { lines: [] } }, "facts.lines"],
      [{ ...body(id), facts: { lines: [{ lineNo: 1, itemNo: "a\u0000b", description: null }] } }, "facts.lines.0.itemNo"],
      [{ ...body(id), facts: { lines: [{ lineNo: 1, itemNo: null, description: "x".repeat(251) }] } }, "facts.lines.0.description"],
    ];
    for (const [b, field] of cases) {
      const e = await apiError(createRequest(db, tmclog, id, b));
      expect([e.code, e.fields]).toEqual(["invalid_payload", [field]]);
      expect(JSON.stringify(e.body())).not.toContain("gmail");
    }
    const mismatch = await apiError(createRequest(db, tmclog, randomUUID(), body(id)));
    expect(mismatch.fields).toEqual(["source.requestId"]);
    expect((await apiError(createRequest(db, tmclog, null, body(id)))).code).toBe("missing_idempotency_key");
    expect((await apiError(createRequest(db, tmclog, "abc", body(id)))).fields).toEqual(["Idempotency-Key"]);
    expect(await db.select().from(apiJobs)).toHaveLength(0);
  });

  it("a kind the key may not ask for is 403; an entity without its record is 403", async () => {
    expect((await apiError(create(body(randomUUID(), { kind: "label" }), other))).code).toBe("kind_not_allowed");
    await db.execute("delete from entities where code = 'TMC'");
    expect((await apiError(create())).code).toBe("entity_not_set_up");
  });

  it(`more than ${MAX_CREATES_PER_MINUTE} creates a minute is 429 with Retry-After; a retry of an existing job still answers`, async () => {
    const first = body();
    await create(first);
    for (let i = 1; i < MAX_CREATES_PER_MINUTE; i++) await create();
    const e = await apiError(create());
    expect([e.status, e.code, e.retryAfter]).toEqual([429, "rate_limited", 60]);
    expect((await create(first)).created).toBe(false);
  });

  it("the same key sent at once: one job made, every other answer is that job (contract 8)", async () => {
    const b = body();
    const answers = await Promise.all([create(b), create(b), create(b)]);
    expect(answers.filter((a) => a.created)).toHaveLength(1);
    expect(new Set(answers.map((a) => a.job.jobId)).size).toBe(1);
    expect(await db.select().from(apiJobs)).toHaveLength(1);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "api.job.created"))).toHaveLength(1);
  });

  it("same body: key order at every level does not matter; any changed value is 409 (contract 8)", async () => {
    const lines = [
      { lineNo: 10000, itemNo: "IT-1", description: "Betaine AI test" },
      { lineNo: 20000, itemNo: null, description: null },
    ];
    const b = { ...body(), facts: { lines } };
    const s = b.source;
    const first = await createRequest(db, tmclog, s.requestId, b);
    const reordered = {
      facts: { lines: lines.map((l) => ({ description: l.description, lineNo: l.lineNo, itemNo: l.itemNo })) },
      source: { reason: s.reason, partNo: s.partNo, requestedBy: s.requestedBy, requestId: s.requestId, orderNo: s.orderNo, app: s.app },
      entity: b.entity,
      kind: b.kind,
    };
    expect(await createRequest(db, tmclog, s.requestId, reordered)).toEqual({ job: first.job, created: false });
    const changed = [
      { ...b, source: { ...s, partNo: 3 } },
      { ...b, source: { ...s, reason: "asked-by-person" } },
      { ...b, facts: { lines: [{ ...lines[0], description: "Betaine AI test " }, lines[1]] } },
      { ...b, facts: { lines: [lines[1], lines[0]] } },
      { ...b, facts: { lines: [lines[0]] } },
    ];
    for (const c of changed) expect((await apiError(createRequest(db, tmclog, s.requestId, c))).code).toBe("idempotency_conflict");
    expect(await db.select().from(apiJobs)).toHaveLength(1);
  });
});

describe("GET /jobs and results", () => {
  it("another client's job is 404, never shown; unknown ids are left out of a list", async () => {
    const { job } = await create();
    expect((await apiError(getRequest(db, other, job.jobId))).code).toBe("not_found");
    expect((await apiError(getRequest(db, tmclog, "not-a-uuid"))).code).toBe("not_found");
    expect((await apiError(requestResults(db, other, job.jobId))).code).toBe("not_found");
    expect(await getRequests(db, other, job.jobId)).toEqual([]);
    expect((await getRequests(db, tmclog, `${job.jobId},${randomUUID()}`)).map((j) => j.jobId)).toEqual([job.jobId]);
    expect((await apiError(getRequests(db, tmclog, "x,y"))).fields).toEqual(["ids"]);
    expect((await apiError(getRequests(db, tmclog, Array.from({ length: 101 }, () => randomUUID()).join(",")))).code).toBe("invalid_payload");
  });

  it("ids are matched case-insensitively and each job comes back once", async () => {
    const { job } = await create();
    const list = await getRequests(db, tmclog, `${job.jobId.toUpperCase()}, ${job.jobId} ,${job.jobId},`);
    expect(list.map((j) => j.jobId)).toEqual([job.jobId]);
  });

  it("results: only the contract fields for every status; a name only from Final on (S1)", async () => {
    const { job } = await create();
    const { doc } = await draftFor(job.jobId);
    for (const status of ["Draft", "To check", "Final", "Superseded", "Rejected"] as const) {
      const final = status === "Final" || status === "Superseded";
      await db
        .update(documents)
        .set({ status, version: final ? 1 : null, pdfKey: final ? newUploadKey("pdf") : null, approvedAt: final ? new Date() : null })
        .where(eq(documents.id, doc.id));
      const results = await requestResults(db, tmclog, job.jobId);
      expect(results).toHaveLength(1);
      expect(Object.keys(results[0]).sort()).toEqual(["batch", "documentId", "finalAt", "link", "name", "status", "type", "version"]);
      expect([results[0].status, results[0].name !== null, results[0].finalAt !== null]).toEqual([status, final, final]);
      const out = JSON.stringify(results);
      for (const secret of [SUPPLIER, "coa.pdf", "uploads/", "engine"]) expect(out).not.toContain(secret);
    }
  });

  it("a label request follows its label: in-progress, to-check, ready", async () => {
    const { job } = await create(body(randomUUID(), { kind: "label" }));
    await createLabelJob(db, person, {
      template: "sample",
      language: "EN",
      entity: "TMC",
      productName: "Betaine AI test",
      batch: "BT-3877",
      fileNr: "901.S0001",
      apiJobId: job.jobId,
    });
    expect(await getRequest(db, tmclog, job.jobId)).toMatchObject({ state: "in-progress", problem: null });
    const run = (await claimNextJob(db))!;
    expect(run.apiJobId).toBe(job.jobId);
    const label: Draft = { ...draft("TMC_LABEL_901.S0001_Betaine_AI_test_BT-3877_EN"), type: "LABEL", sourceKey: null, sourceFilename: null, by: "label" };
    await saveDrafts(db, run, [label], 0, "ok");
    expect(await getRequest(db, tmclog, job.jobId)).toMatchObject({ state: "to-check", problem: null, resultCount: 1 });
    await db.update(documents).set({ status: "Final", version: 1, pdfKey: newUploadKey("pdf"), approvedAt: new Date() }).where(eq(documents.jobId, run.id));
    expect(await getRequest(db, tmclog, job.jobId)).toMatchObject({ state: "ready", problem: null, resultCount: 1 });
  });

  it("a person's run for another entity than the request's is refused (supplier document and label)", async () => {
    await saveEntity(db, admin, "TMCGULF", { naam: "Example Gulf", adres: "Street 1", telefoon: "+1 0", email: "x@example.com", web: "example.com", btw: "X1", nood: "+1 0" });
    const coa = (await create()).job;
    await expect(createJobs(db, storage, person, [supplierDoc(coa.jobId, { entity: "TMCGULF" })])).rejects.toThrow(/for entity TMC/);
    const lbl = (await create(body(randomUUID(), { kind: "label" }))).job;
    const label = { template: "sample", language: "EN", entity: "TMCGULF", productName: "Betaine AI test", batch: "BT-3877", apiJobId: lbl.jobId };
    await expect(createLabelJob(db, person, label)).rejects.toThrow(/for entity TMC/);
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it("follows the work in the app: waiting-input, in-progress, to-check, ready; never a supplier name or file", async () => {
    const { job } = await create();
    await createJobs(db, storage, person, [supplierDoc(job.jobId)]);
    expect((await getRequest(db, tmclog, job.jobId)).state).toBe("in-progress");
    const run = (await claimNextJob(db))!;
    await saveDrafts(db, run, [draft("TMC_COA_901.S0001_Betaine_AI_test_BT-3877")], 0, `engine log naming ${SUPPLIER}`);
    expect((await getRequest(db, tmclog, job.jobId)).state).toBe("to-check");
    // a draft's name can hold the supplier file's name: never sent before Final (security review S1)
    expect((await requestResults(db, tmclog, job.jobId))[0]).toMatchObject({ status: "To check", name: null, finalAt: null });
    const [doc] = await db.select().from(documents).where(eq(documents.jobId, run.id));
    await db.update(documents).set({ status: "Final", version: 1, pdfKey: newUploadKey("pdf"), approvedAt: new Date(), approvedBy: person.email }).where(eq(documents.id, doc.id));
    const ready = await getRequest(db, tmclog, job.jobId);
    expect(ready).toMatchObject({ state: "ready", problem: null, resultCount: 1 });
    const results = await requestResults(db, tmclog, job.jobId);
    expect(results).toEqual([
      {
        documentId: doc.id,
        type: "COA",
        name: "TMC_COA_901.S0001_Betaine_AI_test_BT-3877",
        status: "Final",
        version: 1,
        batch: "BT-3877",
        finalAt: expect.any(String),
        link: `https://dc.example.com/documents/${doc.id}`,
      },
    ]);
    const out = JSON.stringify([ready, results]);
    for (const secret of [SUPPLIER, "coa.pdf", "engine log", "uploads/", "yellow"]) expect(out).not.toContain(secret);
  });

  it("the person's supplier document must fit the request: kind, entity, not cancelled", async () => {
    const { job } = await create();
    await expect(createJobs(db, storage, person, [supplierDoc(job.jobId, { route: "sds" })])).rejects.toThrow(RequestError);
    await expect(createJobs(db, storage, person, [supplierDoc(job.jobId, { route: "auto" })])).rejects.toThrow(/is for a COA/);
    await expect(createJobs(db, storage, person, [supplierDoc(job.jobId, { supplierName: "" })])).rejects.toThrow(/supplier name/);
    await expect(createJobs(db, storage, person, [supplierDoc(randomUUID())])).rejects.toThrow(/request not found/);
    await cancelRequest(db, tmclog, job.jobId, { requestedBy: "stivdb@transmare.com" });
    await expect(createJobs(db, storage, person, [supplierDoc(job.jobId)])).rejects.toThrow(/cancelled/);
    expect(await db.select().from(jobs)).toHaveLength(0);
  });

  it("a label request takes labels only", async () => {
    const { job } = await create(body(randomUUID(), { kind: "label" }));
    expect(job).toMatchObject({ state: "waiting-input", problem: PROBLEM.label });
    await expect(createJobs(db, storage, person, [supplierDoc(job.jobId)])).rejects.toThrow(/is for a label/);
    await createLabelJob(db, person, {
      template: "sample",
      language: "EN",
      entity: "TMC",
      productName: "Betaine AI test",
      batch: "BT-3877",
      fileNr: "901.S0001",
      apiJobId: job.jobId,
    }).catch((err) => {
      // the sample template id may differ: the request link itself is what is tested here
      if (!/template/.test(String(err))) throw err;
    });
    await db.transaction(async (tx) => {
      await expect(assertRequestOpen(tx, job.jobId, { label: true })).resolves.toMatchObject({ kind: "label" });
    });
  });
});

describe("cancel (contract section 9)", () => {
  const by = { requestedBy: "stivdb@transmare.com" };

  it("waiting-input: cancelled; idempotent; audited; another client = 404; strict body", async () => {
    const { job } = await create();
    expect((await apiError(cancelRequest(db, tmclog, job.jobId, { ...by, reason: "x" }))).code).toBe("unknown_field");
    expect((await apiError(cancelRequest(db, other, job.jobId, by))).code).toBe("not_found");
    expect((await cancelRequest(db, tmclog, job.jobId, by)).state).toBe("cancelled");
    expect((await cancelRequest(db, tmclog, job.jobId, by)).state).toBe("cancelled");
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "api.job.cancelled"))).toHaveLength(1);
  });

  it("queued run: stopped, never run; a draft to check: Rejected with the fixed reason, never deleted", async () => {
    const queued = (await create()).job;
    await createJobs(db, storage, person, [supplierDoc(queued.jobId)]);
    await cancelRequest(db, tmclog, queued.jobId, by);
    const [run] = await db.select().from(jobs).where(eq(jobs.apiJobId, queued.jobId));
    expect(run.state).toBe("cancelled");
    expect(await claimNextJob(db)).toBeNull();

    const checking = (await create()).job;
    const { job: run2, doc } = await draftFor(checking.jobId);
    await cancelRequest(db, tmclog, checking.jobId, by);
    const [after] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(after).toMatchObject({ status: "Rejected", rejectedReason: NOT_NEEDED, previewKey: null });
    expect((await db.select().from(jobs).where(eq(jobs.id, run2.id)))[0].state).toBe("done");
    expect((await requestResults(db, tmclog, checking.jobId)).map((r) => r.status)).toEqual(["Rejected"]);
  });

  it("running run: it finishes and its drafts are saved as Rejected", async () => {
    const { job } = await create();
    await createJobs(db, storage, person, [supplierDoc(job.jobId)]);
    const run = (await claimNextJob(db))!;
    await cancelRequest(db, tmclog, job.jobId, by);
    expect((await db.select().from(jobs).where(eq(jobs.id, run.id)))[0].state).toBe("running");
    await saveDrafts(db, run, [draft("TMC_COA_901.S0001_Betaine_AI_test_BT-3877")], 0, "ok");
    const [doc] = await db.select().from(documents).where(eq(documents.jobId, run.id));
    expect(doc).toMatchObject({ status: "Rejected", rejectedReason: NOT_NEEDED, previewKey: null, viewKey: null });
    expect((await getRequest(db, tmclog, job.jobId)).state).toBe("cancelled");
  });

  it("a crashed run of a cancelled request is not queued again (security review S5)", async () => {
    const { job } = await create();
    await createJobs(db, storage, person, [supplierDoc(job.jobId)]);
    const run = (await claimNextJob(db))!;
    await cancelRequest(db, tmclog, job.jobId, by);
    await db.update(jobs).set({ startedAt: new Date(Date.now() - 60 * 60 * 1000) }).where(eq(jobs.id, run.id));
    await requeueStaleJobs(db);
    expect((await db.select().from(jobs).where(eq(jobs.id, run.id)))[0].state).toBe("cancelled");
    expect(await claimNextJob(db)).toBeNull();
  });

  it("a draft a person is finalising is left alone and may still become Final; the request stays cancelled", async () => {
    const { job } = await create();
    const { doc } = await draftFor(job.jobId);
    const metadata = { productName: "Betaine AI test", fileNr: "901.S0001", batch: "BT-3877" };
    await db.insert(jobs).values({ kind: "finalise", documentId: doc.id, entity: "TMC", payload: { mode: "approve", metadata }, createdBy: person.email });
    await cancelRequest(db, tmclog, job.jobId, by);
    expect((await db.select().from(documents).where(eq(documents.id, doc.id)))[0].status).toBe("To check");
    const fin = (await claimNextJob(db))!;
    expect(fin).toMatchObject({ kind: "finalise", documentId: doc.id });
    await saveFinal(db, fin, { pdfKey: newUploadKey("pdf"), pdfFilename: "f.pdf", docxKey: newUploadKey("docx"), docxFilename: "f.docx" }, "ok");
    expect((await db.select().from(documents).where(eq(documents.id, doc.id)))[0].status).toBe("Final");
    expect(await getRequest(db, tmclog, job.jobId)).toMatchObject({ state: "cancelled", resultCount: 1 });
    expect((await requestResults(db, tmclog, job.jobId)).map((r) => r.status)).toEqual(["Final"]);
  });

  it("a Final stays Final", async () => {
    const { job } = await create();
    const { doc } = await draftFor(job.jobId);
    await db.update(documents).set({ status: "Final", version: 1, pdfKey: newUploadKey("pdf"), approvedAt: new Date() }).where(eq(documents.id, doc.id));
    await cancelRequest(db, tmclog, job.jobId, by);
    expect((await db.select().from(documents).where(eq(documents.id, doc.id)))[0].status).toBe("Final");
  });
});

describe("state rollup (Willem 27/10)", () => {
  const t = (m: number) => new Date(Date.UTC(2026, 9, 27, 9, m));
  const req = { kind: "coa-neutralise" as const, createdAt: t(0), cancelledAt: null };
  const child = (state: string, m: number) => ({ id: `j${m}`, apiJobId: "r", state, createdAt: t(m), startedAt: null, finishedAt: null });
  // a Final and a former Final carry a version; a draft (also one replaced by "Run again") has none
  const doc = (status: "To check" | "Final" | "Superseded" | "Rejected", m: number, version: number | null = status === "Final" || status === "Superseded" ? 1 : null) =>
    ({ id: `d${m}`, jobId: "j1", status, createdAt: t(m), approvedAt: null, version });

  it("every draft rejected: back to waiting-input", () => {
    expect(rollup(req, [child("done", 1)], [doc("Rejected", 2)]).state).toBe("waiting-input");
  });
  it("one supplier document failed, another gave a Final: ready", () => {
    expect(rollup(req, [child("done", 1), child("failed", 3)], [doc("Final", 2)]).state).toBe("ready");
  });
  it("failed only when nothing usable and the latest run failed", () => {
    expect(rollup(req, [child("failed", 1)], [])).toMatchObject({ state: "failed", problem: PROBLEM.engine });
    expect(rollup(req, [child("failed", 1), child("done", 2)], [doc("Rejected", 3)]).state).toBe("waiting-input");
  });
  it("a superseded Final still counts as done; changedAt is the last thing that happened", () => {
    const r = rollup(req, [child("done", 1)], [doc("Superseded", 2)], t(9));
    expect(r.state).toBe("ready");
    expect(r.changedAt).toEqual(t(9));
  });
  it("a draft replaced by Run again (Superseded, no version) is never ready (security review H1)", () => {
    expect(rollup(req, [child("done", 1)], [doc("Superseded", 2, null)]).state).toBe("waiting-input");
    expect(wasFinal({ status: "Superseded", version: null })).toBe(false);
    expect(wasFinal({ status: "Superseded", version: 2 })).toBe(true);
  });
  it("a run or a draft open wins over ready", () => {
    expect(rollup(req, [child("done", 1), child("queued", 4)], [doc("Final", 2)]).state).toBe("in-progress");
    expect(rollup(req, [child("done", 1)], [doc("Final", 2), doc("To check", 3)]).state).toBe("to-check");
  });
});
