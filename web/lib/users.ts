// Users and roles (Settings screen). Admin-only actions; callers check the role.
import "server-only";
import { asc, eq } from "drizzle-orm";
import { z } from "zod";
import { logAudit, type Actor } from "./audit";
import { hashPassword, verifyPassword } from "./auth/password";
import type { Db } from "./db";
import { ROLES, users } from "./db/schema";

export class UserError extends Error {}

const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const password = z.string().min(12, "password needs at least 12 characters").max(256);

const newUser = z.object({
  email,
  name: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .refine((s) => !/[\u0000-\u001f\u007f]/.test(s)),
  role: z.enum(ROLES),
  password,
});

function check<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) throw new UserError(r.error.issues.map((i) => i.message).join("; "));
  return r.data;
}

export async function findUserByEmail(db: Db, address: string) {
  const [row] = await db.select().from(users).where(eq(users.email, address.trim().toLowerCase()));
  return row ?? null;
}

export async function listUsers(db: Db) {
  return db
    .select({ id: users.id, email: users.email, name: users.name, role: users.role, active: users.active, mustChangePassword: users.mustChangePassword, createdAt: users.createdAt })
    .from(users)
    .orderBy(asc(users.name));
}

export async function createUser(db: Db, actor: Actor, raw: unknown) {
  const u = check(newUser, raw);
  if (await findUserByEmail(db, u.email)) throw new UserError("a user with this e-mail already exists");
  const [row] = await db
    .insert(users)
    .values({ email: u.email, name: u.name, role: u.role, passwordHash: await hashPassword(u.password), mustChangePassword: true })
    .returning({ id: users.id });
  await logAudit(db, actor, "user.created", null, { user: u.email, role: u.role });
  return row.id;
}

export async function updateUser(db: Db, actor: Actor, id: string, raw: unknown) {
  const change = check(z.object({ role: z.enum(ROLES).optional(), active: z.boolean().optional() }), raw);
  const [target] = await db.select().from(users).where(eq(users.id, check(z.uuid(), id)));
  if (!target) throw new UserError("user not found");
  if (target.email === actor.email && (change.active === false || (change.role && change.role !== "admin"))) {
    throw new UserError("you cannot remove your own admin access");
  }
  await db.update(users).set({ ...change, updatedAt: new Date() }).where(eq(users.id, target.id));
  await logAudit(db, actor, "user.updated", null, { user: target.email, ...change });
}

export async function resetPassword(db: Db, actor: Actor, id: string, tempPassword: unknown) {
  const pw = check(password, tempPassword);
  const [target] = await db.select().from(users).where(eq(users.id, check(z.uuid(), id)));
  if (!target) throw new UserError("user not found");
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(pw), mustChangePassword: true, updatedAt: new Date() })
    .where(eq(users.id, target.id));
  await logAudit(db, actor, "user.password_reset", null, { user: target.email });
}

export async function changeOwnPassword(db: Db, actor: Actor, current: unknown, next: unknown) {
  const user = await findUserByEmail(db, actor.email);
  if (!user) throw new UserError("this account's password is set by the administrator");
  const pw = check(password, next);
  if (!(await verifyPassword(String(current ?? ""), user.passwordHash))) throw new UserError("current password is not correct");
  if (pw === current) throw new UserError("choose a different password");
  await db
    .update(users)
    .set({ passwordHash: await hashPassword(pw), mustChangePassword: false, updatedAt: new Date() })
    .where(eq(users.id, user.id));
  await logAudit(db, actor, "user.password_changed", null, {});
}
