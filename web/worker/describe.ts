/** An error and its causes for the worker log ("Failed query" alone hides why the database
 * refused), with any database address hidden so no password reaches the log. */
export function describe(err: unknown): string {
  const parts: string[] = [];
  for (let e = err, i = 0; e != null && i < 4; e = (e as { cause?: unknown }).cause, i++) {
    parts.push(e instanceof Error ? e.message : String(e));
  }
  return parts.join(" <- ").replace(/postgres(?:ql)?:\/\/\S+/gi, "postgresql://[hidden]");
}
