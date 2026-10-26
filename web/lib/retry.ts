/** One retry after a short pause: the first request after a quiet spell sometimes fails while
 * the database or file storage wakes up (26/10/2026, first live run: a 500 on the original).
 * The first failure is logged with its error name only, never a key or address (review R2). */
export async function twice<T>(fn: () => Promise<T>, pauseMs = 800): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    console.warn("retrying once after", err instanceof Error ? err.name : typeof err);
    await new Promise((r) => setTimeout(r, pauseMs));
    return fn();
  }
}
