// Password hashing with Node's built-in scrypt.
// Stored format: scrypt:<N>:<r>:<p>:<salt base64url>:<hash base64url>
// (no "$", so it is safe in .env files; cost is stored so it can be raised later).
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEYLEN = 64;
const COST = { N: 2 ** 17, r: 8, p: 1 };

type Cost = typeof COST;

function derive(password: string, salt: Buffer, cost: Cost): Promise<Buffer> {
  const maxmem = 256 * cost.N * cost.r; // scrypt needs ~128*N*r bytes
  return new Promise((resolve, reject) =>
    scrypt(password, salt, KEYLEN, { ...cost, maxmem }, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const hash = await derive(password, salt, COST);
  return `scrypt:${COST.N}:${COST.r}:${COST.p}:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

export async function verifyPassword(password: string, stored: string) {
  const [scheme, n, r, p, salt, hash] = stored.split(":");
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (scheme !== "scrypt" || !salt || !hash || !Object.values(cost).every((v) => Number.isInteger(v) && v > 0)) {
    return false;
  }
  const expected = Buffer.from(hash, "base64url");
  const actual = await derive(password, Buffer.from(salt, "base64url"), cost);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Used when the e-mail is unknown, so both cases take the same time.
let dummy: Promise<string> | undefined;
export function dummyHash() {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  return dummy;
}
