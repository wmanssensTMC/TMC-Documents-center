"use client";

// Our own on-screen editor of the check screen (Willem 19/10 option A; own editor 20/10, so no
// outside licence). The worker shows the draft as a view in which every piece of text has a
// number; the person types in it and sets bold, italic, underline or removes a yellow mark.
// Only the changed pieces go back, and the worker writes them into its own Word file, so the
// TMC layout cannot break. The editor sits behind this one component, so it can be swapped (for
// example for Word for the web in phase 4) without touching the pages.
import { createContext, memo, useContext, useEffect, useImperativeHandle, useMemo, useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react";
import { ALIGNS, cleanDocText, type Edits, type Piece, type TableOp } from "@/lib/documents/edits";
import {
  addColPlan,
  allGroups,
  allTables,
  applyOp,
  baseGrid,
  cellPieces,
  collectEdits,
  dim,
  parseView,
  pointsOf,
  readGroup,
  safeColor,
  safeFont,
  safeImage,
  segments,
  startParaPieces,
  startPieces,
  type Block,
  type Cell,
  type DomLike,
  type Grid,
  type Item,
  type Para,
  type RunItem,
  type Table,
  type View,
} from "./doc-editor-model";

export type DocEditorHandle = { getEdits: () => Edits };
export type DocEditorState = "loading" | "ready" | "error";

type Props = {
  /** the editor view of the draft (/api/files/<id>/view) */
  src: string;
  /** the person's last edit that did not become Final, shown again */
  pending: Edits | null;
  onState: (s: DocEditorState) => void;
  ref: Ref<DocEditorHandle>;
};

export function DocEditor({ src, pending, onState, ref }: Props) {
  const [view, setView] = useState<View | null>(null);
  const host = useRef<HTMLDivElement>(null);
  const dirty = useRef(false);
  const report = useRef(onState);
  useEffect(() => {
    report.current = onState;
  });

  useEffect(() => {
    let cancelled = false;
    report.current("loading");
    fetch(src, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("view not available");
        return res.json();
      })
      .then((json) => {
        if (cancelled) return;
        setView(parseView(json));
        report.current("ready");
      })
      .catch(() => !cancelled && report.current("error"));
    return () => {
      cancelled = true;
    };
  }, [src]);

  // unsaved changes: the browser asks before leaving the page
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty.current) e.preventDefault();
    };
    const changed = () => (dirty.current = true);
    const el = host.current;
    window.addEventListener("beforeunload", warn);
    el?.addEventListener("beforeinput", changed, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      el?.removeEventListener("beforeinput", changed, true);
    };
  }, []);

  const groups = useMemo(() => (view ? allGroups(view) : new Map<string, never>()), [view]);
  const tablesById = useMemo(() => (view ? allTables(view) : new Map<string, Table>()), [view]);

  // Rows and columns (Willem 22/10): the changes are kept here, in order, and drawn by each table.
  const [tableOps, setTableOps] = useState<Record<string, TableOp[]>>(() =>
    Object.fromEntries((pending?.tables ?? []).map((t) => [t.id, t.ops])),
  );
  const history = useRef<string[]>([]);
  const nextNew = useRef(
    1 + Math.max(-1, ...(pending?.tables ?? []).flatMap((t) => t.ops.flatMap((o) => ("ids" in o ? o.ids : []))).map((i) => Number(i?.slice(1) ?? -1))),
  );
  const [notice, setNotice] = useState("");

  useImperativeHandle(
    ref,
    () => ({
      getEdits: () => {
        const read = new Map<string, ReturnType<typeof readGroup>>();
        const cells: Edits["cells"] = [];
        host.current?.querySelectorAll<HTMLElement>("[data-g]").forEach((el) => {
          const key = el.dataset.g ?? "";
          if (key.startsWith("new:")) {
            const parts = cellPieces(readGroup(el as unknown as DomLike, []));
            if (parts.length) cells.push({ id: key.slice(4), parts });
            return;
          }
          const g = groups.get(key);
          if (g) read.set(key, readGroup(el as unknown as DomLike, g.runs.map((r: RunItem) => r.id!)));
        });
        const layout: Edits["layout"] = [];
        host.current?.querySelectorAll<HTMLElement>("[data-p]").forEach((el) => {
          const now = el.style.textAlign;
          if (now && now !== (el.dataset.align ?? "") && (ALIGNS as readonly string[]).includes(now)) {
            layout.push({ id: el.dataset.p!, align: now as (typeof ALIGNS)[number] });
          }
        });
        const tables = Object.entries(tableOps)
          .filter(([, ops]) => ops.length)
          .map(([id, ops]) => ({ id, ops }));
        dirty.current = false;
        return { ...collectEdits(groups, read), layout, tables, cells };
      },
    }),
    [groups, tableOps],
  );

  /** The paragraph or table cell the cursor is in. */
  function at(selector: string): HTMLElement | null {
    const node = window.getSelection()?.anchorNode;
    const el = node && (node.nodeType === 1 ? (node as Element) : node.parentElement);
    const found = el?.closest<HTMLElement>(selector) ?? null;
    return found && host.current?.contains(found) ? found : null;
  }

  function align(to: (typeof ALIGNS)[number]) {
    const p = at("[data-p]");
    if (!p) return setNotice("Click in a paragraph of the page first (the TMC header and footer keep their layout).");
    p.style.textAlign = to;
    dirty.current = true;
    setNotice("");
  }

  // Bigger or smaller letters for the selected text, in fixed steps.
  function resize(step: 1 | -1) {
    const sel = window.getSelection();
    const el = at("[data-g]");
    if (!sel || !el || sel.isCollapsed) return setNotice("Select the text first.");
    const node = sel.anchorNode!;
    const now = pointsOf(getComputedStyle(node.nodeType === 1 ? (node as Element) : node.parentElement!).fontSize) ?? 10;
    const next = step > 0 ? SIZES.find((s) => s > now) : [...SIZES].reverse().find((s) => s < now);
    if (!next) return;
    document.execCommand("styleWithCSS", false, "false");
    document.execCommand("fontSize", false, "7"); // marks the selection; replaced by the real size just below
    host.current?.querySelectorAll("font[size='7']").forEach((f) => {
      const span = document.createElement("span");
      span.style.fontSize = `${next}pt`;
      while (f.firstChild) span.appendChild(f.firstChild);
      span.querySelectorAll<HTMLElement>("[style]").forEach((inner) => (inner.style.fontSize = ""));
      f.replaceWith(span);
    });
    dirty.current = true;
    setNotice("");
  }

  function table(kind: "rowAbove" | "rowBelow" | "delRow" | "colLeft" | "colRight" | "delCol") {
    const td = at("td[data-t]");
    if (!td) return setNotice("Click in a table cell first.");
    const id = td.dataset.t!;
    const t = tablesById.get(id);
    if (!t?.plain) return setNotice("This table has cells merged across rows: change its rows and columns in Word.");
    const ops = tableOps[id] ?? [];
    const grid = gridOf(t, ops);
    const row = Number(td.dataset.row);
    const col = Number(td.dataset.col);
    const span = Number(td.dataset.span);
    const fresh = () => `n${nextNew.current++}`;
    let op: TableOp;
    if (kind === "rowAbove" || kind === "rowBelow") {
      op = { op: "addRow", at: kind === "rowAbove" ? row : row + 1, from: row, ids: grid.rows[row].cells.map(fresh) };
    } else if (kind === "colLeft" || kind === "colRight") {
      const pos = kind === "colLeft" ? col : col + span;
      op = { op: "addCol", at: pos, ids: addColPlan(grid, pos).map((p) => (p === "widen" ? null : fresh())) };
    } else op = { op: kind, at: kind === "delRow" ? row : col };
    if (!applyOp(grid, op)) return setNotice("That would leave the table without rows or columns.");
    history.current.push(id);
    setTableOps({ ...tableOps, [id]: [...ops, op] });
    dirty.current = true;
    setNotice("");
  }

  function undoTable() {
    const id = history.current.pop();
    if (!id) return setNotice("No table change to undo.");
    setTableOps({ ...tableOps, [id]: (tableOps[id] ?? []).slice(0, -1) });
    setNotice("");
  }

  // Toolbar commands act on the text the person selected (the browser's own editing commands).
  function command(name: "bold" | "italic" | "underline" | "unmark") {
    const sel = window.getSelection();
    const at = sel?.anchorNode;
    const el = at && (at.nodeType === 1 ? (at as Element) : at.parentElement);
    const group = el?.closest("[data-g]");
    if (!sel || !group || !host.current?.contains(group)) return;
    if (name === "unmark") {
      if (sel.isCollapsed) {
        // nothing selected: the whole piece of text the cursor is in (also when bold split it)
        const id = el?.closest("[data-r]")?.getAttribute("data-r");
        const all = id ? group.querySelectorAll(`[data-r="${CSS.escape(id)}"]`) : [];
        if (!all.length) return;
        const last = all[all.length - 1];
        const range = document.createRange();
        range.setStart(all[0], 0);
        range.setEnd(last, last.childNodes.length);
        sel.removeAllRanges();
        sel.addRange(range);
      }
      document.execCommand("styleWithCSS", false, "true");
      document.execCommand("hiliteColor", false, "transparent");
      document.execCommand("styleWithCSS", false, "false");
    } else document.execCommand(name);
    dirty.current = true;
  }

  // Jump to the next yellow part after the cursor, so none is missed.
  function nextYellow() {
    const marked = Array.from(host.current?.querySelectorAll<HTMLElement>("[data-g] [style]") ?? []).filter((e) => {
      const c = e.style.backgroundColor.replace(/\s/g, "");
      return c && c !== "transparent" && c !== "rgba(0,0,0,0)" && e.textContent?.trim();
    });
    if (!marked.length) return;
    const sel = window.getSelection();
    const at = sel?.anchorNode ?? null;
    const next =
      marked.find((e) => at && !e.contains(at) && at.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING) ?? marked[0];
    next.scrollIntoView({ block: "center" });
    next.closest<HTMLElement>("[data-g]")?.focus({ preventScroll: true }); // typing goes there
    const range = document.createRange();
    range.selectNodeContents(next);
    sel?.removeAllRanges();
    sel?.addRange(range);
  }

  const tool = "rounded border border-gray-300 bg-white px-2 py-1 text-sm hover:bg-gray-50";
  const keep = (e: React.MouseEvent) => e.preventDefault(); // keep the selection in the text
  const pendingKey = useMemo(() => JSON.stringify(pending ?? null), [pending]);

  return (
    <div className="min-w-0 overflow-hidden rounded border bg-white">
      <div className="flex flex-wrap items-center gap-1 border-b bg-gray-50 p-1.5" role="toolbar" aria-label="Formatting">
        <button type="button" className={`${tool} font-bold`} onMouseDown={keep} onClick={() => command("bold")} title="Bold (Ctrl+B)">
          B
        </button>
        <button type="button" className={`${tool} italic`} onMouseDown={keep} onClick={() => command("italic")} title="Italic (Ctrl+I)">
          I
        </button>
        <button type="button" className={`${tool} underline`} onMouseDown={keep} onClick={() => command("underline")} title="Underline (Ctrl+U)">
          U
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => command("unmark")} title="Remove the yellow mark of the selected text">
          Remove yellow
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={nextYellow}>
          Next yellow part
        </button>
        <span className="mx-1 h-5 w-px bg-gray-300" aria-hidden />
        <button type="button" className={tool} onMouseDown={keep} onClick={() => resize(-1)} title="Smaller letters for the selected text">
          A−
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => resize(1)} title="Bigger letters for the selected text">
          A+
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => align("left")} title="Align the paragraph left">
          Left
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => align("center")} title="Centre the paragraph">
          Centre
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => align("right")} title="Align the paragraph right">
          Right
        </button>
        <span className="mx-1 h-5 w-px bg-gray-300" aria-hidden />
        <button type="button" className={tool} onMouseDown={keep} onClick={() => table("rowAbove")}>
          + Row above
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => table("rowBelow")}>
          + Row below
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => table("delRow")}>
          Delete row
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => table("colLeft")}>
          + Column left
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => table("colRight")}>
          + Column right
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={() => table("delCol")}>
          Delete column
        </button>
        <button type="button" className={tool} onMouseDown={keep} onClick={undoTable}>
          Undo table change
        </button>
        {notice && (
          <span role="status" className="text-sm text-amber-800">
            {notice}
          </span>
        )}
      </div>
      <div ref={host} className="h-[75vh] overflow-auto bg-gray-100 p-3">
        <TablesContext value={tableOps}>{view && <Page key={pendingKey} view={view} pending={pending} />}</TablesContext>
      </div>
    </div>
  );
}

// ---- the page: rendered once, then the browser edits it in place ---------------------------

const Page = memo(function Page({ view, pending }: { view: View; pending: Edits | null }) {
  const { page } = view;
  const ctx: Ctx = { media: view.media, pending };
  return (
    <div
      className="mx-auto bg-white shadow"
      style={{
        width: `${dim(page.width) ?? 210}mm`,
        padding: `${(dim(page.top) ?? 20) / 2}mm ${dim(page.right) ?? 20}mm ${(dim(page.bottom) ?? 20) / 2}mm ${dim(page.left) ?? 20}mm`,
        fontFamily: "Arial, Helvetica, sans-serif",
        fontSize: "10pt",
        color: "#000",
      }}
    >
      {view.parts.map((part, k) => (
        <div key={k} className={part.kind === "body" ? "py-2" : "border border-dashed border-gray-300 px-1"}>
          {part.kind !== "body" && (
            <div className="select-none text-[8pt] text-gray-400">{part.kind === "header" ? "Header" : "Footer"}</div>
          )}
          <Blocks blocks={part.blocks} ctx={{ ...ctx, body: part.kind === "body" }} />
        </div>
      ))}
    </div>
  );
});

/** body = false in the TMC header and footer: their text may change, their layout never (review M3). */
type Ctx = { media: Record<string, string>; pending: Edits | null; body?: boolean };

function Blocks({ blocks, ctx }: { blocks: Block[]; ctx: Ctx }) {
  return (
    <>
      {blocks.map((b, k) => (b.t === "p" ? <Paragraph key={k} p={b} ctx={ctx} /> : <TableView key={k} t={b} ctx={ctx} />))}
    </>
  );
}

const ALIGN: Record<string, CSSProperties["textAlign"]> = { left: "left", center: "center", right: "right", justify: "justify" };

function Paragraph({ p, ctx }: { p: Para; ctx: Ctx }) {
  const align = ctx.pending?.layout.find((l) => l.id === p.id)?.align ?? p.align;
  return (
    <div
      data-p={ctx.body ? p.id : undefined}
      data-align={p.align ?? ""}
      style={{
        textAlign: align ? ALIGN[align] : undefined,
        marginTop: dim(p.before) ? `${dim(p.before)}pt` : undefined,
        marginBottom: dim(p.after) ? `${dim(p.after)}pt` : undefined,
        paddingLeft: dim(p.indent) ? `${dim(p.indent)}mm` : undefined,
        whiteSpace: "pre-wrap",
        minHeight: "1.2em",
      }}
    >
      {segments(p).map((s, k) =>
        s.kind === "group" ? (
          <Group key={s.key} id={s.key} empty={!s.runs.length}>
            {s.para
              ? startParaPieces(s.para, ctx.pending).map((pc, n) => (
                  <span key={n} style={pieceStyle(null, pc)}>
                    {pc.text}
                  </span>
                ))
              : s.runs.map((run) =>
                  startPieces(run, ctx.pending).map((pc, n) => (
                    <span key={`${run.id}-${n}`} data-r={run.id!} style={pieceStyle(run, pc)}>
                      {pc.text}
                    </span>
                  )),
                )}
          </Group>
        ) : (
          <Fixed key={k} item={s.item} ctx={ctx} />
        ),
      )}
    </div>
  );
}

function pieceStyle(run: RunItem | null, pc: Piece): CSSProperties {
  const font = safeFont(run?.font);
  return {
    fontWeight: pc.b ? 700 : 400,
    fontStyle: pc.i ? "italic" : "normal",
    textDecorationLine: pc.u ? "underline" : "none",
    backgroundColor: pc.hl ? "#ffff00" : undefined,
    fontSize: dim(pc.size ?? run?.size, 100) ? `${dim(pc.size ?? run?.size, 100)}pt` : undefined,
    fontFamily: font ? `"${font}", Arial, sans-serif` : undefined,
    color: safeColor(run?.color),
  };
}

const clean = cleanDocText;

/**
 * Types text over the selection. When the selection lies inside one piece of text, the new text
 * stays in that piece: the browser would otherwise drop a piece whose whole text is replaced,
 * and the new text would take the formatting of the piece next to it.
 */
function selectionInOnePiece(): Range | null {
  const sel = window.getSelection();
  const range = sel && sel.rangeCount === 1 ? sel.getRangeAt(0) : null;
  const pieceOf = (n: Node) => (n.nodeType === 1 ? (n as Element) : n.parentElement)?.closest("[data-r]") ?? null;
  if (!range || range.collapsed) return null;
  const piece = pieceOf(range.startContainer);
  return piece && piece === pieceOf(range.endContainer) ? range : null;
}

function insertPlain(text: string) {
  const range = selectionInOnePiece();
  if (!range) {
    document.execCommand("insertText", false, text);
    return;
  }
  range.deleteContents();
  const node = document.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

/** One editable stretch of text. Enter is a line break; pasted text comes in as plain text. */
function Group({ id, empty, children }: { id: string; empty: boolean; children: ReactNode }) {
  const self = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = self.current;
    const typed = (e: InputEvent) => {
      if ((e.inputType === "insertText" || e.inputType === "insertReplacementText") && selectionInOnePiece()) {
        e.preventDefault();
        insertPlain(clean(e.data ?? e.dataTransfer?.getData("text/plain") ?? ""));
      }
    };
    el?.addEventListener("beforeinput", typed);
    return () => el?.removeEventListener("beforeinput", typed);
  }, []);
  return (
    <span
      ref={self}
      data-g={id}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      role="textbox"
      aria-label="Document text"
      className={`rounded-sm outline-none focus:ring-1 focus:ring-tmc/40 ${empty ? "inline-block min-w-[3em] border-b border-dotted border-gray-300" : ""}`}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault(); // no new paragraphs: the layout stays as the engine made it
          insertPlain("\n");
        }
      }}
      onPaste={(e) => {
        e.preventDefault();
        insertPlain(clean(e.clipboardData.getData("text/plain")).slice(0, 5000));
      }}
      onDrop={(e) => e.preventDefault()}
    >
      {children}
    </span>
  );
}

function Fixed({ item, ctx }: { item: Item; ctx: Ctx }) {
  if (item.t === "r") return <span style={pieceStyle(item, item)}>{item.text}</span>;
  if (item.t === "box")
    return (
      <div className="my-1 inline-block max-w-full border border-dashed border-gray-400 p-1 align-top">
        <Blocks blocks={item.blocks} ctx={ctx} />
      </div>
    );
  const src = item.m ? safeImage(ctx.media[item.m]) : null;
  const size: CSSProperties = { width: dim(item.w) ? `${dim(item.w)}mm` : undefined, height: dim(item.h) ? `${dim(item.h)}mm` : undefined };
  return src ? (
    // eslint-disable-next-line @next/next/no-img-element -- a picture of the document itself, from the view
    <img src={src} alt="" className="inline-block align-middle" style={{ ...size, maxWidth: "100%" }} />
  ) : (
    <span className="inline-block bg-gray-100 px-1 align-middle text-[8pt] text-gray-500 ring-1 ring-gray-300" style={size}>
      picture
    </span>
  );
}

/** The rows and columns made on screen, per table number. */
const TablesContext = createContext<Record<string, TableOp[]>>({});

const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28];

/** A table as it is now: the view, then the person's row and column changes in order. */
function gridOf(t: Table, ops: TableOp[]): Grid {
  return ops.reduce<Grid>((g, op) => applyOp(g, op) ?? g, baseGrid(t));
}

function TableView({ t, ctx }: { t: Table; ctx: Ctx }) {
  const ops = useContext(TablesContext)[t.id ?? ""] ?? [];
  const grid = gridOf(t, ops);
  const width = grid.cols.reduce((a, b) => a + b, 0);
  const shade = (cell: Cell | null) => safeColor(cell?.shade);
  return (
    <table style={{ borderCollapse: "collapse", tableLayout: "fixed", width: width ? `${width}mm` : "100%" }}>
      <colgroup>
        {grid.cols.map((c, k) => (
          <col key={k} style={{ width: `${c}mm` }} />
        ))}
      </colgroup>
      <tbody>
        {grid.rows.map((row, r) => {
          let col = 0;
          return (
            <tr key={row.key}>
              {row.cells.map((cell) => {
                const start = col;
                col += cell.span;
                return (
                  <td
                    key={cell.key}
                    data-t={t.id ?? undefined}
                    data-row={r}
                    data-col={start}
                    data-span={cell.span}
                    colSpan={dim(cell.span, 64)}
                    rowSpan={ops.length ? undefined : dim(cell.orig?.rowspan, 1000)}
                    style={{ border: t.lines ? "1px solid #444" : "1px dotted #d1d5db", background: shade(cell.orig), verticalAlign: "top", padding: "1px 4px" }}
                  >
                    {cell.orig ? (
                      <Blocks blocks={cell.orig.blocks} ctx={ctx} />
                    ) : (
                      <div style={{ whiteSpace: "pre-wrap", minHeight: "1.2em" }}>
                        <Group id={`new:${cell.newId}`} empty>
                          {(ctx.pending?.cells.find((x) => x.id === cell.newId)?.parts ?? []).map((pc, n) => (
                            <span key={n} style={pieceStyle(null, pc)}>
                              {pc.text}
                            </span>
                          ))}
                        </Group>
                      </div>
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
