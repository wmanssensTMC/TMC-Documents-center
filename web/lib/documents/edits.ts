// What the on-screen editor sends back (own editor, Willem 20/10): only the pieces of text
// ("runs" of the Word file) that changed, each with its new text and four on/off switches. The
// worker writes them into the engine's own Word file (web/worker/yellow.py edit), so the TMC
// layout cannot break. Checked here and again in the worker.
import { z } from "zod";

/** Line breaks and tabs are text; other control characters, invisible format characters and line separators are not (review I1). */
export const SAFE_DOC_TEXT = (s: string) => !/[\u0000-\u0008\u000b-\u001f\u007f\u2028\u2029\p{Cf}]/u.test(s);

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
