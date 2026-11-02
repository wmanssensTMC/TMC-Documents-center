// API keys of calling apps (API v1, contract section 3). A key is `tdc_<client>_<43 chars>`
// (256 random bits). Only its SHA-256 is stored; the key is shown once to the admin who makes it.
// Two active keys per client at most: current + next, so a key is rotated without downtime.
import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { logAudit, type Actor } from "../audit";
import { API_JOB_KINDS, type ApiJobKind } from "../constants";
import type { Db } from "../db";
import { apiClients } from "../db/schema";

export class ApiKeyError extends Error {}

export const MAX_ACTIVE_KEYS = 2;
const KEY = /^tdc_([a-z0-9]{2,16})_([A-Za-z0-9_-]{43})$/;

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const newKeyInput = z.strictObject({
  client: z.string().trim().regex(/^[a-z0-9]{2,16}$/, "client: 2 to 16 lower-case letters or digits, e.g. tmclog"),
  allowedKinds: z.array(z.enum(API_JOB_KINDS)).min(1, "choose at least one kind").transform((k) => [...new Set(k)]),
});

/** Makes a key. The returned key is the only time anyone sees it. */
export async function createApiKey(db: Db, admin: Actor, raw: unknown): Promise<{ id: string; key: string }> {
  const r = newKeyInput.safeParse(raw);
  if (!r.success) throw new ApiKeyError(r.error.issues.map((i) => i.message).join("; "));
  const { client, allowedKinds } = r.data;
  const key = `tdc_${client}_${randomBytes(32).toString("base64url")}`;
  const id = await db.transaction(async (tx) => {
    // one admin at a time per client, so two keys made at once cannot pass the limit together
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`api_clients:${client}`}))`);
    const [{ n }] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(apiClients)
      .where(and(eq(apiClients.client, client), eq(apiClients.active, true)));
    if (n >= MAX_ACTIVE_KEYS) throw new ApiKeyError(`${client} already has ${MAX_ACTIVE_KEYS} active keys; deactivate the old one first`);
    const [row] = await tx
      .insert(apiClients)
      .values({ client, keyHash: sha256(key), keyHint: key.slice(-4), allowedKinds, createdBy: admin.email })
      .returning({ id: apiClients.id });
    await logAudit(tx, admin, "api.key.created", null, { client, keyId: row.id, allowedKinds });
    return row.id;
  });
  return { id, key };
}

export async function deactivateApiKey(db: Db, admin: Actor, id: string) {
  if (!z.uuid().safeParse(id).success) throw new ApiKeyError("key not found");
  await db.transaction(async (tx) => {
    const [row] = await tx
      .update(apiClients)
      .set({ active: false, deactivatedBy: admin.email, deactivatedAt: new Date() })
      .where(and(eq(apiClients.id, id), eq(apiClients.active, true)))
      .returning({ client: apiClients.client });
    if (!row) throw new ApiKeyError("key not found or already deactivated");
    await logAudit(tx, admin, "api.key.deactivated", null, { client: row.client, keyId: id });
  });
}

/** For the admin page: never the hash. */
export async function listApiKeys(db: Db) {
  return db
    .select({
      id: apiClients.id,
      client: apiClients.client,
      keyHint: apiClients.keyHint,
      allowedKinds: apiClients.allowedKinds,
      active: apiClients.active,
      createdBy: apiClients.createdBy,
      createdAt: apiClients.createdAt,
      lastUsedAt: apiClients.lastUsedAt,
      deactivatedAt: apiClients.deactivatedAt,
    })
    .from(apiClients)
    .orderBy(desc(apiClients.active), asc(apiClients.client), desc(apiClients.createdAt));
}

export type ApiCaller = { client: string; keyId: string; allowedKinds: ApiJobKind[] };

// A refused key is written to the audit at most once a minute per known client (any other prefix
// counts as "unknown") and at most 20 rows a minute in all, so a flood of wrong keys cannot flood
// the append-only log (security review S2). Per server instance.
const REFUSED_PER_MINUTE = 20;
const refusedLogged = new Map<string, number>();
let refusedWindow = { start: 0, n: 0 };

async function logRefused(db: Db, prefix: string) {
  const now = Date.now();
  if (now - refusedWindow.start >= 60_000) refusedWindow = { start: now, n: 0 };
  if (refusedWindow.n >= REFUSED_PER_MINUTE) return;
  const [known] = prefix === "unknown" ? [] : await db.select({ id: apiClients.id }).from(apiClients).where(eq(apiClients.client, prefix)).limit(1);
  const client = known ? prefix : "unknown";
  if (now - (refusedLogged.get(client) ?? 0) < 60_000) return;
  refusedLogged.set(client, now); // at most the known clients plus "unknown": stays small
  refusedWindow.n++;
  await logAudit(db, { email: "api" }, "api.key.refused", null, { client });
}

/** The calling app for an `Authorization: Bearer <key>` header, or null (the route answers 401). */
export async function authenticate(db: Db, header: string | null): Promise<ApiCaller | null> {
  const key = header?.startsWith("Bearer ") ? header.slice(7) : "";
  const m = KEY.exec(key);
  if (!m) {
    if (header) await logRefused(db, "unknown");
    return null;
  }
  const hash = sha256(key);
  const [row] = await db
    .select({ id: apiClients.id, client: apiClients.client, keyHash: apiClients.keyHash, allowedKinds: apiClients.allowedKinds })
    .from(apiClients)
    .where(and(eq(apiClients.keyHash, hash), eq(apiClients.active, true)));
  const ok = !!row && row.client === m[1] && timingSafeEqual(Buffer.from(row.keyHash, "hex"), Buffer.from(hash, "hex"));
  if (!ok) {
    await logRefused(db, m[1]); // the client part only, never the key
    return null;
  }
  // "last used" for the admin page; written at most once a minute (reads are not audited)
  await db
    .update(apiClients)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(apiClients.id, row.id), or(isNull(apiClients.lastUsedAt), lt(apiClients.lastUsedAt, sql`now() - interval '1 minute'`))));
  return { client: row.client, keyId: row.id, allowedKinds: row.allowedKinds };
}
