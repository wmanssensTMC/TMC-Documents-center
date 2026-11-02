import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/lib/db";

// The real routes on a real (in-memory) database; only getDb is pointed at it.
let db: Db;
vi.mock("@/lib/db", async (orig) => ({ ...(await orig<typeof import("@/lib/db")>()), getDb: async () => db }));

const { createPgliteDb } = await import("@/lib/db");
const { createApiKey } = await import("@/lib/api/keys");
const { MAX_READS_PER_MINUTE, MAX_REFUSED_PER_MINUTE, MAX_WRITES_PER_MINUTE } = await import("@/lib/api/http");
const jobsRoute = await import("./jobs/route");
const oneRoute = await import("./jobs/[id]/route");
const resultsRoute = await import("./jobs/[id]/results/route");
const cancelRoute = await import("./jobs/[id]/cancel/route");
const healthRoute = await import("./health/route");

const admin = { email: "wilman@transmare.com", name: "Willem", role: "admin" as const };
let key: string;
let client = 0;

const BASE = "https://dc.example.com/api/v1";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) }) as never;
const auth = (k = key) => ({ authorization: `Bearer ${k}` });

function body(requestId: string) {
  return {
    kind: "coa-neutralise",
    entity: "TMC",
    source: { app: "tmc-logistics", requestId, orderNo: "901.S0001", partNo: 2, requestedBy: "stivdb@transmare.com", reason: "neutral-customer" },
    facts: { lines: [{ lineNo: 10000, itemNo: "IT-1", description: "Betaine AI test" }] },
  };
}

const post = (b: unknown, headers: Record<string, string> = {}) =>
  jobsRoute.POST(new Request(`${BASE}/jobs`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof b === "string" ? b : JSON.stringify(b) }));

async function newJob() {
  const id = randomUUID();
  const res = await post(body(id), { ...auth(), "idempotency-key": id });
  expect(res.status).toBe(201);
  return (await res.json()) as { jobId: string };
}

beforeAll(async () => {
  db = await createPgliteDb();
});

beforeEach(async () => {
  process.env.API_CLIENTS_ENABLED = "on";
  process.env.APP_URL = "https://dc.example.com";
  // a fresh client per test, so the read limit of one test does not carry over
  ({ key } = await createApiKey(db, admin, { client: `c${++client}`, allowedKinds: ["coa-neutralise"] }));
});

afterEach(() => {
  delete process.env.API_CLIENTS_ENABLED;
  delete process.env.APP_URL;
});

describe("/api/v1", () => {
  it("health needs no key and says only ok", async () => {
    const res = healthRoute.GET();
    expect(await res.json()).toEqual({ ok: true });
  });

  it("switched off (default): every call is 503 unavailable, even with a good key", async () => {
    delete process.env.API_CLIENTS_ENABLED;
    const res = await jobsRoute.GET(new Request(`${BASE}/jobs?ids=${randomUUID()}`, { headers: auth() }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "unavailable", message: "The Document Center API is not available." } });
  });

  it("no key, a wrong key: 401 with the fixed body", async () => {
    for (const headers of [{}, auth("tdc_c1_" + "x".repeat(43)), { authorization: "Basic abc" }]) {
      const res = await jobsRoute.GET(new Request(`${BASE}/jobs?ids=${randomUUID()}`, { headers }));
      expect(res.status).toBe(401);
      expect((await res.json()).error.code).toBe("unauthorized");
    }
  });

  it("create 201, again 200, read one, read many, results, cancel", async () => {
    const id = randomUUID();
    const first = await post(body(id), { ...auth(), "idempotency-key": id });
    expect(first.status).toBe(201);
    expect(first.headers.get("cache-control")).toBe("no-store");
    const job = await first.json();
    expect((await post(body(id), { ...auth(), "idempotency-key": id })).status).toBe(200);
    expect(await (await oneRoute.GET(new Request(`${BASE}/jobs/${job.jobId}`, { headers: auth() }), ctx(job.jobId))).json()).toEqual(job);
    expect(await (await jobsRoute.GET(new Request(`${BASE}/jobs?ids=${job.jobId}`, { headers: auth() }))).json()).toEqual({ jobs: [job] });
    expect(await (await resultsRoute.GET(new Request(`${BASE}/jobs/${job.jobId}/results`, { headers: auth() }), ctx(job.jobId))).json()).toEqual({ results: [] });
    const cancel = await cancelRoute.POST(
      new Request(`${BASE}/jobs/${job.jobId}/cancel`, { method: "POST", headers: auth(), body: JSON.stringify({ requestedBy: "stivdb@transmare.com" }) }),
      ctx(job.jobId),
    );
    expect((await cancel.json()).state).toBe("cancelled");
  });

  it("another client's job id is 404", async () => {
    const job = await newJob();
    ({ key } = await createApiKey(db, admin, { client: `c${++client}`, allowedKinds: ["coa-neutralise"] }));
    const res = await oneRoute.GET(new Request(`${BASE}/jobs/${job.jobId}`, { headers: auth() }), ctx(job.jobId));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("not_found");
  });

  it("bad JSON 400, no Idempotency-Key 400, body over 64 KB 413 (with or without Content-Length)", async () => {
    const id = randomUUID();
    expect((await (await post("{nope", { ...auth(), "idempotency-key": id })).json()).error.code).toBe("invalid_json");
    expect((await (await post(body(id), auth())).json()).error.code).toBe("missing_idempotency_key");
    const big = { ...body(id), facts: { lines: [{ lineNo: 1, itemNo: null, description: "x".repeat(70_000) }] } };
    const tooBig = await post(big, { ...auth(), "idempotency-key": id });
    expect([tooBig.status, (await tooBig.json()).error.code]).toEqual([413, "payload_too_large"]);
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(JSON.stringify(big)));
        c.close();
      },
    });
    const chunked = await jobsRoute.POST(
      new Request(`${BASE}/jobs`, { method: "POST", headers: { ...auth(), "idempotency-key": id }, body: stream, duplex: "half" } as RequestInit),
    );
    expect(chunked.status).toBe(413);
  });

  it("a __proto__ or constructor key in the body is 422 unknown_field: nothing stored, nothing polluted", async () => {
    const id = randomUUID();
    const clean = JSON.stringify(body(id));
    const cases: [string, string][] = [
      [clean.replace(/^\{/, '{"__proto__":{"polluted":true},'), "__proto__"],
      [clean.replace('"source":{', '"source":{"__proto__":{"polluted":true},'), "source.__proto__"],
      [clean.replace('{"lineNo"', '{"constructor":{"prototype":{"polluted":true}},"lineNo"'), "facts.lines.0.constructor"],
    ];
    for (const [raw, field] of cases) {
      const res = await post(raw, { ...auth(), "idempotency-key": id });
      expect([res.status, (await res.json()).error]).toEqual([422, expect.objectContaining({ code: "unknown_field", fields: [field] })]);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((await post(clean, { ...auth(), "idempotency-key": id })).status).toBe(201);
  });

  it(`more than ${MAX_READS_PER_MINUTE} reads a minute: 429 with Retry-After`, async () => {
    const url = `${BASE}/jobs?ids=${randomUUID()}`;
    for (let i = 0; i < MAX_READS_PER_MINUTE; i++) expect((await jobsRoute.GET(new Request(url, { headers: auth() }))).status).toBe(200);
    const res = await jobsRoute.GET(new Request(url, { headers: auth() }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it(`after ${MAX_REFUSED_PER_MINUTE} refused keys an address gets 429 before any lookup; others still pass (S6)`, async () => {
    const bad = { authorization: `Bearer tdc_c1_${"x".repeat(43)}`, "x-forwarded-for": "203.0.113.7" };
    const url = `${BASE}/jobs?ids=${randomUUID()}`;
    for (let i = 0; i < MAX_REFUSED_PER_MINUTE; i++) expect((await jobsRoute.GET(new Request(url, { headers: bad }))).status).toBe(401);
    expect((await jobsRoute.GET(new Request(url, { headers: bad }))).status).toBe(429);
    expect((await jobsRoute.GET(new Request(url, { headers: { ...auth(), "x-forwarded-for": "203.0.113.8" } }))).status).toBe(200);
  });

  it(`more than ${MAX_WRITES_PER_MINUTE} writes a minute (also replays and cancels): 429 (S3)`, async () => {
    const id = randomUUID();
    for (let i = 0; i < MAX_WRITES_PER_MINUTE; i++) expect((await post(body(id), { ...auth(), "idempotency-key": id })).status).toBeLessThan(300);
    expect((await post(body(id), { ...auth(), "idempotency-key": id })).status).toBe(429);
  });

  it("no APP_URL: 503, never a link made from the request's own host", async () => {
    const job = await newJob();
    delete process.env.APP_URL;
    const res = await oneRoute.GET(new Request(`${BASE}/jobs/${job.jobId}`, { headers: { ...auth(), host: "evil.example" } }), ctx(job.jobId));
    expect(res.status).toBe(503);
  });

  it("an unexpected error is 503 with the fixed text only", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const real = db;
    db = { select: () => { throw new Error("select * from secret where supplier = 'X'"); } } as unknown as Db;
    try {
      const res = await jobsRoute.GET(new Request(`${BASE}/jobs?ids=${randomUUID()}`, { headers: auth() }));
      expect(res.status).toBe(503);
      expect(JSON.stringify(await res.json())).not.toContain("secret");
      expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
    } finally {
      db = real;
      spy.mockRestore();
    }
  });
});
