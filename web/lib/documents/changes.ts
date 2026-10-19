// Changes made in the on-screen editor (Willem 19/10): the worker compares the edited Word file
// with the engine's draft and the supplier original. A change that brings in words or numbers
// not found in the original is a warning; the person may confirm it and go on.

/** Marks the log line that carries the change warnings for the check screen. */
export const CHANGES_MARK = "[changes-check] ";

export type Change = { before: string; after: string; unknown: string[] };

const text = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : "");

/** A list of changes from yellow.py changes (or from a job log), checked and capped. */
export function parseChanges(json: string): Change[] {
  const raw = JSON.parse(json) as unknown;
  if (!Array.isArray(raw)) throw new Error("changes list is not a list");
  return raw.slice(0, 200).map((c) => {
    const o = (c ?? {}) as Record<string, unknown>;
    const unknown = Array.isArray(o.unknown)
      ? o.unknown.filter((w): w is string => typeof w === "string").slice(0, 20).map((w) => w.slice(0, 60))
      : [];
    return { before: text(o.before, 500), after: text(o.after, 500), unknown };
  });
}

/** The warnings of a finalise attempt that stopped for them, or null. */
export function changeWarnings(log: string | null | undefined): Change[] | null {
  const line = (log ?? "").split("\n").find((l) => l.startsWith(CHANGES_MARK));
  if (!line) return null;
  try {
    return parseChanges(line.slice(CHANGES_MARK.length));
  } catch {
    return null;
  }
}
