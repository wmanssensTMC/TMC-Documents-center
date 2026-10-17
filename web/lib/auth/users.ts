// Who may log in. Phase 1: users in the database (Settings screen), plus the admin from
// env vars (ADMIN_EMAIL / ADMIN_PASSWORD_HASH) as the bootstrap account. A database user
// with the same e-mail takes precedence.
import "server-only";
import { getDb } from "../db";
import { findUserByEmail as findDbUser } from "../users";
import type { Role } from "./session";

export type StoredUser = {
  email: string;
  name: string;
  role: Role;
  passwordHash: string;
  mustChangePassword: boolean;
  source: "db" | "env";
};

export async function findUserByEmail(email: string): Promise<StoredUser | null> {
  const address = email.trim().toLowerCase();
  const row = await findDbUser(await getDb(), address);
  if (row) {
    if (!row.active) return null;
    return { email: row.email, name: row.name, role: row.role, passwordHash: row.passwordHash, mustChangePassword: row.mustChangePassword, source: "db" };
  }
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const passwordHash = process.env.ADMIN_PASSWORD_HASH?.trim();
  if (!adminEmail || !passwordHash || address !== adminEmail) return null;
  return { email: adminEmail, name: process.env.ADMIN_NAME?.trim() || adminEmail, role: "admin", passwordHash, mustChangePassword: false, source: "env" };
}
