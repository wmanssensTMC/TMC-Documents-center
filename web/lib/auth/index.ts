// The only auth entry point pages and API routes use. In phase 4 Microsoft Entra ID
// replaces signIn(); getSession() and requireUser() keep the same shape.
import "server-only";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { clearFailures, isLocked, recordFailure, withSlot } from "./limiter";
import { dummyHash, verifyPassword } from "./password";
import { SESSION_COOKIE, SESSION_HOURS, decodeSession, encodeSession, type Role, type Session } from "./session";
import { findUserByEmail } from "./users";

export type { Role, Session };

const RANK: Record<Role, number> = { user: 1, approver: 2, admin: 3 };

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return decodeSession(store.get(SESSION_COOKIE)?.value);
}

export type CurrentUser = Session & { mustChangePassword: boolean; source: "db" | "env" };

/**
 * The logged-in user as the database knows them now (role changes and deactivation count
 * immediately, not after the 12 h cookie expires). Null when not logged in or no longer active.
 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const session = await getSession();
  if (!session) return null;
  const user = await findUserByEmail(session.email);
  if (!user) return null;
  return { email: user.email, name: user.name, role: user.role, mustChangePassword: user.mustChangePassword, source: user.source };
});

export function hasRole(user: Pick<Session, "role">, minRole: Role) {
  return (RANK[user.role] ?? 0) >= RANK[minRole];
}

/** Use at the top of every page and server action. Redirects to /login when needed. */
export async function requireUser(minRole: Role = "user", opts: { allowPasswordChange?: boolean } = {}): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.mustChangePassword && !opts.allowPasswordChange) redirect("/account/password");
  if (!hasRole(user, minRole)) redirect("/");
  return user;
}

/** For API route handlers: the user, or null (the handler answers 401/403). */
export async function apiUser(minRole: Role = "user"): Promise<CurrentUser | null> {
  const user = await getCurrentUser();
  if (!user || user.mustChangePassword || !hasRole(user, minRole)) return null;
  return user;
}

export type SignInResult = "ok" | "must_change" | "invalid" | "locked" | "busy";

/** "invalid" for an unknown user or a wrong password (same answer for both). */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  const ip = (await headers()).get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const key = `${ip}|${email.trim().toLowerCase()}`;
  if (isLocked(key)) return "locked";

  const user = await findUserByEmail(email);
  // Always run one scrypt, so an unknown e-mail takes as long as a wrong password.
  const ok = await withSlot(async () => verifyPassword(password, user?.passwordHash ?? (await dummyHash())));
  if (ok === null) return "busy";
  if (!user || !ok) {
    recordFailure(key);
    console.warn("login_failed", { at: new Date().toISOString() });
    return "invalid";
  }
  clearFailures(key);
  const token = await encodeSession({ email: user.email, name: user.name, role: user.role });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
  return user.mustChangePassword ? "must_change" : "ok";
}

export async function signOut() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
