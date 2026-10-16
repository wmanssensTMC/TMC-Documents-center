// Login brake inside the app, per server instance. The real rate limit is a Vercel Firewall
// rule on POST /login; this is the fallback so guessing stays slow and cheap without it.
import "server-only";

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;
const MAX_CONCURRENT = 2; // each check costs ~128 MB of scrypt memory
const MAX_KEYS = 10_000;

const fails = new Map<string, { count: number; until: number }>();
let running = 0;

export function isLocked(key: string) {
  const entry = fails.get(key);
  if (!entry) return false;
  if (Date.now() > entry.until) {
    fails.delete(key);
    return false;
  }
  return entry.count >= MAX_FAILS;
}

export function recordFailure(key: string) {
  const now = Date.now();
  const entry = fails.get(key);
  if (!entry || now > entry.until) {
    if (fails.size >= MAX_KEYS) fails.clear();
    fails.set(key, { count: 1, until: now + WINDOW_MS });
  } else {
    entry.count++;
  }
}

export function clearFailures(key: string) {
  fails.delete(key);
}

/** Runs fn when a slot is free; returns null straight away when all slots are busy. */
export async function withSlot<T>(fn: () => Promise<T>): Promise<T | null> {
  if (running >= MAX_CONCURRENT) return null;
  running++;
  try {
    return await fn();
  } finally {
    running--;
  }
}
