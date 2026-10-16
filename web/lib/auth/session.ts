// Signed session cookie (stateless). Safe to import from proxy.ts: no Node-only APIs.
import { SignJWT, jwtVerify } from "jose";

export type Role = "admin" | "approver" | "user";

export type Session = {
  email: string;
  name: string;
  role: Role;
};

export const SESSION_COOKIE = "tmc_session";
export const SESSION_HOURS = 12;

function key() {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("AUTH_SECRET is missing or shorter than 32 characters");
  }
  return new TextEncoder().encode(secret);
}

export async function encodeSession(session: Session) {
  return new SignJWT(session)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_HOURS}h`)
    .sign(key());
}

export async function decodeSession(token: string | undefined): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, key(), { algorithms: ["HS256"] });
    const { email, name, role } = payload as Partial<Session>;
    if (!email || !name || !role) return null;
    return { email, name, role };
  } catch {
    return null;
  }
}
