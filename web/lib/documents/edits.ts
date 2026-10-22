// What the on-screen editor sends back (own editor, Willem 20/10): only the pieces of text
// ("runs" of the Word file) that changed, each with its new text and four on/off switches. The
// worker writes them into the engine's own Word file (web/worker/yellow.py edit), so the TMC
// layout cannot break. Checked here and again in the worker.
import { z } from "zod";

// Line breaks and tabs are text. Other control characters, invisible format characters, line
// separators and characters that show nothing (variation selectors, fillers) are not: they
// could split a supplier name so the check does not see it (reviews I1, M1). The worker
// refuses the same set (web/worker/yellow.py invisible).
const INVISIBLE = "(?![\\t\\n])[\\p{Cc}\\p{Cf}\\u2028\\u2029\\u034f\\u115f\\u1160\\u17b4\\u17b5\\u180b-\\u180f\\u3164\\ufe00-\\ufe0f\\uffa0\\u{e0100}-\\u{e01ef}]";
const INVISIBLE_ONE = new RegExp(INVISIBLE, "u");
const INVISIBLE_ALL = new RegExp(INVISIBLE, "gu");

export const SAFE_DOC_TEXT = (s: string) => !INVISIBLE_ONE.test(s);

/** Text as the editor keeps it: Windows line ends made plain, invisible characters dropped. */
export const cleanDocText = (s: string) => s.replace(/\r\n?/g, "\n").replace(INVISIBLE_ALL, "");

const piece = z.object({
  text: z.string().max(5000).refine(SAFE_DOC_TEXT, "contains control characters"),
  b: z.boolean(),
  i: z.boolean(),
  u: z.boolean(),
  hl: z.boolean(),
});
const pieces = z.array(piece).min(1).max(50);

export const editsInput = z
  .object({
    runs: z.array(z.object({ id: z.string().regex(/^r\d{1,6}$/), was: z.string().max(20000), parts: pieces })).max(5000),
    paras: z.array(z.object({ id: z.string().regex(/^p\d{1,6}$/), parts: pieces })).max(5000),
  })
  .refine((e) => e.runs.length + e.paras.length <= 5000, "too many changes")
  .refine(
    (e) => [...e.runs, ...e.paras].reduce((n, x) => n + x.parts.reduce((m, p) => m + p.text.length, 0), 0) <= 300_000,
    "the changes are too long",
  )
  .refine((e) => new Set([...e.runs, ...e.paras].map((x) => x.id)).size === e.runs.length + e.paras.length, "a piece is changed twice");

export type Piece = z.infer<typeof piece>;
export type Edits = z.infer<typeof editsInput>;

/** Same changes, whatever order the database gave the keys back in (a confirmation covers only what was shown). */
export function sameEdits(a: unknown, b: unknown): boolean {
  const x = editsInput.safeParse(a);
  const y = editsInput.safeParse(b);
  return x.success && y.success && JSON.stringify(x.data) === JSON.stringify(y.data);
}
