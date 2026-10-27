// The shell around every /api/v1 route (contract sections 3, 10, 11): the switch, the key, the
// read limit, the body limit and the fixed error body. The login filter (proxy.ts) skips /api,
// so each route checks the key here itself.
import "server-only";
import { getDb, type Db } from "../db";
import { ApiError } from "./errors";
import { authenticate, type ApiCaller } from "./keys";

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_READS_PER_MINUTE = 120;

export const apiEnabled = () => process.env.API_CLIENTS_ENABLED === "on";

const HEADERS = { "cache-control": "no-store", "x-content-type-options": "nosniff" };

export function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...HEADERS, ...extra } });
}

// Reads per key and minute, per server instance (Vercel may run a few: approximate, Willem 27/10).
// Creates and open requests are counted exactly in the database (lib/api/requests.ts).
const reads = new Map<string, { start: number; n: number }>();

export function takeRead(client: string, now = Date.now()): number | null {
  const w = reads.get(client);
  if (!w || now - w.start >= 60_000) {
    if (reads.size >= 1000) reads.clear();
    reads.set(client, { start: now, n: 1 });
    return null;
  }
  if (w.n >= MAX_READS_PER_MINUTE) return Math.ceil((w.start + 60_000 - now) / 1000);
  w.n++;
  return null;
}

/** The body as JSON, at most 64 KB (also without a Content-Length header). */
export async function readJson(req: Request): Promise<unknown> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) throw new ApiError("payload_too_large");
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (req.body) {
    const reader = req.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new ApiError("payload_too_large");
      }
      chunks.push(value);
    }
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new ApiError("invalid_json");
  }
}

type Handler = (ctx: { db: Db; caller: ApiCaller }) => Promise<Response>;

/** Runs a handler for a valid key. `create` calls are limited in the database, reads here. */
export async function withApiKey(req: Request, mode: "read" | "create", handler: Handler): Promise<Response> {
  try {
    if (!apiEnabled()) throw new ApiError("unavailable");
    const db = await getDb();
    const caller = await authenticate(db, req.headers.get("authorization"));
    if (!caller) throw new ApiError("unauthorized");
    if (mode === "read") {
      const wait = takeRead(caller.client);
      if (wait !== null) throw new ApiError("rate_limited", [], wait);
    }
    return await handler({ db, caller });
  } catch (err) {
    if (err instanceof ApiError) {
      return json(err.body(), err.status, err.retryAfter ? { "retry-after": String(err.retryAfter) } : {});
    }
    // the error name only: never a query, a value or a stack in the log or the answer
    console.error("api v1 failed:", err instanceof Error ? err.name : typeof err);
    return json(new ApiError("unavailable").body(), 503);
  }
}
