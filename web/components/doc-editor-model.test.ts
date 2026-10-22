import { describe, expect, it } from "vitest";
import { allGroups, collectEdits, readGroup, safeImage, segments, startPieces, type DomLike, type Para, type RunItem, type View } from "./doc-editor-model";

// A tiny stand-in for the browser's DOM: only what the reader looks at.
type N = DomLike & { childNodes: N[] };
function el(name: string, attrs: Record<string, string> = {}, style: DomLike["style"] = {}, ...kids: (N | string)[]): N {
  const node: N = { nodeType: 1, nodeName: name, nodeValue: null, childNodes: [], parentNode: null, getAttribute: (a) => attrs[a] ?? null, style };
  for (const k of kids) {
    const child: N = typeof k === "string" ? { nodeType: 3, nodeName: "#text", nodeValue: k, childNodes: [], parentNode: null } : k;
    child.parentNode = node;
    node.childNodes.push(child);
  }
  return node;
}
const run = (id: string, text: string, over: Partial<RunItem> = {}): RunItem => ({ t: "r", id, text, b: false, i: false, u: false, hl: false, ...over });
const span = (id: string, style: DomLike["style"], ...kids: (N | string)[]) => el("SPAN", { "data-r": id }, style, ...kids);
const plain = { fontWeight: "400", fontStyle: "normal", textDecorationLine: "none" };

describe("own on-screen editor: cutting a paragraph into editable stretches", () => {
  it("keeps pictures, text boxes and fixed text out of the editable stretches", () => {
    const p: Para = { t: "p", id: "p0", items: [run("r0", "A"), run("r1", "B"), { t: "img", m: "m0" }, run("r2", "C"), { t: "r", id: null, text: "fixed", b: false, i: false, u: false, hl: false }] };
    const s = segments(p);
    expect(s.map((x) => (x.kind === "group" ? x.runs.map((r) => r.id).join("+") : "fixed"))).toEqual(["r0+r1", "fixed", "r2", "fixed"]);
  });

  it("offers one place to type in a paragraph without text of its own", () => {
    const s = segments({ t: "p", id: "p7", items: [{ t: "img", m: null }] });
    expect(s[s.length - 1]).toMatchObject({ kind: "group", runs: [], para: "p7" });
  });

  it("finds the stretches in tables and text boxes too", () => {
    const view: View = {
      v: 1,
      page: { width: 210, left: 20, right: 20, top: 20, bottom: 20 },
      media: {},
      parts: [
        {
          kind: "body",
          blocks: [
            { t: "table", cols: [50], lines: true, rows: [[{ blocks: [{ t: "p", id: "p1", items: [run("r5", "cell")] }] }]] },
            { t: "p", id: "p2", items: [{ t: "box", blocks: [{ t: "p", id: "p3", items: [run("r6", "box")] }] }] },
          ],
        },
      ],
    };
    const runs = [...allGroups(view).values()].flatMap((g) => g.runs.map((r) => r.id));
    expect(runs).toEqual(["r5", "r6"]);
  });
});

describe("own on-screen editor: reading the edited text back", () => {
  it("reads text and formatting per piece, the nearest setting winning", () => {
    const root = el("SPAN", { "data-g": "p0:0" }, {}, span("r0", plain, "Sodium ", el("B", {}, {}, "Benzoate")), span("r1", { ...plain, backgroundColor: "#ffff00" }, "99.6"));
    expect(readGroup(root, ["r0", "r1"])).toEqual([
      { owner: "r0", piece: { text: "Sodium ", b: false, i: false, u: false, hl: false } },
      { owner: "r0", piece: { text: "Benzoate", b: true, i: false, u: false, hl: false } },
      { owner: "r1", piece: { text: "99.6", b: false, i: false, u: false, hl: true } },
    ]);
  });

  it("a removed yellow mark (the browser's transparent colour) counts as removed", () => {
    const root = el("SPAN", {}, {}, span("r1", { ...plain, backgroundColor: "rgb(255, 255, 0)" }, el("SPAN", {}, { backgroundColor: "transparent" }, "99.6")));
    expect(readGroup(root, ["r1"])[0].piece.hl).toBe(false);
  });

  it("text typed outside every piece goes to the piece before it, at the start to the first piece", () => {
    const root = el("SPAN", {}, {}, "Pre ", span("r0", plain, "A"), " mid", span("r1", plain, "B"));
    expect(readGroup(root, ["r0", "r1"]).map((x) => [x.owner, x.piece.text])).toEqual([
      ["r0", "Pre "],
      ["r0", "A"],
      ["r0", " mid"],
      ["r1", "B"],
    ]);
  });

  it("a line break inside is text, the browser's placeholder at the end is not; unknown pieces are not trusted", () => {
    const root = el("SPAN", {}, {}, span("r0", plain, "one", el("BR"), "two"), span("r9", plain, "x"), el("BR"));
    const got = readGroup(root, ["r0"]);
    expect(got.map((x) => x.piece.text).join("")).toBe("one\ntwox");
    expect(got.every((x) => x.owner === "r0")).toBe(true);
  });

  it("control and invisible characters are dropped", () => {
    const root = el("SPAN", {}, {}, span("r0", plain, "a\u0007b\u202ec"));
    expect(readGroup(root, ["r0"])[0].piece.text).toBe("abc");
  });
});

describe("own on-screen editor: the changes sent to the worker", () => {
  const p: Para = { t: "p", id: "p0", items: [run("r0", "Sodium Benzoate"), run("r1", "99.6", { hl: true })] };
  const groups = allGroups({ v: 1, page: { width: 210, left: 0, right: 0, top: 0, bottom: 0 }, media: {}, parts: [{ kind: "body", blocks: [p] }] });
  const key = [...groups.keys()][0];
  const f = { b: false, i: false, u: false, hl: false };

  it("nothing changed, nothing sent", () => {
    const read = new Map([[key, [{ owner: "r0", piece: { text: "Sodium Benzoate", ...f } }, { owner: "r1", piece: { text: "99.6", ...f, hl: true } }]]]);
    expect(collectEdits(groups, read)).toEqual({ runs: [], paras: [] });
  });

  it("only the changed piece is sent, with its old text; same formatting is joined", () => {
    const read = new Map([
      [key, [{ owner: "r0", piece: { text: "Sodium ", ...f } }, { owner: "r0", piece: { text: "Benzoate", ...f } }, { owner: "r1", piece: { text: "99.6", ...f } }]],
    ]);
    expect(collectEdits(groups, read)).toEqual({ runs: [{ id: "r1", was: "99.6", parts: [{ text: "99.6", ...f }] }], paras: [] });
  });

  it("the browser's extra line break after Enter at the end is not sent", () => {
    const read = new Map([
      [key, [{ owner: "r0", piece: { text: "Sodium Benzoate", ...f } }, { owner: "r1", piece: { text: "99.6\nsecond line\n", ...f, hl: true } }]],
    ]);
    expect(collectEdits(groups, read).runs).toEqual([{ id: "r1", was: "99.6", parts: [{ text: "99.6\nsecond line", ...f, hl: true }] }]);
  });

  it("a piece whose text was all deleted becomes empty", () => {
    const read = new Map([[key, [{ owner: "r1", piece: { text: "99.6", ...f, hl: true } }]]]);
    expect(collectEdits(groups, read).runs).toEqual([{ id: "r0", was: "Sodium Benzoate", parts: [{ text: "", ...f }] }]);
  });

  it("text typed into an empty line is sent for that paragraph", () => {
    const empty = allGroups({ v: 1, page: { width: 210, left: 0, right: 0, top: 0, bottom: 0 }, media: {}, parts: [{ kind: "body", blocks: [{ t: "p", id: "p4", items: [] }] }] });
    const k = [...empty.keys()][0];
    expect(collectEdits(empty, new Map([[k, [{ owner: null, piece: { text: "new", ...f } }]]]))).toEqual({ runs: [], paras: [{ id: "p4", parts: [{ text: "new", ...f }] }] });
  });

  it("the last edit is shown again only for a piece that still reads the same", () => {
    const pending = { runs: [{ id: "r0", was: "Sodium Benzoate", parts: [{ text: "Potassium", ...f }] }], paras: [] };
    expect(startPieces(run("r0", "Sodium Benzoate"), pending)[0].text).toBe("Potassium");
    expect(startPieces(run("r0", "Other"), pending)[0].text).toBe("Other");
  });
});

describe("own on-screen editor: pictures", () => {
  it("shows only plain image data, never a link or a script", () => {
    expect(safeImage("data:image/png;base64,iVBORw0KGgo=")).toBeTruthy();
    expect(safeImage("data:image/svg+xml;base64,PHN2Zz4=")).toBeNull();
    expect(safeImage("javascript:alert(1)")).toBeNull();
    expect(safeImage("https://example.com/logo.png")).toBeNull();
  });
});
