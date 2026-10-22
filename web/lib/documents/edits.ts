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
  /** letter size in points (Willem 22/10); left out = as in the draft */
  size: z
    .number()
    .min(4)
    .max(96)
    .refine((n) => Number.isInteger(n * 2), "letter size in half points")
    .optional(),
});
const pieces = z.array(piece).min(1).max(50);

// Rows and columns (Willem 22/10), in the order the person made them; positions count the rows
// and grid columns as they are at that moment. A new cell gets an id (n0..) for the text typed
// in it; null marks a row whose merged cell only grows with the new column.
const at = z.number().int().min(0).max(1000);
const newId = z.string().regex(/^n\d{1,5}$/);
export const tableOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("addRow"), at, from: at, ids: z.array(newId).min(1).max(64) }),
  z.object({ op: z.literal("delRow"), at }),
  z.object({ op: z.literal("addCol"), at, ids: z.array(newId.nullable()).min(1).max(1000) }),
  z.object({ op: z.literal("delCol"), at }),
]);
export const ALIGNS = ["left", "center", "right", "justify"] as const;

export const editsInput = z
  .object({
    runs: z.array(z.object({ id: z.string().regex(/^r\d{1,6}$/), was: z.string().max(20000), parts: pieces })).max(5000),
    paras: z.array(z.object({ id: z.string().regex(/^p\d{1,6}$/), parts: pieces })).max(5000),
    layout: z.array(z.object({ id: z.string().regex(/^p\d{1,6}$/), align: z.enum(ALIGNS) })).max(5000).default([]),
    tables: z.array(z.object({ id: z.string().regex(/^t\d{1,5}$/), ops: z.array(tableOp).min(1).max(200) })).max(500).default([]),
    cells: z.array(z.object({ id: newId, parts: pieces })).max(5000).default([]),
  })
  .refine((e) => e.runs.length + e.paras.length + e.layout.length + e.tables.length + e.cells.length <= 5000, "too many changes")
  .refine(
    (e) => [...e.runs, ...e.paras, ...e.cells].reduce((n, x) => n + x.parts.reduce((m, p) => m + p.text.length, 0), 0) <= 300_000,
    "the changes are too long",
  )
  .refine((e) => new Set([...e.runs, ...e.paras].map((x) => x.id)).size === e.runs.length + e.paras.length, "a piece is changed twice")
  .refine((e) => new Set(e.cells.map((x) => x.id)).size === e.cells.length, "a new cell is changed twice")
  .refine((e) => new Set(e.layout.map((x) => x.id)).size === e.layout.length, "a paragraph is aligned twice")
  .refine((e) => new Set(e.tables.map((x) => x.id)).size === e.tables.length, "a table is listed twice")
  // limits for the worker (review L4): rows and columns changed, and new cells made
  .refine((e) => e.tables.reduce((n, t) => n + t.ops.length, 0) <= 500, "too many table changes")
  .refine((e) => e.tables.reduce((n, t) => n + t.ops.reduce((m, o) => m + ("ids" in o ? o.ids.length : 0), 0), 0) <= 5000, "too many new cells");

export type Piece = z.infer<typeof piece>;
export type TableOp = z.infer<typeof tableOp>;
export type Edits = z.infer<typeof editsInput>;

/** Same changes, whatever order the database gave the keys back in (a confirmation covers only what was shown). */
export function sameEdits(a: unknown, b: unknown): boolean {
  const x = editsInput.safeParse(a);
  const y = editsInput.safeParse(b);
  return x.success && y.success && JSON.stringify(x.data) === JSON.stringify(y.data);
}
