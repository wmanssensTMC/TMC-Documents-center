import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { logAudit } from "../lib/audit";
import { createPgliteDb, type Db } from "../lib/db";
import { auditLog, type Job } from "../lib/db/schema";
import { AI_USED, aiEngineEnv, callsToday, engineAi, logAiUsage, readAiUsage } from "./ai";
import { cleanLog } from "./engine";

let db: Db;
beforeEach(async () => {
  db = await createPgliteDb();
});

const job = { id: "11111111-1111-4111-8111-111111111111", createdBy: "wilman@transmare.com" } as Job;
const on = { AI_READER: "on", ANTHROPIC_API_KEY: "sk-ant-test-key-123456" };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), "tmc-ai-"));

describe("AI reader environment for the engine (27/10)", () => {
  it("is empty when off, or on without a key", async () => {
    expect(await aiEngineEnv(db, {})).toEqual({});
    expect(await aiEngineEnv(db, { AI_READER: "on" })).toEqual({});
    expect(await aiEngineEnv(db, { AI_READER: "off", ANTHROPIC_API_KEY: "x" })).toEqual({});
  });

  it("passes only the AI reader's own variables", async () => {
    const env = await aiEngineEnv(db, { ...on, ANTHROPIC_BASE_URL: "http://evil", DATABASE_URL: "postgres://x", AI_READER_MODEL: "claude-opus-5-5" });
    expect(env).toEqual({ ...on, AI_READER_MODEL: "claude-opus-5-5", AI_READER_MAX_CALLS: "3" });
  });

  it("stops at the daily limit and never asks for more than is left today", async () => {
    await logAudit(db, { email: job.createdBy }, AI_USED, null, { calls: 28 });
    expect(await callsToday(db)).toBe(28);
    expect((await aiEngineEnv(db, { ...on, AI_READER_DAILY_CALLS: "30" })).AI_READER_MAX_CALLS).toBe("2");
    await logAudit(db, { email: job.createdBy }, AI_USED, null, { calls: 2 });
    expect(await aiEngineEnv(db, { ...on, AI_READER_DAILY_CALLS: "30" })).toEqual({});
  });
});

describe("AI usage from the engine", () => {
  it("reads ai_usage.json defensively: numbers and a short model name only", async () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, "ai_usage.json"),
      JSON.stringify([
        { model: "claude-opus-5-5", input_tokens: 5000, output_tokens: 800, usd: 0.036, accepted: 2, dropped: 1 },
        { model: "<script>", input_tokens: -5, output_tokens: "many", usd: "free" },
      ]),
    );
    const usage = await readAiUsage(dir);
    expect(usage[0]).toEqual({ model: "claude-opus-5-5", input_tokens: 5000, output_tokens: 800, usd: 0.036, accepted: 2, dropped: 1 });
    expect(usage[1]).toEqual({ model: "unknown", input_tokens: 0, output_tokens: 0, usd: null, accepted: 0, dropped: 0 });
    const bad = tmp();
    writeFileSync(path.join(bad, "ai_usage.json"), "not json");
    expect(await readAiUsage(bad)).toEqual([]);
    expect(await readAiUsage(tmp())).toEqual([]);
  });

  it("writes one audit row per run with the sums, none without calls", async () => {
    await logAiUsage(db, job, []);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, AI_USED))).toHaveLength(0);
    const u = { model: "claude-opus-5-5", input_tokens: 1000, output_tokens: 100, usd: 0.006, accepted: 1, dropped: 0 };
    await logAiUsage(db, job, [u, { ...u, usd: 0.006, dropped: 2 }]);
    const [row] = await db.select().from(auditLog).where(eq(auditLog.action, AI_USED));
    expect(row.details).toMatchObject({ job: job.id, calls: 2, input_tokens: 2000, output_tokens: 200, usd: 0.012, accepted: 2, dropped: 2 });
    expect(await callsToday(db)).toBe(2);
  });

  it("reads what the AI reader proposed for a draft, nothing else", async () => {
    const dir = tmp();
    writeFileSync(
      path.join(dir, "D.meta.json"),
      JSON.stringify({ batch: "", ai: { fields: { fabricagedatum: "02.09.2026", other: "x", lot: 5 }, rows: ["Solubility", 7] } }),
    );
    expect(await engineAi(dir, "D")).toEqual({ fields: { fabricagedatum: "02.09.2026" }, rows: ["Solubility"] });
    writeFileSync(path.join(dir, "E.meta.json"), JSON.stringify({ batch: "L-1" }));
    expect(await engineAi(dir, "E")).toBeNull();
  });
});

describe("worker log", () => {
  it("never shows the AI reader's key", () => {
    const old = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = on.ANTHROPIC_API_KEY;
    try {
      expect(cleanLog(`failed with ${on.ANTHROPIC_API_KEY}`, "/nowhere")).toBe("failed with <key>");
    } finally {
      if (old === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = old;
    }
  });
});
