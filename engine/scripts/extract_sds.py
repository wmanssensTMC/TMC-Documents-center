"""SDS extraction: turn a supplier SDS PDF into a structured element list."""
import hashlib
import io
import os
import re
import pdfplumber

HDR_BOTTOM = 100.0      # page-header band (product title + regulatory framing)
FTR_TOP    = 795.0      # page-footer band (document control line)
LABEL_X    = 200.0      # value column starts right of this
SZ_SECTION = 9.6        # >= this and bold  -> SECTION heading
SZ_SUB     = 8.6        # >= this and bold  -> sub-heading


def _lines(page):
    rows = {}
    for w in page.extract_words(extra_attrs=["size", "fontname"]):
        rows.setdefault(round(w["top"] / 2.0), []).append(w)
    out = []
    for k in sorted(rows):
        ws = sorted(rows[k], key=lambda w: w["x0"])
        out.append({
            "top":  min(w["top"] for w in ws),
            "bottom": max(w["bottom"] for w in ws),
            "x0":   ws[0]["x0"],
            "size": max(w["size"] for w in ws),
            "bold": any("Bold" in w["fontname"] for w in ws),
            "words": ws,
            "text": " ".join(w["text"] for w in ws),
        })
    return out


_CONNECTIVE = re.compile(
    r"(?:\b(?:or|and|of|to|in|with|for|the|a|an|by|on|at|from|as|is|are|not)\b|[-,])$",
    re.I)


def _continues(prev, cur):
    """True when `cur` is the wrapped remainder of the sentence in `prev`."""
    prev, cur = prev.rstrip(), cur.lstrip()
    if not prev or not cur:
        return False
    if prev[-1] in ".:;!?":
        return False
    if cur[0].islower():
        return True
    return bool(_CONNECTIVE.search(prev))




def _page_images(pdf_path, out_dir):
    """Extract every placed image per page, with its rectangle.

    Images are content: GHS hazard pictograms, PPE pictograms and transport
    labels are legally required parts of an SDS, so they must be carried over.
    They are taken from the source file itself - never substituted from any
    other collection - so they fall under the same rule as the text.
    """
    try:
        import pymupdf
    except ImportError:                       # pragma: no cover
        return {}
    os.makedirs(out_dir, exist_ok=True)
    per_page, cache = {}, {}
    doc = pymupdf.open(pdf_path)
    for pno, page in enumerate(doc):
        items = []
        for info in page.get_image_info(xrefs=True):
            xref = info.get("xref")
            if not xref:
                continue
            if xref not in cache:
                pix = pymupdf.Pixmap(doc, xref)
                if pix.n - pix.alpha > 3:
                    pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
                data = pix.tobytes("png")
                digest = hashlib.sha256(data).hexdigest()[:16]
                path = os.path.join(out_dir, f"img_{digest}.png")
                if not os.path.exists(path):
                    with open(path, "wb") as fh:
                        fh.write(data)
                cache[xref] = (path, digest)
            path, digest = cache[xref]
            x0, y0, x1, y1 = info["bbox"]
            items.append({"path": path, "sha": digest, "x0": x0, "top": y0,
                          "w_pt": x1 - x0, "h_pt": y1 - y0})
        per_page[pno] = sorted(items, key=lambda i: (round(i["top"]), i["x0"]))
    doc.close()
    return per_page


def _heading_level(text):
    """1 for "7.1.", 2 for "8.1.1", 3 for deeper. 99 when not a heading."""
    m = re.match(r"\s*(\d+(?:\.\d+)+)\.?\s+\S", text or "")
    if not m:
        return 99
    return len(m.group(1).split(".")) - 1


def _split_kv(ln):
    """Return (label, value, label_right, colon_x) for the two-column layout."""
    colon = [w for w in ln["words"] if w["text"] == ":" and w["x0"] > LABEL_X]
    if not colon:
        return None
    cx = colon[0]["x0"]
    left = [w for w in ln["words"] if w["x0"] < cx]
    label = " ".join(w["text"] for w in left)
    value = " ".join(w["text"] for w in ln["words"] if w["x0"] > cx)
    label_right = max((w["x1"] for w in left), default=0.0)
    return label.strip(), value.strip(), label_right, cx


def extract(path, image_dir=None):
    """-> (elements, meta). Kinds: section, sub, kv, para, table, image."""
    els, meta = [], {}
    images = _page_images(path, image_dir) if image_dir else {}
    meta["image_shas"] = sorted({i["sha"] for v in images.values() for i in v})
    with pdfplumber.open(path) as pdf:
        meta["pages"] = len(pdf.pages)
        for pi, page in enumerate(pdf.pages):
            tables = page.find_tables()
            tboxes = [t.bbox for t in tables]
            emitted = set()

            page_imgs = list(images.get(pi, []))

            def _flush_images(before_top):
                """Emit images sitting above `before_top`, grouped per row."""
                while page_imgs and page_imgs[0]["top"] < before_top:
                    row_top = page_imgs[0]["top"]
                    row = []
                    while page_imgs and abs(page_imgs[0]["top"] - row_top) <= 8:
                        row.append(page_imgs.pop(0))
                    # the supplier logo lives in the page-header band, which is
                    # stripped like the header text it sits next to
                    if row_top + row[0]["h_pt"] / 2 < HDR_BOTTOM:
                        continue
                    if row_top > FTR_TOP:
                        continue
                    el = {"kind": "image", "images": row, "page": pi + 1,
                          "top": row_top,
                          "in_value_col": row[0]["x0"] > LABEL_X}
                    # pictograms printed inside a ruled table (the transport
                    # classification row) must keep their column, otherwise the
                    # reader cannot tell which mode each label belongs to
                    host = next((t for t in tables
                                 if t.bbox[1] <= row_top <= t.bbox[3]), None)
                    if host is not None and len(host.columns) > 1:
                        edges = [c[0] for c in
                                 sorted({(c.bbox[0], c.bbox[2]) for c in host.columns})]
                        edges = sorted(edges) + [host.bbox[2]]
                        groups = [[] for _ in range(len(edges) - 1)]
                        for img in row:
                            idx = max(0, min(len(groups) - 1,
                                             sum(1 for e0 in edges[1:-1]
                                                 if img["x0"] >= e0 - 2)))
                            groups[idx].append(img)
                        if sum(1 for g in groups if g) > 1:
                            el["col_groups"] = groups
                            el["in_value_col"] = False
                    els.append(el)

            for ln in _lines(page):
                top = ln["top"]
                _flush_images(top)
                if top < HDR_BOTTOM:
                    if pi == 0:
                        if ln["size"] >= 15:
                            meta["product_name"] = ln["text"]
                        elif ln["size"] >= 11:
                            meta["doc_kind"] = ln["text"]
                        elif ln["text"].lower().startswith("according to"):
                            meta.setdefault("framing", []).append(ln["text"])
                        else:
                            meta["version_line"] = ln["text"]
                    continue
                if top > FTR_TOP:
                    if pi == 0:
                        meta["control_line"] = re.sub(r"\s*\d+/\d+\s*$", "", ln["text"])
                    continue

                # inside a ruled table -> emit the whole table once.
                # Use the line's vertical midpoint so that a line sitting
                # immediately below a table is not swallowed by it.
                mid = (ln["top"] + ln["bottom"]) / 2.0
                hit = next((i for i, b in enumerate(tboxes)
                            if b[1] <= mid <= b[3]), None)
                if hit is not None:
                    if hit not in emitted:
                        emitted.add(hit)
                        rows = [[(c or "").replace("\n", " ").strip()
                                 for c in row] for row in tables[hit].extract()]
                        rows = [r for r in rows if any(c for c in r)]
                        if rows:
                            els.append({"kind": "table", "rows": rows, "page": pi + 1})
                    continue

                if ln["bold"] and ln["size"] >= SZ_SECTION:
                    els.append({"kind": "section", "text": ln["text"],
                                "page": pi + 1, "level": 0})
                    continue
                if ln["bold"] and ln["size"] >= SZ_SUB:
                    els.append({"kind": "sub", "text": ln["text"], "page": pi + 1,
                                "level": _heading_level(ln["text"])})
                    continue
                # numbered headings that the supplier did not set in bold
                # (e.g. "1.2.1. Relevant identified uses") still are headings
                lvl = _heading_level(ln["text"])
                # 99 means "not a numbered heading" - it must not match here,
                # or ordinary body text gets set as a heading
                if 2 <= lvl <= 4 and ln["x0"] < LABEL_X and ":" not in ln["text"]:
                    els.append({"kind": "sub", "text": ln["text"], "page": pi + 1,
                                "level": lvl})
                    continue

                kv = _split_kv(ln)
                if kv:
                    els.append({"kind": "kv", "label": kv[0], "value": kv[1],
                                "page": pi + 1, "top": top,
                                "label_right": kv[2], "colon_x": kv[3]})
                    continue

                # continuation of the value column?
                if ln["x0"] > LABEL_X and els and els[-1]["kind"] == "kv":
                    els[-1]["value"] += " " + ln["text"]
                    continue
                if ln["x0"] > LABEL_X and els and els[-1]["kind"] == "para" \
                        and els[-1].get("indent"):
                    els[-1]["text"] += " " + ln["text"]
                    continue

                # a label too long for the label column wraps onto the next
                # line, still in the label column: "Portable tank and bulk
                # container special provisions" + "(ADR)"
                if els and els[-1]["kind"] == "kv" and ln["x0"] < LABEL_X \
                        and els[-1].get("label_right", 0) >= els[-1].get("colon_x", 1e9) - 22 \
                        and els[-1].get("label_cont", 0) < 2 \
                        and len(ln["text"]) <= 45 \
                        and _heading_level(ln["text"]) == 99:
                    els[-1]["label"] += " " + ln["text"]
                    els[-1]["label_cont"] = els[-1].get("label_cont", 0) + 1
                    continue

                # a wrapped full-width sentence continues the previous paragraph
                if els and els[-1]["kind"] == "para" and not els[-1].get("indent") \
                        and _continues(els[-1]["text"], ln["text"]):
                    els[-1]["text"] += " " + ln["text"]
                    continue

                els.append({"kind": "para", "text": ln["text"], "page": pi + 1,
                            "indent": ln["x0"] > LABEL_X})

            _flush_images(FTR_TOP)
    return els, meta


if __name__ == "__main__":
    import sys, collections
    els, meta = extract(sys.argv[1])
    print("META:", {k: v for k, v in meta.items() if k != "framing"})
    print("framing:", meta.get("framing"))
    print("counts:", collections.Counter(e["kind"] for e in els))
    for e in els[:40]:
        print(e["kind"], "|", (e.get("text") or (e.get("label", "") + " :: " + e.get("value", "")))[:95])
