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


def _real_table(table):
    """True for a data table: at least two rows with two or more filled cells."""
    try:
        rows = table.extract() or []
    except Exception:
        return False
    return sum(1 for r in rows if sum(1 for c in r if (c or "").strip()) >= 2) >= 2


PAGE_NO = re.compile(r"(page|pagina|seite|blz\.?)?\s*\d{1,3}\s*(?:/|of|van|de|sur|von)\s*(\d{1,3})", re.I)
LINE_TOL = 2.0     # points: words this close in height are on one line
TOUCH = 0.6        # points: letters this close belong to one word
# Fake bold prints a letter twice almost on top of itself; two real letters ("11" in a
# small font) are always further apart than this (security review F2).
# Measured on a real fake-bold PDF: the second print sits about 4% of the letter size away
# (1 pt at size 22, 0.6 pt at size 14), while the same letter repeated for real is at least
# about 22% of the size away. 10% catches every overprint and never merges real letters such
# as "11" or "ll" (security review F2).
OVERPRINT = 0.10


def _is_page_number(text, n_pages):
    """'2 / 21' or 'Page 2 of 21' as a whole line, and only when it is this document's page
    count or says 'page': a real line such as '1 / 10' stays (security review F1)."""
    m = PAGE_NO.fullmatch(text.strip())
    return bool(m) and (bool(m.group(1)) or (n_pages is not None and int(m.group(2)) == n_pages))


def _tidy_number(text):
    """A section number at the start of a line as printed: "1 .3 Details" -> "1.3 Details"
    (22/10/2026: a PDF gave its numbers with a space before the dot). Only the leading number
    with a dot in it; the gate reads "1 .3" and "1.3" the same."""
    # only a section number: followed by a heading word ("1 .3 Details"), never "1. 2-Butanone" (review L2)
    return re.sub(r"^(\s*\d{1,2}(?:\s?\.\s?\d{1,2})+)(?=\s+[A-Z\[(]|\s*$)",
                  lambda m: re.sub(r"\s+(?=\.)|(?<=\.)\s+", "", m.group(1)), text)


def dedupe(page):
    """The page without overprinted letters: same letter, same font and size, within
    OVERPRINT x the letter size of a letter already kept."""
    # letters are kept in a grid of cells at least `tol` wide, so each letter is compared with
    # its neighbours only, not with every same letter on the page (a 426-page MSDS took minutes)
    kept, drop = {}, set()
    for c in page.chars:
        key = (c.get("text"), c.get("fontname"), round(c.get("size") or 0, 1))
        tol = OVERPRINT * (c.get("size") or 0)
        cell = OVERPRINT * key[2] + 0.1
        gx, gy = int(c["x0"] // cell), int(c["top"] // cell)
        if any(abs(k["x0"] - c["x0"]) <= tol and abs(k["top"] - c["top"]) <= tol
               for dx in (-1, 0, 1) for dy in (-1, 0, 1) for k in kept.get((key, gx + dx, gy + dy), ())):
            drop.add(id(c))
        else:
            kept.setdefault((key, gx, gy), []).append(c)
    return page.filter(lambda obj: id(obj) not in drop) if drop else page


def _lines(page, n_pages=None):
    """Text lines of a page, as the reader sees them (20/10/2026, real MSDS):
    - letters a PDF prints twice to fake bold ("OORRGGAALL") are read once;
    - a letter in another font or a point lower ("l'écart" with "'é" in another font)
      stays on its line and in its word."""
    page = dedupe(page)
    if n_pages is None and getattr(page, "pdf", None) is not None:
        n_pages = len(page.pdf.pages)
    words = sorted(page.extract_words(extra_attrs=["size", "fontname"]), key=lambda w: (w["top"], w["x0"]))
    rows = []
    for w in words:
        if rows and abs(w["top"] - rows[-1][0]) <= LINE_TOL:
            rows[-1][1].append(w)
        else:
            rows.append([w["top"], [w]])
    out = []
    for _top, row in rows:
        # a page number line ("2 / 21", "Page 2 of 21") is page furniture, not content: it
        # must not end up inside a paragraph that runs over a page break (real MSDS)
        if _is_page_number(" ".join(w["text"] for w in row), n_pages):
            continue
        ws = []
        for w in sorted(row, key=lambda w: w["x0"]):
            if ws and 0 <= w["x0"] - ws[-1]["x1"] < TOUCH:
                prev = ws[-1]
                ws[-1] = dict(prev, text=prev["text"] + w["text"], x1=w["x1"], bottom=max(prev["bottom"], w["bottom"]),
                              size=max(prev["size"], w["size"]))
            else:
                ws.append(dict(w))
        out.append({
            "top":  min(w["top"] for w in ws),
            "bottom": max(w["bottom"] for w in ws),
            "x0":   ws[0]["x0"],
            "size": max(w["size"] for w in ws),
            "bold": any("Bold" in w["fontname"] for w in ws),
            "words": ws,
            "text": _tidy_number(" ".join(w["text"] for w in ws)),
        })
    return out


_CONNECTIVE = re.compile(
    r"(?:\b(?:or|and|of|to|in|with|for|the|a|an|by|on|at|from|as|is|are|not)\b|[-,])$",
    re.I)


def _open_sentence(prev):
    """Across a page break a line only continues on the next page when it ends like an
    unfinished sentence: a connecting word or comma, or plain words with no number at the end.
    A table value such as "Marine water 0.01 mg/l" never does (22/10/2026, real MSDS)."""
    words = prev.split()
    if _CONNECTIVE.search(prev.rstrip()):
        return True
    return len(words) >= 5 and not any(ch.isdigit() for w in words[-2:] for ch in w)


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


_SDS_TITLE = re.compile(
    r"(?:material\s+)?safety\s+data\s+sheet|fiche\s+de\s+donn[ée]es\s+de\s+s[ée]curit[ée]|sicherheitsdatenblatt"
    r"|veiligheidsinformatieblad|ficha\s+de\s+datos\s+de\s+seguridad|scheda\s+(?:di\s+)?dati\s+di\s+sicurezza", re.I)


def _split_kv(ln):
    """Return (label, value, label_right, colon_x) for the two-column layout."""
    colon = [w for w in ln["words"] if w["text"] == ":" and w["x0"] > LABEL_X]
    if not colon:
        return None
    cx = colon[0]["x0"]
    left = [w for w in ln["words"] if w["x0"] < cx]
    label = " ".join(w["text"] for w in left)
    # a colon inside an open bracket is part of a sentence, not the column separator:
    # "Precautionary statements (full text : see section 16)" (22/10/2026, real MSDS)
    if label.count("(") > label.count(")"):
        return None
    value = " ".join(w["text"] for w in ln["words"] if w["x0"] > cx)
    label_right = max((w["x1"] for w in left), default=0.0)
    return label.strip(), value.strip(), label_right, cx


def _furn_key(text):
    """A line's text with its numbers blanked: "Page 3 of 12" and "Page 4 of 12" are one key."""
    return re.sub(r"\d+", "#", text.strip().lower())


def _furniture(pages_lines, heights):
    """Lines that repeat in the top or bottom band of at least half the pages (and at least 3),
    at the same place on each page (within 3 pt): a running header or footer, not content
    (review M4: a real line that only happens to repeat somewhere is kept)."""
    n = len(pages_lines)
    if n < 3:
        return set()
    seen = {}
    for lines, h in zip(pages_lines, heights):
        here = {}
        for ln in lines:
            if ln["top"] < 0.18 * h or ln["top"] > 0.85 * h:
                here.setdefault(_furn_key(ln["text"]), (ln["top"], ln["x0"]))
        for k, pos in here.items():
            seen.setdefault(k, []).append(pos)
    out = set()
    for k, pos in seen.items():
        tops, xs = [p[0] for p in pos], [p[1] for p in pos]
        if len(pos) >= max(3, n / 2) and len(k) > 3 and max(tops) - min(tops) <= 3 and max(xs) - min(xs) <= 3:
            out.add(k)
    return out


def extract(path, image_dir=None):
    """-> (elements, meta). Kinds: section, sub, kv, para, table, image."""
    els, meta = [], {}
    images = _page_images(path, image_dir) if image_dir else {}
    meta["image_shas"] = sorted({i["sha"] for v in images.values() for i in v})
    with pdfplumber.open(path) as pdf:
        meta["pages"] = len(pdf.pages)
        # every page's lines are read once; lines that repeat at the top or bottom of most pages
        # ("Theophyllin wfr. Powder SDS UK") are page furniture (22/10/2026, real MSDS)
        pages_lines = [_lines(dedupe(p), meta["pages"]) for p in pdf.pages]
        furniture = _furniture(pages_lines, [p.height for p in pdf.pages])
        furniture_seen = set()
        for pi, page in enumerate(pdf.pages):
            if hasattr(page, "dedupe_chars"):
                page = dedupe(page)     # fake bold: letters printed twice, read once
            # A box drawn around a whole section is a frame, not a table: its rows hold one
            # filled cell each. Its text is read as ordinary lines, so headings such as 1.3 and
            # 1.4 are found (20/10/2026: many real MSDS box every section).
            tables = [t for t in page.find_tables() if _real_table(t)]
            tboxes = [t.bbox for t in tables]
            emitted = set()

            # after page 1 the header band ends below the page's own repeated header lines: body
            # text may start above HDR_BOTTOM and is never dropped (22/10/2026, real French MSDS)
            hdr_bottom = HDR_BOTTOM
            if pi > 0 and furniture:
                rep = [ln["bottom"] for ln in pages_lines[pi]
                       if ln["top"] < HDR_BOTTOM and _furn_key(ln["text"]) in furniture]
                if rep:
                    hdr_bottom = max(rep)

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

            for ln in pages_lines[pi]:
                top = ln["top"]
                _flush_images(top)
                if top < hdr_bottom:
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
                # a line in the usual header band that is not a repeated header is body text now; it
                # could still be supplier text the scrub does not know, so a person checks it (M3)
                if top < HDR_BOTTOM:
                    meta.setdefault("header_band", []).append(ln["text"])
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
                # a line repeated at the top or bottom of most pages is page furniture
                # Kept once, its first time: a running header can hold the issue date and the
                # version, which an MSDS must show. Only the repeats, and pure "continued on next
                # page" lines, are left out (22/10/2026, real MSDS).
                fk = _furn_key(ln["text"])
                if fk in furniture:
                    if fk in furniture_seen or re.search(r"continued|suite|fortsetzung|vervolg", fk):
                        if ln["text"] not in meta.setdefault("furniture", []):
                            meta["furniture"].append(ln["text"])  # reported, never silent (M4)
                        continue
                    furniture_seen.add(fk)

                # the document's own title printed below the header band on page 1 ("FICHE DE
                # DONNÉES DE SÉCURITÉ") is its title, so no default title in another language is
                # needed (22/10/2026, real French MSDS)
                if pi == 0 and "doc_kind" not in meta and _SDS_TITLE.fullmatch(ln["text"].strip()) \
                        and not any(e["kind"] == "section" for e in els):
                    meta["doc_kind"] = ln["text"].strip()
                    continue

                # "SECTION 2: HAZARDS IDENTIFICATION" is a section heading also when the supplier
                # did not set it bold or large (20/10/2026, real MSDS)
                # Only in heading form: the word in capitals, or a short line at the left margin,
                # and a real section number 1-16. A body sentence "Section 8: see ..." stays text,
                # so it can never end the supplier block early (security review F3).
                sm = re.match(r"\s*(section|rubrique|abschnitt|rubriek)\s+(\d{1,2})\s*[:.]", ln["text"], re.I)
                if (sm and 1 <= int(sm.group(2)) <= 16
                        and (sm.group(1).isupper() or (len(ln["text"]) <= 90 and ln["x0"] < LABEL_X))):
                    els.append({"kind": "section", "text": ln["text"], "page": pi + 1, "level": 0})
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
                    els.append({"kind": "kv", "label": kv[0], "value": kv[1], "value_first": kv[1],
                                "page": pi + 1, "top": top,
                                "label_right": kv[2], "colon_x": kv[3]})
                    continue

                # a line that wraps both columns of a label : value row at once ("cutanée" under the
                # label, "informations disponibles." under the value): each part goes to its own
                # column, never the whole line onto the label (22/10/2026, real French MSDS)
                # Same conditions as a wrapped label below, plus a clear gap at the colon, so an
                # ordinary line after a kv row is never pulled into it (security review H1).
                prev = els[-1] if els else {}
                if prev.get("kind") == "kv" and ln["x0"] < LABEL_X and _heading_level(ln["text"]) == 99 \
                        and prev.get("label_right", 0) >= prev.get("colon_x", 1e9) - 22 \
                        and prev.get("label_cont", 0) < 2:
                    cx = prev["colon_x"]
                    left = [w for w in ln["words"] if w["x1"] <= cx - 8]
                    right = [w for w in ln["words"] if w["x0"] >= cx + 8]
                    if left and right and len(left) + len(right) == len(ln["words"]) \
                            and sum(len(w["text"]) + 1 for w in left) <= 45:
                        prev["label"] += " " + " ".join(w["text"] for w in left)
                        prev["value"] += " " + " ".join(w["text"] for w in right)
                        prev["label_cont"] = prev.get("label_cont", 0) + 1
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
                        and _continues(els[-1]["text"], ln["text"]) \
                        and (els[-1].get("page") == pi + 1 or _open_sentence(els[-1]["text"])):
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
