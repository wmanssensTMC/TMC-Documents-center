// The model behind our own on-screen editor (Willem 20/10): the worker's view of the draft
// (web/worker/yellow.py view), how it is cut into editable pieces, and how the edited pieces
// are read back into the short list of changes the worker writes into the Word file.
// No browser APIs here, so it can be tested on its own.
import { cleanDocText, type Edits, type Piece, type TableOp } from "@/lib/documents/edits";

export type Fmt = { b: boolean; i: boolean; u: boolean; hl: boolean; size?: number; font?: string; color?: string };
export type RunItem = { t: "r"; id: string | null; text: string } & Fmt;
export type Item = RunItem | { t: "img"; m: string | null; w?: number; h?: number } | { t: "box"; blocks: Block[] };
export type Para = { t: "p"; id: string; items: Item[]; align?: string; before?: number; after?: number; indent?: number; empty?: boolean };
export type Cell = { blocks: Block[]; span?: number; rowspan?: number; shade?: string };
export type Table = { t: "table"; id?: string | null; plain?: boolean; cols: number[]; lines: boolean; rows: Cell[][] };
export type Block = Para | Table;
export type View = {
  v: 1;
  page: { width: number; left: number; right: number; top: number; bottom: number };
  parts: { kind: "header" | "body" | "footer"; blocks: Block[] }[];
  media: Record<string, string>;
};

/** The worker's view, lightly checked (it comes from our own worker through our own server). */
export function parseView(raw: unknown): View {
  const v = raw as View;
  if (!v || v.v !== 1 || !Array.isArray(v.parts) || typeof v.page !== "object" || typeof v.media !== "object") {
    throw new Error("not an editor view");
  }
  return v;
}

/** A size from the view, only when it is a plain number in a sensible range (review L3). */
export const dim = (x: unknown, max = 1000): number | undefined =>
  typeof x === "number" && Number.isFinite(x) && x > 0 && x < max ? x : undefined;

/** Only pictures as data of a plain image type are shown. */
export function safeImage(src: unknown): string | null {
  return typeof src === "string" && /^data:image\/(png|jpeg|gif);base64,[A-Za-z0-9+/=]+$/.test(src) ? src : null;
}

export const safeColor = (c?: string) => (c && /^#[0-9a-fA-F]{6}$/.test(c) ? c : undefined);
export const safeFont = (f?: string) => (f && /^[A-Za-z0-9 ._-]{1,40}$/.test(f) ? f : undefined);

/**
 * A paragraph is cut into editable groups (runs of text next to each other) and fixed items
 * (pictures, text boxes, text that cannot be retyped). A fixed item is never inside an editable
 * group, so it cannot be deleted by accident. A paragraph without text of its own gets one
 * empty group at its end, where typed text is added.
 */
export type Segment = { kind: "group"; key: string; runs: RunItem[]; para: string | null } | { kind: "fixed"; item: Item };

export function segments(p: Para): Segment[] {
  const out: Segment[] = [];
  let group: RunItem[] = [];
  const flush = () => {
    if (group.length) out.push({ kind: "group", key: `${p.id}:${out.length}`, runs: group, para: null });
    group = [];
  };
  for (const item of p.items) {
    if (item.t === "r" && item.id) group.push(item);
    else {
      flush();
      out.push({ kind: "fixed", item });
    }
  }
  flush();
  if (!out.some((s) => s.kind === "group")) out.push({ kind: "group", key: `${p.id}:${out.length}`, runs: [], para: p.id });
  return out;
}

/** Every editable group of the view, by key. */
export function allGroups(view: View): Map<string, Extract<Segment, { kind: "group" }>> {
  const map = new Map<string, Extract<Segment, { kind: "group" }>>();
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.t === "p") {
        for (const s of segments(b)) {
          if (s.kind === "group") map.set(s.key, s);
          else if (s.item.t === "box") walk(s.item.blocks);
        }
      } else b.rows.forEach((row) => row.forEach((cell) => walk(cell.blocks)));
    }
  };
  view.parts.forEach((part) => walk(part.blocks));
  return map;
}

const fmtOf = (r: Fmt): Omit<Piece, "text"> => ({ b: r.b, i: r.i, u: r.u, hl: r.hl, ...(dim(r.size, 97) ? { size: r.size } : {}) });

/** What a run shows when the editor opens: the draft, or the person's last edit that did not become Final. */
export function startPieces(run: RunItem, pending: Edits | null): Piece[] {
  const edit = pending?.runs.find((e) => e.id === run.id && e.was === run.text);
  return edit ? edit.parts : [{ text: run.text, ...fmtOf(run) }];
}

export function startParaPieces(para: string, pending: Edits | null): Piece[] {
  return pending?.paras.find((e) => e.id === para)?.parts ?? [];
}

// ---- reading an edited group back ----------------------------------------------------------

/** The small part of a DOM node the reader needs (a real DOM node fits; so does a test double). */
export type DomLike = {
  nodeType: number;
  nodeName: string;
  nodeValue: string | null;
  childNodes: ArrayLike<DomLike>;
  parentNode: DomLike | null;
  getAttribute?: (name: string) => string | null;
  style?: { fontWeight?: string; fontStyle?: string; textDecoration?: string; textDecorationLine?: string; backgroundColor?: string; fontSize?: string };
};

type Rule = (el: DomLike) => boolean | null;
const tag = (el: DomLike) => el.nodeName.toUpperCase();
const RULES: Record<"b" | "i" | "u" | "hl", Rule> = {
  b: (el) => {
    if (tag(el) === "B" || tag(el) === "STRONG") return true;
    const w = el.style?.fontWeight;
    if (!w) return null;
    return w === "bold" || w === "bolder" || Number(w) >= 600;
  },
  i: (el) => {
    if (tag(el) === "I" || tag(el) === "EM") return true;
    const s = el.style?.fontStyle;
    return s ? s === "italic" || s === "oblique" : null;
  },
  u: (el) => {
    if (tag(el) === "U") return true;
    const d = el.style?.textDecorationLine || el.style?.textDecoration;
    return d ? d.includes("underline") : null;
  },
  hl: (el) => {
    if (tag(el) === "MARK") return true;
    const c = (el.style?.backgroundColor ?? "").replace(/\s/g, "").toLowerCase();
    if (!c) return null;
    return !["transparent", "rgba(0,0,0,0)", "white", "#fff", "#ffffff", "rgb(255,255,255)", "inherit", "initial", "unset"].includes(c);
  },
};

/** A letter size in points from a style ("10pt", or "13.33px" after the browser copied it), to half points. */
export function pointsOf(v: string | undefined): number | undefined {
  const m = /^([\d.]+)(pt|px)$/.exec((v ?? "").trim());
  if (!m) return undefined;
  const pt = Math.round(Number(m[1]) * (m[2] === "px" ? 0.75 : 1) * 2) / 2;
  return pt >= 4 && pt <= 96 ? pt : undefined;
}

/** The nearest setting wins, up to the group itself (the browser's own bold/italic/underline/colour commands). */
function formatAt(node: DomLike, root: DomLike): Omit<Piece, "text"> {
  const out: Omit<Piece, "text"> = { b: false, i: false, u: false, hl: false };
  for (const key of Object.keys(RULES) as (keyof typeof RULES)[]) {
    for (let el: DomLike | null = node.nodeType === 3 ? node.parentNode : node; el; el = el.parentNode) {
      const v = RULES[key](el);
      if (v !== null) {
        out[key] = v;
        break;
      }
      if (el === root) break;
    }
  }
  for (let el: DomLike | null = node.nodeType === 3 ? node.parentNode : node; el; el = el.parentNode) {
    const size = pointsOf(el.style?.fontSize);
    if (size) {
      out.size = size;
      break;
    }
    if (el === root) break;
  }
  return out;
}

function ownerAt(node: DomLike, root: DomLike): string | null {
  for (let el: DomLike | null = node.parentNode; el && el !== root; el = el.parentNode) {
    const id = el.getAttribute?.("data-r");
    if (id) return id;
  }
  return null;
}

const clean = cleanDocText;

/**
 * The text of one edited group, piece by piece, with the run each piece belongs to. Text the
 * browser put outside every run goes to the run before it (or after it, at the start).
 */
export function readGroup(root: DomLike, runIds: string[]): { owner: string | null; piece: Piece }[] {
  const known = new Set(runIds);
  const flat: { owner: string | null; text: string; fmt: Omit<Piece, "text"> }[] = [];
  const add = (c: DomLike, text: string) => {
    const owner = ownerAt(c, root);
    flat.push({ owner: owner && known.has(owner) ? owner : null, text, fmt: formatAt(c, root) });
  };
  const walk = (n: DomLike) => {
    for (let k = 0; k < n.childNodes.length; k++) {
      const c = n.childNodes[k];
      if (c.nodeType === 3) add(c, c.nodeValue ?? "");
      else if (c.nodeType === 1 && tag(c) === "BR") add(c, "\n");
      else if (c.nodeType === 1) walk(c);
    }
  };
  walk(root);
  // a line break element at the very end is the browser's placeholder of an empty line, not text
  const leaf = lastLeaf(root);
  if (flat.length && flat[flat.length - 1].text === "\n" && leaf && tag(leaf) === "BR") flat.pop();
  let prev: string | null = null;
  for (const f of flat) prev = f.owner = f.owner ?? prev;
  const first = flat.find((f) => f.owner)?.owner ?? null;
  return flat.map((f) => ({ owner: f.owner ?? first, piece: { text: clean(f.text), ...f.fmt } })).filter((f) => f.piece.text);
}

function lastLeaf(n: DomLike): DomLike | null {
  let cur: DomLike = n;
  while (cur.childNodes.length) cur = cur.childNodes[cur.childNodes.length - 1];
  return cur === n ? null : cur;
}

/** Neighbouring pieces with the same formatting become one. */
function merge(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last && last.b === p.b && last.i === p.i && last.u === p.u && last.hl === p.hl && last.size === p.size) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}

const samePieces = (a: Piece[], b: Piece[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * After Enter at the end of a stretch the browser adds one extra line break so the new line
 * shows; it is not the person's text (unless the draft itself ended with a line break).
 */
function dropPlaceholder(parts: Piece[], original: string): Piece[] {
  const last = parts[parts.length - 1];
  if (!last || !last.text.endsWith("\n") || original.endsWith("\n")) return parts;
  const text = last.text.slice(0, -1);
  return text ? [...parts.slice(0, -1), { ...last, text }] : parts.slice(0, -1);
}

/**
 * The changes to send: every run whose text or formatting differs from the draft, and text
 * typed into a paragraph that had none. A run whose text was all deleted becomes empty.
 */
export function collectEdits(groups: Map<string, Extract<Segment, { kind: "group" }>>, read: Map<string, { owner: string | null; piece: Piece }[]>): Edits {
  const edits: Edits = { runs: [], paras: [], layout: [], tables: [], cells: [] };
  for (const [key, g] of groups) {
    const got = read.get(key);
    if (!got) continue; // not on the page any more: its row or column was taken out
    if (g.para) {
      const parts = dropPlaceholder(merge(got.map((x) => x.piece)), "");
      if (parts.length) edits.paras.push({ id: g.para, parts });
      continue;
    }
    for (const [n, run] of g.runs.entries()) {
      const id = run.id!;
      const original: Piece[] = [{ text: run.text, ...fmtOf(run) }];
      let parts = merge(got.filter((x) => x.owner === id).map((x) => x.piece));
      if (n === g.runs.length - 1) parts = dropPlaceholder(parts, run.text);
      if (!parts.length) parts = [{ text: "", ...fmtOf(run) }];
      if (!samePieces(parts, original)) edits.runs.push({ id, was: run.text, parts });
    }
  }
  return edits;
}

/** Text typed into one new cell, as pieces (nothing when it stayed empty). */
export function cellPieces(read: { owner: string | null; piece: Piece }[]): Piece[] {
  return dropPlaceholder(merge(read.map((x) => x.piece)), "");
}

/** Every table of the view that has a number, by number. */
export function allTables(view: View): Map<string, Table> {
  const map = new Map<string, Table>();
  const walk = (blocks: Block[]) => {
    for (const b of blocks) {
      if (b.t === "table") {
        if (b.id) map.set(b.id, b);
        b.rows.forEach((row) => row.forEach((cell) => walk(cell.blocks)));
      } else b.items.forEach((i) => i.t === "box" && walk(i.blocks));
    }
  };
  view.parts.forEach((part) => walk(part.blocks));
  return map;
}

// ---- rows and columns (Willem 22/10): the same rules as the worker (yellow.py table_op) ----

export type GridCell = { key: string; orig: Cell | null; newId: string | null; span: number };
export type GridRow = { key: string; cells: GridCell[] };
export type Grid = { rows: GridRow[]; cols: number[] };

/** The table as the view shows it, before any change. */
export function baseGrid(t: Table): Grid {
  return {
    cols: t.cols.map((c) => dim(c) ?? 20),
    rows: t.rows.map((row, r) => ({ key: `o${r}`, cells: row.map((cell, c) => ({ key: `o${r}-${c}`, orig: cell, newId: null, span: cell.span ?? 1 })) })),
  };
}

/** Where a new column at grid position `at` goes in each row: a new cell, or a merged cell that grows. */
export function addColPlan(g: Grid, at: number): ("cell" | "widen")[] {
  return g.rows.map((row) => {
    let col = 0;
    for (const cell of row.cells) {
      if (col < at && at < col + cell.span) return "widen";
      col += cell.span;
    }
    return "cell";
  });
}

/** One change applied to the grid; null when the worker would refuse it. */
export function applyOp(g: Grid, op: TableOp): Grid | null {
  const rows = g.rows.map((r) => ({ ...r, cells: [...r.cells] }));
  const cols = [...g.cols];
  if (op.op === "addRow") {
    const src = rows[op.from];
    if (!src || op.at > rows.length || op.ids.length !== src.cells.length) return null;
    const row: GridRow = { key: `r${op.ids[0]}`, cells: src.cells.map((c, k) => ({ key: op.ids[k], orig: null, newId: op.ids[k], span: c.span })) };
    rows.splice(op.at, 0, row);
  } else if (op.op === "delRow") {
    if (rows.length < 2 || !rows[op.at]) return null;
    rows.splice(op.at, 1);
  } else if (op.op === "addCol") {
    if (op.at > cols.length) return null;
    const plan = addColPlan(g, op.at);
    if (op.ids.length !== rows.length || plan.some((p, k) => (p === "widen") !== (op.ids[k] === null))) return null;
    const src = op.at > 0 ? op.at - 1 : 0;
    const half = cols[src] / 2;
    cols[src] -= half;
    cols.splice(op.at, 0, half);
    rows.forEach((row, k) => {
      let col = 0;
      for (const [n, cell] of row.cells.entries()) {
        if (plan[k] === "widen" && col < op.at && op.at < col + cell.span) {
          row.cells[n] = { ...cell, span: cell.span + 1 };
          return;
        }
        if (plan[k] === "cell" && (col === op.at || col + cell.span === op.at)) {
          const id = op.ids[k]!;
          row.cells.splice(col === op.at && col + cell.span !== op.at ? n : n + 1, 0, { key: id, orig: null, newId: id, span: 1 });
          return;
        }
        col += cell.span;
      }
    });
  } else {
    if (cols.length < 2 || op.at >= cols.length) return null;
    for (const row of rows) {
      let col = 0;
      for (const [n, cell] of row.cells.entries()) {
        if (col <= op.at && op.at < col + cell.span) {
          if (cell.span > 1) row.cells[n] = { ...cell, span: cell.span - 1 };
          else row.cells.splice(n, 1);
          break;
        }
        col += cell.span;
      }
      if (!row.cells.length) return null;
    }
    const gone = cols.splice(op.at, 1)[0];
    cols[op.at > 0 ? op.at - 1 : 0] += gone;
  }
  return { rows, cols };
}
