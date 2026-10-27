// AI reader in the neutralise job (27/10): what the engine gets, and that every call is counted,
// also when the job fails. The engine process is the only thing replaced (it is the worker's
// boundary): no Python, no network, never a real API call.
import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logAudit, type Actor } from "../lib/audit";
import { createPgliteDb, type Db } from "../lib/db";
import { auditLog, jobs } from "../lib/db/schema";
import { newUploadKey } from "../lib/files";
import { createJobs } from "../lib/jobs";
import { claimNextJob } from "../lib/jobs/worker-state";
import { localStorage, type Storage } from "../lib/storage";
import { AI_USED, callsToday } from "./ai";

type Seen = { env: Record<string, string>; forbid: unknown };
const engine = vi.hoisted(() => ({ seen: [] as Seen[], code: 1, usage: null as unknown[] | null, throw: "" }));

vi.mock("./engine", async (importOriginal) => {
  const real = await importOriginal<typeof import("./engine")>();
  return {
    ...real,
    runPython: async (argv: string[], _dir: string, opts: { env?: Record<string, string> } = {}) => {
      const env = opts.env ?? {};
      const forbid = env.AI_READER_FORBID ? JSON.parse(await readFile(env.AI_READER_FORBID, "utf8")) : null;
      engine.seen.push({ env, forbid });
      if (engine.throw) throw new Error(engine.throw);
      const out = argv.find((a) => a.startsWith("--output-dir="))?.slice("--output-dir=".length);
      if (out && engine.usage) await writeFile(path.join(out, "ai_usage.json"), JSON.stringify(engine.usage), "utf8");
      return { code: engine.code, log: "engine stopped", stdout: "" };
    },
  };
});

const { processNeutraliseJob } = await import("./process");

const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
const willem: Actor = { email: "wilman@transmare.com", name: "Willem", role: "admin" };
const KEY = "sk-ant-test-key-123456";
const AI_VARS = ["AI_READER", "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "AI_READER_DAILY_CALLS", "AI_READER_MAX_CALLS"];
const usage = { model: "claude-opus-5-5", input_tokens: 5000, output_tokens: 800, usd: 0.036, accepted: 1, dropped: 0 };

let db: Db;
let storage: Storage;
let saved: Record<string, string | undefined>;

beforeEach(async () => {
  db = await createPgliteDb();
  storage = localStorage(mkdtempSync(path.join(os.tmpdir(), "tmc-store-")));
  saved = Object.fromEntries(AI_VARS.map((k) => [k, process.env[k]]));
  for (const k of AI_VARS) delete process.env[k];
  engine.seen = [];
  engine.code = 1;
  engine.usage = null;
  engine.throw = "";
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** supplierName null: the field is left out, as when nobody typed it. */
async function runJob(supplierName: string | null = "ACME Chemicals GmbH") {
  const key = newUploadKey("input");
  await storage.put(key, PDF, "application/pdf");
  await createJobs(db, storage, willem, [
    {
      route: "coa",
      entity: "TMC",
      productName: "Sodium Benzoate",
      fileNr: "840.S0999",
      ...(supplierName === null ? {} : { supplierName }),
      supplierFile: { key, filename: "coa.pdf" },
    },
  ]);
  const job = (await claimNextJob(db))!;
  await processNeutraliseJob(db, storage, job);
  return job;
}

describe("AI reader in the neutralise job", () => {
  it("off: the engine gets no AI variable and no block list", async () => {
    process.env.ANTHROPIC_API_KEY = KEY; // a key alone does not switch it on
    await runJob();
    expect(engine.seen).toHaveLength(1);
    expect(engine.seen[0].env).toEqual({});
  });

  it("on: only the AI reader's variables, the typed supplier name as block list, never ANTHROPIC_BASE_URL", async () => {
    Object.assign(process.env, { AI_READER: "on", ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: "http://evil.example" });
    await runJob("  ACME Chemicals GmbH ");
    const { env, forbid } = engine.seen[0];
    expect(Object.keys(env).sort()).toEqual([
      "AI_READER",
      "AI_READER_FORBID",
      "AI_READER_MAX_CALLS",
      "AI_READER_SOURCES",
      "ANTHROPIC_API_KEY",
    ]);
    expect(forbid).toEqual(["ACME Chemicals GmbH"]);
  });

  it("names only the supplier upload as a file the AI may read, never a commercial document (F1)", async () => {
    Object.assign(process.env, { AI_READER: "on", ANTHROPIC_API_KEY: KEY });
    await runJob();
    const sources = engine.seen[0].env.AI_READER_SOURCES;
    expect(sources).toMatch(/[\\/]in[\\/]00_coa\.pdf$/);
    expect(sources.split(path.delimiter)).toHaveLength(1);
  });

  it("on without a typed supplier name: no block list file", async () => {
    Object.assign(process.env, { AI_READER: "on", ANTHROPIC_API_KEY: KEY });
    await runJob(null);
    expect(engine.seen[0].env.AI_READER_FORBID).toBeUndefined();
  });

  it("a job that fails after AI calls still counts them toward today's limit", async () => {
    Object.assign(process.env, { AI_READER: "on", ANTHROPIC_API_KEY: KEY, AI_READER_DAILY_CALLS: "3" });
    engine.code = 1;
    engine.usage = [usage, usage];
    await runJob();
    expect((await db.select().from(jobs))[0].state).toBe("failed");
    const rows = await db.select().from(auditLog).where(eq(auditLog.action, AI_USED));
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ calls: 2, input_tokens: 10000 });
    expect(await callsToday(db)).toBe(2);
    // the next run gets only what is left today
    await runJob();
    expect(engine.seen[1].env.AI_READER_MAX_CALLS).toBe("1");
  });

  it("over today's limit: the engine runs without the AI reader", async () => {
    Object.assign(process.env, { AI_READER: "on", ANTHROPIC_API_KEY: KEY, AI_READER_DAILY_CALLS: "2" });
    await logAudit(db, willem, AI_USED, null, { calls: 2 });
    await runJob();
    expect(engine.seen[0].env).toEqual({});
  });

  it("an error carrying the key never puts it in the job log", async () => {
    Object.assign(process.env, { AI_READER: "on", ANTHROPIC_API_KEY: KEY });
    engine.throw = `401 invalid x-api-key ${KEY}`;
    await runJob();
    const [j] = await db.select().from(jobs);
    expect(j.state).toBe("failed");
    expect(j.log ?? "").toContain("<key>");
    expect(j.log ?? "").not.toContain(KEY);
  });
});
