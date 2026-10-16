// User store. Phase 0: one admin from env vars. Phase 1 moves users and roles to the database
// (Settings screen); only this file changes.
import "server-only";
import type { Role } from "./session";

export type StoredUser = {
  email: string;
  name: string;
  role: Role;
  passwordHash: string;
};

export async function findUserByEmail(email: string): Promise<StoredUser | null> {
  const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const passwordHash = process.env.ADMIN_PASSWORD_HASH?.trim();
  if (!adminEmail || !passwordHash) return null;
  if (email.trim().toLowerCase() !== adminEmail) return null;
  return {
    email: adminEmail,
    name: process.env.ADMIN_NAME?.trim() || adminEmail,
    role: "admin",
    passwordHash,
  };
}
