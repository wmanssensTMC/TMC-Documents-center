import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db";
import type { Storage } from "@/lib/storage";

// v1.1 (contract section 15) through the real routes on a real (in-memory) database; only getDb and
// the file storage are pointed at test doubles.
let db: Db;
const files = new Map<string, Uint8Array>();
const storage: Storage = {
  mode: "local",
  put: async (key, data) => void files.set(key, data),
  get: async (key) => {
    const f = files.get(key);
    return f ? { stream: new Blob([new Uint8Array(f)]).stream(), size: f.length, contentType: null } : null;
  },
  head: async (key, n) => (files.has(key) ? { bytes: files.get(key)!.subarray(0, n), size: files.get(key)!.length } : null),
};
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), getDb: async () => db }));
vi.mock("@/lib/storage", () => ({ getStorage: () => storage }));

const { createPgliteDb } = await import("@/lib/db");
const { createApiKey } = await import("@/lib/api/keys");
const { PROBLEM } = await import("@/lib/api/requests");
const { startEngine } = await import("@/lib/api/supplier-document");
const { claimNextJob, saveDrafts } = await import("@/lib/jobs/worker-state");
const { newUploadKey } = await import("@/lib/files");
const schema = await import("@/lib/db/schema");
const jobsRoute = await import("./jobs/route");
const oneRoute = await import("./jobs/[id]/route");
const resultsRoute = await import("./jobs/[id]/results/route");
const handoffRoute = await import("./jobs/[id]/supplier-document/route");
const fileRoute = await import("./jobs/[id]/results/[documentId]/file/route");

const admin = { email: "wilman@transmare.com", name: "Willem", role: "admin" as const };
const BASE = "https://dc.example.com/api/v1";
const SUPPLIER = "Acme Chemicals GmbH";
const PDF = new TextEncoder().encode("%PDF-1.7\nsupplier coa\n%%EOF");
const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
let key: string;
let client = 0;

const auth = (k = key) => ({ authorization: `Bearer ${k}` });
const ctx = (p: Record<string, string>) => ({ params: Promise.resolve(p) }) as never;
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

function body(requestId: string, over: { kind?: string; supplierName?: string; lines?: unknown[] } = {}) {
  return {
    kind: over.kind ?? "coa-neutralise",
    entity: "TMC",
    source: { app: "tmc-logistics", requestId, orderNo: "901.S0001", partNo: 2, requestedBy: "stivdb@transmare.com", reason: "neutral-customer" },
    facts: {
      lines: over.lines ?? [{ lineNo: 10000, itemNo: "IT-1", description: "Betaine AI test" }],
      ...(over.supplierName !== undefined ? { supplierName: over.supplierName } : {}),
    },
  };
}

async function create(over: Parameters<typeof body>[1] = {}, k = key) {
  const id = randomUUID();
  const res = await jobsRoute.POST(
    new Request(`${BASE}/jobs`, { method: "POST", headers: { ...auth(k), "idempotency-key": id }, body: JSON.stringify(body(id, over)) }),
  );
  return { res, job: (await res.json()) as { jobId: string; state: string; problem: string | null } };
}

function put(jobId: string, bytes: Uint8Array, headers: Record<string, string | null> = {}) {
  const h: Record<string, string> = {
    ...auth(),
    "content-type": "application/pdf",
    "content-length": String(bytes.length),
    "idempotency-key": randomUUID(),
    "x-file-name": encodeURIComponent("Acme COA lot 7.pdf"),
  };
  for (const [k, v] of Object.entries(headers)) {
    if (v === null) delete h[k];
    else h[k] = v;
  }
  return handoffRoute.PUT(new Request(`${BASE}/jobs/${jobId}/supplier-document`, { method: "PUT", headers: h, body: new Uint8Array(bytes) }), ctx({ id: jobId }));
}

const code = async (res: Response) => ((await res.json()) as { error: { code: string } }).error.code;

/** The handed-over document run by the worker and made Final by a person (the PDF stored). */
async function finalOf(jobId: string, name = `TMC_COA_901.S0001_Betaine_AI_test_${randomUUID().slice(0, 8)}`) {
  const run = (await claimNextJob(db))!;
  await saveDrafts(
    db,
    run,
    [
      {
        name,
        type: "COA",
        entity: "TMC",
        docxKey: newUploadKey("docx"),
        docxFilename: `${name}.docx`,
        pdfKey: null,
        pdfFilename: null,
        sourceKey: run.supplierFile!.key,
        sourceFilename: run.supplierFile!.filename,
        yellow: false,
        yellowParts: [],
        previewKey: null,
        batch: "BT-3877",
      },
    ],
    0,
    "ok",
  );
  const [doc] = await db.select().from(schema.documents).where(eq(schema.documents.jobId, run.id));
  const pdfKey = newUploadKey("pdf");
  files.set(pdfKey, new TextEncoder().encode("%PDF-1.7\nTMC final\n%%EOF"));
  await db.update(schema.documents).set({ status: "Final", version: 1, pdfKey, productName: "Betaine AI test", approvedAt: new Date() }).where(eq(schema.documents.id, doc.id));
  expect(run.apiJobId).toBe(jobId);
  return { doc: { ...doc, pdfKey }, run };
}

beforeAll(async () => {
  db = await createPgliteDb();
});

beforeEach(async () => {
  process.env.API_CLIENTS_ENABLED = "on";
  process.env.APP_URL = "https://dc.example.com";
  delete process.env.DC_API_MAX_BODY_MB;
  ({ key } = await createApiKey(db, admin, { client: `v${++client}`, allowedKinds: ["coa-neutralise", "sds-neutralise", "label"] }));
});

afterEach(() => {
  delete process.env.API_CLIENTS_ENABLED;
  delete process.env.APP_URL;
});

describe("optional supplier name on create (15.2)", () => {
  it("is kept internally and never in any answer", async () => {
    const { res, job } = await create({ supplierName: `  ${SUPPLIER} ` });
    expect(res.status).toBe(201);
    const [row] = await db.select().from(schema.apiJobs).where(eq(schema.apiJobs.id, job.jobId));
    expect(row.supplierName).toBe(SUPPLIER);
    const one = await oneRoute.GET(new Request(`${BASE}/jobs/${job.jobId}`, { headers: auth() }), ctx({ id: job.jobId }));
    const many = await jobsRoute.GET(new Request(`${BASE}/jobs?ids=${job.jobId}`, { headers: auth() }));
    const out = JSON.stringify([job, await one.json(), await many.json()]);
    expect(out).not.toContain("Acme");
    const audit = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "api.job.created"));
    expect(JSON.stringify(audit)).not.toContain("Acme");
  });

  it("a label takes none (unknown_field); a too short or unsafe one is invalid_payload", async () => {
    const label = await create({ kind: "label", supplierName: SUPPLIER });
    expect(label.res.status).toBe(422);
    expect((label.job as unknown as { error: { code: string; fields: string[] } }).error).toMatchObject({ code: "unknown_field", fields: ["facts.supplierName"] });
    for (const bad of ["A", "-Acme", "Acme\u0000"]) {
      const r = await create({ supplierName: bad });
      expect((r.job as unknown as { error: { code: string; fields: string[] } }).error).toMatchObject({ code: "invalid_payload", fields: ["facts.supplierName"] });
    }
  });
});

describe("PUT /jobs/{id}/supplier-document (15.1)", () => {
  it("stores the PDF; without a supplier name the job waits with the fixed problem; never the file name back", async () => {
    const { job } = await create();
    const res = await put(job.jobId, PDF);
    expect(res.status).toBe(201);
    const out = await res.json();
    expect(out).toMatchObject({ jobId: job.jobId, state: "waiting-input", problem: PROBLEM.supplierName, supplierDocument: { sha256: sha(PDF), size: PDF.length, contentType: "application/pdf" } });
    expect(JSON.stringify(out)).not.toMatch(/Acme|lot 7|uploads\//);
    const [row] = await db.select().from(schema.apiJobs).where(eq(schema.apiJobs.id, job.jobId));
    expect(files.get(row.supplierFile!.key)).toEqual(PDF);
    expect(row.supplierFile!.filename).toBe("Acme COA lot 7.pdf");
    const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "api.job.input"));
    expect(audit.details).toMatchObject({ apiJob: job.jobId, sha256: sha(PDF), size: PDF.length, contentType: "application/pdf" });
    expect(JSON.stringify(audit)).not.toContain("lot 7");
  });

  it("with the supplier name from create the engine starts: dossier = order no, product = the one line", async () => {
    const { job } = await create({ supplierName: SUPPLIER });
    const res = await put(job.jobId, PDF);
    expect((await res.json()).state).toBe("in-progress");
    const [run] = await db.select().from(schema.jobs).where(eq(schema.jobs.apiJobId, job.jobId));
    expect(run).toMatchObject({ kind: "neutralise", route: "coa", state: "queued", supplierName: SUPPLIER, fileNr: "901.S0001", productName: "Betaine AI test", createdBy: "stivdb@transmare.com".replace(/^/, `v${client}:`) });
    await claimNextJob(db); // leave the queue empty for the next tests
  });

  it("several lines: no product name is guessed; a person typing the supplier name starts it", async () => {
    const { job } = await create({ lines: [{ lineNo: 1, itemNo: null, description: "A" }, { lineNo: 2, itemNo: null, description: "B" }] });
    await put(job.jobId, PDF);
    const [req] = await db.select().from(schema.apiJobs).where(eq(schema.apiJobs.id, job.jobId));
    await startEngine(db, storage, { email: "sigber@transmare.com", name: "Sigi", role: "user" }, req, SUPPLIER);
    const [run] = await db.select().from(schema.jobs).where(eq(schema.jobs.apiJobId, job.jobId));
    expect(run).toMatchObject({ productName: null, fileNr: "901.S0001", supplierName: SUPPLIER, createdBy: "sigber@transmare.com" });
    await claimNextJob(db);
  });

  it("the handed-over document gives one run only: a second start is refused (security review M1)", async () => {
    const { job } = await create({ supplierName: SUPPLIER });
    await put(job.jobId, PDF); // starts the run
    const [req] = await db.select().from(schema.apiJobs).where(eq(schema.apiJobs.id, job.jobId));
    await expect(startEngine(db, storage, { email: "sigber@transmare.com", name: "Sigi", role: "user" }, req, SUPPLIER)).rejects.toThrow(/already sent/);
    expect(await db.select().from(schema.jobs).where(eq(schema.jobs.apiJobId, job.jobId))).toHaveLength(1);
    await claimNextJob(db);
  });

  it("after a person's run gave nothing, a hand-off without a name still waits for the name and can start (review M3)", async () => {
    const { job } = await create();
    const key0 = newUploadKey("input");
    files.set(key0, PDF);
    const { createJobs } = await import("@/lib/jobs");
    await createJobs(db, storage, { email: "sigber@transmare.com", name: "Sigi", role: "user" }, [
      { route: "coa", entity: "TMC", supplierName: SUPPLIER, supplierFile: { key: key0, filename: "coa.pdf" }, apiJobId: job.jobId },
    ]);
    const run = (await claimNextJob(db))!;
    await saveDrafts(db, run, [], 0, "nothing usable"); // no draft: back to waiting for a supplier document
    const out = await (await put(job.jobId, PDF)).json();
    expect(out).toMatchObject({ state: "waiting-input", problem: PROBLEM.supplierName });
    const [req] = await db.select().from(schema.apiJobs).where(eq(schema.apiJobs.id, job.jobId));
    await startEngine(db, storage, { email: "sigber@transmare.com", name: "Sigi", role: "user" }, req, SUPPLIER);
    expect(await db.select().from(schema.jobs).where(eq(schema.jobs.apiJobId, job.jobId))).toHaveLength(2);
    await claimNextJob(db);
  });

  it("replay: same key + same bytes = 200 same answer; same key + other bytes = 409; another key = 409", async () => {
    const { job } = await create();
    const k = randomUUID();
    const first = await (await put(job.jobId, PDF, { "idempotency-key": k })).json();
    const again = await put(job.jobId, PDF, { "idempotency-key": k });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(first);
    const other = new TextEncoder().encode("%PDF-1.7\nanother file\n%%EOF");
    expect(await code(await put(job.jobId, other, { "idempotency-key": k }))).toBe("idempotency_conflict");
    expect(await code(await put(job.jobId, PDF))).toBe("not_waiting_for_input");
  });

  it("type and length header checks: 415 and 411", async () => {
    const { job } = await create();
    const exe = new TextEncoder().encode("MZ\u0090\u0000 fake exe with a pdf header");
    expect(await code(await put(job.jobId, exe))).toBe("unsupported_type"); // a PDF header on an EXE
    const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5]);
    expect(await code(await put(job.jobId, zip, { "content-type": DOCX }))).toBe("unsupported_type"); // DOCX (also with macros): not read by the engine
    expect(await code(await put(job.jobId, zip))).toBe("unsupported_type"); // header says PDF, bytes are a ZIP
    expect(await code(await put(job.jobId, PDF, { "content-type": "text/plain" }))).toBe("unsupported_type");
    expect(await code(await put(job.jobId, PDF, { "content-length": null }))).toBe("length_required");
    expect(await code(await put(job.jobId, PDF, { "content-length": "0" }))).toBe("length_required");
  });

  it("name and key checks: 422 and 400", async () => {
    const { job } = await create();
    expect(await code(await put(job.jobId, PDF, { "x-file-name": null }))).toBe("invalid_payload");
    expect(await code(await put(job.jobId, PDF, { "x-file-name": encodeURIComponent("../etc/passwd") }))).toBe("invalid_payload");
    expect(await code(await put(job.jobId, PDF, { "x-file-name": "%E0%A4%A" }))).toBe("invalid_payload");
    expect(await code(await put(job.jobId, PDF, { "idempotency-key": null }))).toBe("missing_idempotency_key");
  });

  it("the declared length is refused before a byte is read (413), and a body shorter than it too", async () => {
    const { job } = await create();
    expect((await put(job.jobId, PDF, { "content-length": String(5 * 1024 * 1024) })).status).toBe(413); // Vercel default 4 MB
    process.env.DC_API_MAX_BODY_MB = "100";
    expect((await put(job.jobId, PDF, { "content-length": String(100 * 1024 * 1024 + 1) })).status).toBe(413);
    // a body shorter than its own length is refused
    expect(await code(await put(job.jobId, PDF, { "content-length": String(PDF.length + 10) }))).toBe("invalid_payload");
    const [row] = await db.select().from(schema.apiJobs).where(eq(schema.apiJobs.id, job.jobId));
    expect(row.supplierFile).toBeNull();
  });

  it("another client's job = 404; a label job = 422 not_accepted_for_kind; cancelled = 409", async () => {
    const { job } = await create();
    const mine = key;
    ({ key } = await createApiKey(db, admin, { client: `v${++client}`, allowedKinds: ["coa-neutralise", "label"] }));
    expect((await put(job.jobId, PDF)).status).toBe(404);
    const label = await create({ kind: "label" });
    expect(await code(await put(label.job.jobId, PDF))).toBe("not_accepted_for_kind");
    key = mine;
    await (await import("./jobs/[id]/cancel/route")).POST(
      new Request(`${BASE}/jobs/${job.jobId}/cancel`, { method: "POST", headers: auth(), body: JSON.stringify({ requestedBy: "stivdb@transmare.com" }) }),
      ctx({ id: job.jobId }),
    );
    expect(await code(await put(job.jobId, PDF))).toBe("not_waiting_for_input");
  });
});

describe("GET /jobs/{id}/results/{documentId}/file (15.3)", () => {
  const get = (jobId: string, documentId: string, headers: Record<string, string> = { "x-requested-by": "stivdb@transmare.com" }) =>
    fileRoute.GET(new Request(`${BASE}/jobs/${jobId}/results/${documentId}/file`, { headers: { ...auth(), ...headers } }), ctx({ id: jobId, documentId }));

  it("Final: the PDF with its SHA-256 and name; audited; the results list never names the supplier", async () => {
    const { job } = await create({ supplierName: SUPPLIER });
    await put(job.jobId, PDF);
    const { doc } = await finalOf(job.jobId);
    const res = await get(job.jobId, doc.id);
    expect(res.status).toBe(200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Buffer.from(bytes).toString("latin1")).toContain("TMC final");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("x-content-sha256")).toBe(sha(bytes));
    expect(res.headers.get("content-disposition")).toContain(`filename="${doc.name}.pdf"`);
    const [audit] = await db.select().from(schema.auditLog).where(eq(schema.auditLog.action, "api.result.file.read"));
    expect(audit.details).toMatchObject({ requestedBy: "stivdb@transmare.com", apiJob: job.jobId, document: doc.id });
    const results = await (await resultsRoute.GET(new Request(`${BASE}/jobs/${job.jobId}/results`, { headers: auth() }), ctx({ id: job.jobId }))).json();
    expect(JSON.stringify(results)).not.toMatch(/Acme|lot 7/);
  });

  it("not Final (To check, Superseded) = 409; no X-Requested-By = 422; another job's document or client = 404; too large = 413", async () => {
    const { job } = await create({ supplierName: SUPPLIER });
    await put(job.jobId, PDF);
    const { doc } = await finalOf(job.jobId);
    expect(await code(await get(job.jobId, doc.id, {}))).toBe("invalid_payload");
    expect(await code(await get(job.jobId, doc.id, { "x-requested-by": "someone@gmail.com" }))).toBe("invalid_payload");
    const other = await create();
    expect((await get(other.job.jobId, doc.id)).status).toBe(404);
    expect((await get(job.jobId, randomUUID())).status).toBe(404);
    files.set(doc.pdfKey, new Uint8Array(5 * 1024 * 1024).fill(0x25));
    expect(await code(await get(job.jobId, doc.id))).toBe("too_large_for_link"); // over the 4 MB platform limit (413)
    for (const status of ["To check", "Superseded"] as const) {
      await db.update(schema.documents).set({ status, ...(status === "To check" ? { version: null } : {}) }).where(eq(schema.documents.id, doc.id));
      expect(await code(await get(job.jobId, doc.id))).toBe("not_final");
    }
    const mine = key;
    ({ key } = await createApiKey(db, admin, { client: `v${++client}`, allowedKinds: ["coa-neutralise"] }));
    expect((await get(job.jobId, doc.id)).status).toBe(404);
    key = mine;
  });
});
