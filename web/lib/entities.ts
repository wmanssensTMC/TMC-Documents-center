// Entity records (name, address, phone ...) that the engine prints on TMC documents.
// Only an admin enters them; nothing is ever filled in by guess (BRIEF 6, ENGINE.md).
import "server-only";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { logAudit, type Actor } from "./audit";
import type { Db } from "./db";
import { ENTITIES, entities, type Entity, type EntityRecord } from "./db/schema";

export class EntityError extends Error {}

const field = (max: number) =>
  z
    .string()
    .trim()
    .min(1, "all fields are required")
    .max(max)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s), "contains control characters");

const entityInput = z.object({
  naam: field(200),
  adres: field(300),
  telefoon: field(50),
  email: field(254),
  web: field(200),
  btw: field(50),
  nood: field(50),
});

export const ENTITY_FIELDS: { key: keyof z.infer<typeof entityInput>; label: string }[] = [
  { key: "naam", label: "Company name" },
  { key: "adres", label: "Address" },
  { key: "telefoon", label: "Telephone" },
  { key: "email", label: "E-mail" },
  { key: "web", label: "Website" },
  { key: "btw", label: "VAT number" },
  { key: "nood", label: "Emergency number (MSDS 1.4)" },
];

export async function listEntities(db: Db): Promise<EntityRecord[]> {
  return db.select().from(entities).orderBy(asc(entities.code));
}

export async function getEntity(db: Db, code: Entity): Promise<EntityRecord | null> {
  const [row] = await db.select().from(entities).where(eq(entities.code, code));
  return row ?? null;
}

/** The record as the engine expects it (engine/entity.example.json). */
export function engineEntityJson(e: EntityRecord) {
  const { code, naam, adres, telefoon, email, web, btw, nood } = e;
  return { naam, adres, telefoon, email, web, btw, nood, code };
}

export async function saveEntity(db: Db, actor: Actor, code: unknown, raw: unknown) {
  const c = ENTITIES.find((e) => e === code);
  if (!c) throw new EntityError("unknown entity");
  const r = entityInput.safeParse(raw);
  if (!r.success) throw new EntityError(r.error.issues.map((i) => i.message).join("; "));
  const values = { ...r.data, updatedBy: actor.email, updatedAt: new Date() };
  await db
    .insert(entities)
    .values({ code: c, ...values })
    .onConflictDoUpdate({ target: entities.code, set: values });
  await logAudit(db, actor, "entity.saved", null, { entity: c });
}
