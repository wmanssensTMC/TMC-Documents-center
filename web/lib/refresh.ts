export const SLOWER_AFTER_MS = 2 * 60 * 1000;
export const STOP_AFTER_MS = 30 * 60 * 1000;

/** One tick of the jobs page auto-refresh, `ageMs` after it started: null = stop for good,
 * else whether to reload now (only when the tab is visible) and how long to wait for the next
 * tick (every `seconds` at first, at least 30 seconds after two minutes). */
export function refreshStep(ageMs: number, seconds: number, visible: boolean): { refresh: boolean; nextMs: number } | null {
  if (ageMs > STOP_AFTER_MS) return null;
  return { refresh: visible, nextMs: (ageMs > SLOWER_AFTER_MS ? Math.max(seconds, 30) : seconds) * 1000 };
}
