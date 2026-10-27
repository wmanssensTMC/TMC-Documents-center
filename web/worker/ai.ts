// AI reader (Willem 27/10/2026): the engine may ask Claude about the parts its rules are unsure of.
// Off unless AI_READER=on on the worker. Only these variables reach the engine, and only on the
// neutralise run; a daily limit of calls is counted from the audit trail (failed jobs count too).
// The engine writes out/ai_usage.json (counts and cost only); it becomes one "ai.used" audit row.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { and, eq, gte, sql } from "drizzle-orm";
import { logAudit } from "../lib/audit";
import type { Db } from "../lib/db";
import { auditLog, type Job } from "../lib/db/schema";

/** Passed to the engine when on: nothing else (never ANTHROPIC_BASE_URL or other secrets). */
const PASS = [
  "AI_READER",
  "ANTHROPIC_API_KEY",
  "AI_READER_MODEL",
  "AI_READER_EFFORT",
  "AI_READER_MAX_CALLS",
  "AI_READER_TIMEOUT_S",
  "AI_READER_PROVIDER",
  "AI_READER_FOUNDRY_RESOURCE",
] as const;
export const AI_USED = "ai.used";
const DEFAULT_DAILY = 30; // start value for the measurement (Willem 27/10)
const DEFAULT_PER_RUN = 3;
const MAX_ENTRIES = 20;

type Env = Record<string, string | undefined>;

export function aiOn(env: Env = process.env) {
  return (env.AI_READER ?? "").trim().toLowerCase() === "on" && !!(env.ANTHROPIC_API_KEY ?? "").trim();
}

export function dailyLimit(env: Env = process.env) {
  const n = Number(env.AI_READER_DAILY_CALLS ?? DEFAULT_DAILY);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DAILY;
}

/** AI calls made today, from the audit trail. */
export async function callsToday(db: Db): Promise<number> {
  const [row] = await db
    .select({ calls: sql<number>`coalesce(sum((${auditLog.details} ->> 'calls')::int), 0)` })
    .from(auditLog)
    .where(and(eq(auditLog.action, AI_USED), gte(auditLog.at, sql`date_trunc('day', now())`)));
  return Number(row?.calls ?? 0);
}

/** The engine's extra environment for one neutralise run: empty when off or over today's limit. */
export async function aiEngineEnv(db: Db, env: Env = process.env): Promise<Record<string, string>> {
  if (!aiOn(env)) return {};
  const left = dailyLimit(env) - (await callsToday(db));
  if (left <= 0) return {};
  const out: Record<string, string> = {};
  for (const k of PASS) {
    const v = env[k];
    if (v) out[k] = v;
  }
  const perRun = Math.floor(Number(out.AI_READER_MAX_CALLS ?? DEFAULT_PER_RUN)) || DEFAULT_PER_RUN;
  out.AI_READER_MAX_CALLS = String(Math.max(0, Math.min(perRun, left)));
  return out;
}

export type AiUsage = { model: string; input_tokens: number; output_tokens: number; usd: number | null; accepted: number; dropped: number };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);

/** out/ai_usage.json, read defensively: numbers and a short model name only. */
export async function readAiUsage(outDir: string): Promise<AiUsage[]> {
  const raw = await readFile(path.join(outDir, "ai_usage.json"), "utf8").catch(() => null);
  if (!raw) return [];
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_ENTRIES).map((e) => {
    const o = (e && typeof e === "object" ? e : {}) as Record<string, unknown>;
    const model = typeof o.model === "string" && /^[\w.-]{1,60}$/.test(o.model) ? o.model : "unknown";
    return {
      model,
      input_tokens: num(o.input_tokens),
      output_tokens: num(o.output_tokens),
      usd: typeof o.usd === "number" && Number.isFinite(o.usd) ? o.usd : null,
      accepted: num(o.accepted),
      dropped: num(o.dropped),
    };
  });
}

/** One audit row per run that called the AI reader, also when the job fails afterwards. */
export async function logAiUsage(db: Db, job: Job, usage: AiUsage[]) {
  if (!usage.length) return;
  const sum = (k: "input_tokens" | "output_tokens" | "accepted" | "dropped") => usage.reduce((s, u) => s + u[k], 0);
  const priced = usage.every((u) => u.usd !== null);
  await logAudit(db, { email: job.createdBy }, AI_USED, null, {
    job: job.id,
    calls: usage.length,
    model: usage[0].model,
    input_tokens: sum("input_tokens"),
    output_tokens: sum("output_tokens"),
    usd: priced ? Math.round(usage.reduce((s, u) => s + (u.usd ?? 0), 0) * 10000) / 10000 : null,
    accepted: sum("accepted"),
    dropped: sum("dropped"),
  });
}

export type AiProposed = { fields: Record<string, string>; rows: string[] };
const FIELD_KEYS = ["lot", "fabricagedatum", "vervaldatum"];

/** What the AI reader proposed for one draft (meta.json "ai"), for the audit and feedback. */
export async function engineAi(outDir: string, stem: string): Promise<AiProposed | null> {
  const raw = await readFile(path.join(outDir, `${stem}.meta.json`), "utf8").catch(() => null);
  if (!raw) return null;
  let ai: unknown;
  try {
    ai = (JSON.parse(raw) as { ai?: unknown }).ai;
  } catch {
    return null;
  }
  if (!ai || typeof ai !== "object") return null;
  const o = ai as { fields?: unknown; rows?: unknown };
  const fields: Record<string, string> = {};
  if (o.fields && typeof o.fields === "object") {
    for (const k of FIELD_KEYS) {
      const v = (o.fields as Record<string, unknown>)[k];
      if (typeof v === "string" && v.length <= 200) fields[k] = v;
    }
  }
  const rows = Array.isArray(o.rows) ? o.rows.filter((r): r is string => typeof r === "string" && r.length <= 200).slice(0, 60) : [];
  return Object.keys(fields).length || rows.length ? { fields, rows } : null;
}
