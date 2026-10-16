// The only auth entry point pages and API routes use. In phase 4 Microsoft Entra ID
// replaces signIn(); getSession() and requireUser() keep the same shape.
import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { verifyPassword } from "./password";
import { SESSION_COOKIE, SESSION_HOURS, decodeSession, encodeSession, type Role, type Session } from "./session";
import { findUserByEmail } from "./users";

export type { Role, Session };

const RANK: Record<Role, number> = { user: 1, approver: 2, admin: 3 };

export async function getSession(): Promise<Session | null> {
  const store = await cookies();
  return decodeSession(store.get(SESSION_COOKIE)?.value);
}

/** Use at the top of every page, server action and API route. Redirects to /login when needed. */
export async function requireUser(minRole: Role = "user"): Promise<Session> {
  const session = await getSession();
  if (!session) redirect("/login");
  if (RANK[session.role] < RANK[minRole]) redirect("/");
  return session;
}

/** Returns false for an unknown user or wrong password (same answer for both). */
export async function signIn(email: string, password: string): Promise<boolean> {
  const user = await findUserByEmail(email);
  const ok = user ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !ok) return false;
  const token = await encodeSession({ email: user.email, name: user.name, role: user.role });
  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_HOURS * 3600,
  });
  return true;
}

export async function signOut() {
  const store = await cookies();
  store.delete(SESSION_COOKIE);
}
