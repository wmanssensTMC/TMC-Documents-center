#!/usr/bin/env python3
"""
Transmare Chemie NV - TDS / Specification Neutralizer (DOCX + PDF)
==================================================================
Re-issues a supplier Technical Data Sheet, or a supplier specification sheet
(Willem, 15/10/2026: "spec sheets go the TDS way"), on the TMC layout.

The rules are the platform's TDS rules (TMC Sonar Logistics, Documents page):
  * same as the original, TMC layout only: no added titles or sub-titles,
    every block in the order printed, the exact words, never invented;
  * title "Technical Data Sheet – <name>"; the name is the one given with
    --product-name, otherwise the original's own;
  * supplier name, address, telephone, fax, e-mail, website, article code,
    document code, letterhead, logo, signatures and page numbers go out;
    a sentence that names the supplier keeps the sentence and gets the
    Transmare entity name in its place;
  * blocks stay in one column, one under the other, close together;
  * what is unsure is marked YELLOW. While anything is yellow the run
    stops at the .docx draft (exit 2); the PDF follows with --finalise once
    every yellow part is checked. Final stays locked, as on the platform.
  * the provenance gate: every string in the output traces back to the
    source or to a supplied value, otherwise the output is deleted.

Usage
-----
  python neutralize_tds_docx.py TDS.pdf --output-dir OUT [--product-name NAME]
        [--entity entity.json] [--supplier-json leverancier.json]
  python neutralize_tds_docx.py TDS.pdf --from-json platform_job.json --output-dir OUT
  python neutralize_tds_docx.py --finalise OUT/TMC_TDS_NAME.docx

--from-json takes the platform's own reading of the sheet ({"kop":{...},
"secties":[...], "leverancier":{...}, "onzeker":[...]}), so the platform and
this skill build the same document. The source PDF is still required: the
provenance gate checks the result against it.
"""
import argparse, html.parser, json, re, shutil, sys, tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from docx import Document                                           # noqa: E402
from docx.shared import Pt, Cm, RGBColor                            # noqa: E402
from docx.enum.text import WD_ALIGN_PARAGRAPH                       # noqa: E402
from docx.enum.table import WD_TABLE_ALIGNMENT                      # noqa: E402
from build_sds_docx import (_clear_body, _shade, _borders, _fixed_layout,  # noqa: E402
                            _row_props, _style, TMC_BLUE, BAND_TABLE, BLACK)
from tmc_common import (load_entity, entity_code, apply_entity_footer,     # noqa: E402
                        close_hyphens, mark_yellow, finalise, non_clobbering,
                        render_pdf, safe_part, EXIT_REVIEW)
import provenance                                                   # noqa: E402

SKILL_DIR = Path(__file__).parent.parent
# Same letterhead, footer and stamp as the certificate (platform task prompt: "a TDS is
# re-issued ... on the TMC letterhead, footer and stamp"). Its body is cleared and rebuilt.
TEMPLATE = SKILL_DIR / "assets" / "TMC_COA_template.docx"
TITLE_WORDS = "Technical Data Sheet"
BODY_PT = 10       # headings bold at body size + 1 (platform: bold, not bigger than 11 pt)

KIND_RE = re.compile(r"(technical\s+data\s+sheet|product\s+data\s+sheet|data\s*sheet|"
                     r"specifications?|fiche\s+technique|technische?\s+(fiche|daten)|"
                     r"technisch\s+informatieblad|product\s+information|"
                     r"especificaci[oó]n|ficha\s+t[eé]cnica)", re.I)
PAGE_RE = re.compile(r"^\s*(page|pag\.?|pagina|seite|p\.)\s*\d+\s*(of|/|de|van|von)\s*\d+\s*$", re.I)
CODE_LABELS = re.compile(r"^(code|article|art\.?\s*(no|nr|n[ºo°])?\.?|item(\s*code)?|"
                         r"product\s*code|material\s*(no|nr|number)?|ref\.?|reference|"
                         r"doc(ument)?\.?\s*(no|nr|number)|sku|c[oó]digo)\s*:?\s*$", re.I)
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
URL_RE = re.compile(r"\b(?:https?://)?(?:www\.)[\w.-]+\.[a-z]{2,}(?:/\S*)?", re.I)
PHONE_RE = re.compile(r"(?:(?:tel|phone|fax|t|f|m)\.?\s*[:.]?\s*)?\+?\(?\d[\d ()/.-]{7,}\d", re.I)
LEGAL_RE = re.compile(r"\b[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*){0,4}\s*,?\s+"
                      r"(?:S\.?A\.?U?|S\.?L\.?U?|GmbH|N\.?V\.?|B\.?V\.?|Ltd\.?|LLC|Inc\.?|"
                      r"S\.?p\.?A\.?|SAS|SARL|AG|Corp\.?|Pvt\.?|Limited|Co\.,?\s*Ltd\.?)(?=\W|$)")


# ============================================================ 1. read the PDF
def _lines(page, scanned_words=None):
    """Words -> lines -> segments. A segment is a run of words with no wide gap;
    the gaps are where a label column ends and its value begins."""
    words = scanned_words if scanned_words is not None else page.extract_words(
        extra_attrs=["fontname", "size"], x_tolerance=2)
    # one line = words whose vertical centres lie close together; short OCR words
    # ("a", "or") sit lower than their neighbours, so the tolerance follows the height
    words = sorted(words, key=lambda w: ((w["top"] + w["bottom"]) / 2, w["x0"]))
    lines = []
    for w in words:
        c = (w["top"] + w["bottom"]) / 2
        tol = max(2.5, 0.45 * (w["bottom"] - w["top"]))
        if lines and abs(c - lines[-1]["c"]) <= tol:
            lines[-1]["words"].append(w)
        else:
            lines.append({"top": w["top"], "c": c, "words": [w]})
    for ln in lines:
        ln["top"] = min(w["top"] for w in ln["words"])
    out = []
    for ln in lines:
        ws = sorted(ln["words"], key=lambda w: w["x0"])
        segs = []
        for w in ws:
            size = float(w.get("size") or BODY_PT)
            gap = 3.2 * size / 2.6
            bold = "bold" in (w.get("fontname") or "").lower()
            if segs and w["x0"] - segs[-1]["x1"] <= gap and segs[-1]["bold"] == bold:
                s = segs[-1]
                s["text"] = (s["text"] + " " + w["text"].strip()).strip()
                s["x1"] = w["x1"]
                s["bold"] = s["bold"] and bold
                s["conf"] = min(s.get("conf", 100), w.get("conf", 100))
                s.setdefault("low", []).extend([w["text"]] if w.get("conf", 100) < 70 else [])
            else:
                segs.append({"text": w["text"].strip(), "x0": w["x0"], "x1": w["x1"],
                             "bold": bold, "size": size, "conf": w.get("conf", 100),
                             "low": [w["text"]] if w.get("conf", 100) < 70 else []})
        segs = [s for s in segs if s["text"]]
        if segs:
            out.append({"top": ln["top"], "bottom": max(w["bottom"] for w in ws),
                        "segs": segs, "size": max(s["size"] for s in segs)})
    return out


def _ocr_words(pdf_path, page_no):
    """Scanned page: Tesseract words with their confidence. A word under 70 %
    is marked yellow later, nothing is guessed (platform rule, 28/09)."""
    import pytesseract
    from pdf2image import convert_from_path
    img = convert_from_path(pdf_path, dpi=300, first_page=page_no, last_page=page_no)[0]
    d = pytesseract.image_to_data(img, output_type=pytesseract.Output.DICT)
    k = 72 / 300
    out = []
    for i, t in enumerate(d["text"]):
        if not t.strip():
            continue
        out.append({"text": t, "x0": d["left"][i] * k, "x1": (d["left"][i] + d["width"][i]) * k,
                    "top": d["top"][i] * k, "bottom": (d["top"][i] + d["height"][i]) * k,
                    "size": d["height"][i] * k * 1.3, "fontname": "",
                    "conf": float(d["conf"][i]) if str(d["conf"][i]) != "-1" else 100})
    return out


def read_pdf(pdf_path):
    import pdfplumber
    pages, notes, corpus = [], [], []
    with pdfplumber.open(pdf_path) as pdf:
        for i, page in enumerate(pdf.pages, 1):
            # letters a PDF prints twice to fake bold are read once (20/10/2026: a real TDS
            # came out as "OORRGGAALL")
            if hasattr(page, "dedupe_chars"):
                page = page.dedupe_chars(tolerance=1)
            txt = page.extract_text() or ""
            scanned = len(txt.strip()) < 80
            words = _ocr_words(pdf_path, i) if scanned else None
            lines = _lines(page, words)
            if scanned:
                corpus.append(" ".join(s["text"] for ln in lines for s in ln["segs"]))
            corpus.append(txt)
            for t in page.extract_tables() or []:
                for row in t:
                    corpus += [c.replace("\n", " ") for c in row if c]
            corpus += [" ".join(s["text"] for s in ln["segs"]) for ln in lines]
            corpus += [s["text"] for ln in lines for s in ln["segs"]]
            # the letterhead band: a picture at the top of the page (logo), never a
            # full-page scan image
            band = max([im["bottom"] for im in page.images if im["top"] < page.height * 0.15
                        and (im["bottom"] - im["top"]) < page.height * 0.2] or [0])
            body_imgs = [im for im in page.images
                         if im["top"] > max(band, page.height * 0.15) + 2
                         and im["bottom"] < page.height * 0.92
                         and (im["x1"] - im["x0"]) * (im["bottom"] - im["top"]) > 2500
                         and (im["bottom"] - im["top"]) < page.height * 0.8]
            for im in body_imgs:
                notes.append((i, im["top"], f"[picture on page {i} is not copied - check]"))
            pages.append({"no": i, "height": page.height, "band": band,
                          "lines": lines, "scanned": scanned})
    return pages, notes, corpus


# ========================================================= 2. lines -> blocks
def _is_heading_line(ln, has_bold):
    s = ln["segs"]
    if len(s) != 1:
        return False
    if has_bold:
        return s[0]["bold"]
    t = s[0]["text"]          # scan or no bold fonts: a short capitals or numbered line
    if len(t.split()) > 6 or len(t) <= 2 or re.search(r"[.:;,]$", t):
        return False
    return t.isupper() or bool(re.match(r"^\d+(?:\.\d+)*\.?\s+[A-Z]", t))


def structure(pages, notes):
    """-> meta, blocks, dropped, review

    A block is {"nummer","titel","items":[...]} with items of type
      kv    : rows of [label, value, label, value ...]
      table : head (or None) + rows
      para  : running text
    """
    meta = {"kind": "", "bron_product": ""}
    blocks, dropped, review = [], [], []
    has_bold = any(s["bold"] for p in pages for ln in p["lines"] for s in ln["segs"])
    sizes = sorted(s["size"] for p in pages for ln in p["lines"] for s in ln["segs"])
    body = sizes[len(sizes) // 2] if sizes else BODY_PT
    cur = None
    last_top = None

    def new_block(titel="", nummer=""):
        nonlocal cur
        cur = {"nummer": nummer, "titel": titel, "items": []}
        blocks.append(cur)
        return cur

    def item(kind):
        if cur is None or not cur["items"] or cur["items"][-1]["type"] != kind:
            if cur is None:
                new_block()
            it = {"type": kind, "rows": [], "head": None, "text": "", "x": None}
            cur["items"].append(it)
        return cur["items"][-1]

    for p in pages:
        lines = p["lines"]
        page_notes = sorted([n for n in notes if n[0] == p["no"]], key=lambda n: n[1])
        foot = p["height"] * 0.92
        for idx, ln in enumerate(lines):
            text = " ".join(s["text"] for s in ln["segs"])
            # --- letterhead band (logo area) and footer ---------------------
            if p["band"] and ln["bottom"] <= p["band"] + 1:
                dropped.append(("letterhead", text))
                continue
            if ln["top"] >= foot:
                if PAGE_RE.match(text) or all(PAGE_RE.match(s["text"]) for s in ln["segs"]):
                    dropped.append(("page number", text)); continue
                segs = [s for s in ln["segs"] if not PAGE_RE.match(s["text"])]
                rest = " ".join(s["text"] for s in segs)
                ident_like = (EMAIL_RE.search(rest) or URL_RE.search(rest) or LEGAL_RE.search(rest)
                              or re.search(r"\b\d{4,5}\b.*\b[A-Z][a-z]+", rest)
                              or re.search(r"\+?\d[\d ()/.-]{7,}\d", rest))
                sentence = len(re.findall(r"\b[a-z]{3,}\b", rest)) >= 4
                if sentence and not ident_like:
                    # a sentence in the footer (a disclaimer) is content: keep it, yellow
                    blocks.append({"nummer": "", "titel": "", "items": [
                        {"type": "para", "text": rest, "rows": [], "head": None, "x": None}]})
                    review.append((len(blocks) - 1, "", "footer sentence kept, check it belongs"))
                else:
                    dropped.append(("footer / letterhead / sign-off", rest))
                continue
            # --- notes for pictures that sit above this line -------------------
            while page_notes and page_notes[0][1] < ln["top"]:
                nb = new_block()
                nb["items"].append({"type": "para", "text": page_notes.pop(0)[2],
                                    "rows": [], "head": None, "x": None, "note": True})
            # --- the title: the big lines at the top of page 1 ----------------
            if p["no"] == 1 and not blocks and ln["size"] >= body * 1.35:
                if KIND_RE.fullmatch(text.strip()) and not meta["kind"]:
                    meta["kind"] = text.strip()
                elif not meta["bron_product"]:
                    meta["bron_product"] = text.strip()
                else:
                    meta["bron_product"] += " " + text.strip()
                last_top = ln["bottom"]
                continue
            gap = (ln["top"] - last_top) if last_top is not None else 0
            big_gap = gap > 2.4 * ln["size"]
            segs = ln["segs"]
            low = [w for s in segs for w in s.get("low", [])]

            nxt = lines[idx + 1] if idx + 1 < len(lines) else None
            prv_kv = cur and cur["items"] and cur["items"][-1]["type"] == "kv"
            if _is_heading_line(ln, has_bold):
                lab_x = segs[0]["x0"]
                nxt_kv = (nxt and len(nxt["segs"]) >= 2 and nxt["segs"][0]["bold"]
                          and abs(nxt["segs"][0]["x0"] - lab_x) < 4)
                same_as_kv = prv_kv and abs(cur["items"][-1]["x"] - lab_x) < 4 and not big_gap
                if has_bold and (nxt_kv or same_as_kv) and ln["size"] <= body * 1.1:
                    it = item("kv") if not big_gap or not prv_kv else None
                    if it is None:
                        new_block(); it = item("kv")
                    it["x"] = lab_x
                    it["rows"].append([segs[0]["text"], ""])
                else:
                    m = re.match(r"^(\d+(?:\.\d+)*)\.?\s+(.*)$", segs[0]["text"])
                    new_block(m.group(2) if m else segs[0]["text"], m.group(1) if m else "")
            elif has_bold and len(segs) >= 2 and all(s["bold"] for s in segs):
                if big_gap or cur is None:
                    new_block()
                it = {"type": "table", "rows": [], "head": [s["text"] for s in segs],
                      "text": "", "x": [s["x0"] for s in segs]}
                cur["items"].append(it)
            elif has_bold and len(segs) >= 2 and segs[0]["bold"]:
                if big_gap and prv_kv:
                    new_block()
                it = item("kv")
                it["x"] = segs[0]["x0"]
                row = []        # label, value, label, value ... (labels are bold)
                for s in segs:
                    if s["bold"]:
                        if len(row) % 2 == 1:
                            row.append("")
                        row.append(s["text"])
                    elif len(row) % 2 == 1:
                        row.append(s["text"])
                    elif row:
                        row[-1] = row[-1] + " " + s["text"]
                    else:
                        row += ["", s["text"]]
                if len(row) % 2:
                    row.append("")
                it["rows"].append(row)
            elif len(segs) >= 2:
                last = cur["items"][-1] if cur and cur["items"] else None
                if last is None or last["type"] != "table" or big_gap:
                    if big_gap or cur is None:
                        new_block()
                    last = {"type": "table", "rows": [], "head": None, "text": "",
                            "x": [s["x0"] for s in segs]}
                    cur["items"].append(last)
                last["rows"].append([s["text"] for s in segs])
            else:
                s = segs[0]
                if prv_kv and not big_gap and cur["items"][-1]["rows"]:
                    # house rule 4 / continuation: a value line under its label's value
                    it = cur["items"][-1]
                    it["rows"][-1][-1] = (it["rows"][-1][-1] + "\n" + s["text"]).strip("\n")
                else:
                    last = cur["items"][-1] if cur and cur["items"] else None
                    if last and last["type"] == "para" and not big_gap and not last.get("note"):
                        joint = " " if not re.search(r"[.:;!?]$", last["text"]) else "\n"
                        last["text"] += joint + s["text"]
                    else:
                        if big_gap and cur and cur["items"]:
                            new_block()
                        it = item("para")
                        it["text"] = s["text"] if not it["text"] else it["text"] + "\n" + s["text"]
            for w in low:
                review.append((len(blocks) - 1, w, "OCR could not read this word with certainty"))
            last_top = ln["bottom"]
        for n in page_notes:
            nb = new_block()
            nb["items"].append({"type": "para", "text": n[2], "rows": [], "head": None,
                                "x": None, "note": True})
    if not meta["bron_product"] and meta["kind"]:
        review.append((-1, "", "no product name found under the title"))
    n_head = sum(1 for b in blocks if b["titel"])
    n_struct = sum(1 for b in blocks for it in b["items"] if it["type"] in ("kv", "table"))
    if blocks and not n_head and not n_struct:
        review.append((-1, "", "layout not recognised (no headings, no tables): "
                               "check the whole sheet against the original"))
    return meta, blocks, dropped, review


# ================================================ 3. take the supplier out
def harvest_identity(pages, extra=None):
    """Strings that identify the supplier -> {token: kind}, plus the company names.
    kind says what the Transmare entity puts in its place (platform rule 8c: name
    for name, address for address, number for number, so nothing survives and no
    hole is left either): email, web, phone, address, other (other goes out)."""
    strong, names = {}, set()
    for p in pages:
        for ln in p["lines"]:
            t = " ".join(s["text"] for s in ln["segs"])
            for em in EMAIL_RE.findall(t):
                strong[em] = "email"
            for m in URL_RE.finditer(t):
                strong[m.group(0)] = "web"
            for m in PHONE_RE.finditer(t):
                if re.search(r"\+|tel|fax|phone|^\s*[tfm]\b", m.group(0), re.I) or \
                        len(re.sub(r"\D", "", m.group(0))) >= 9:
                    if not re.search(r"\d+\s*-\s*\d+\s*-\s*\d|\d{1,2}/\d{1,2}/\d{2,4}",
                                     m.group(0)):   # not a CAS / EC number, not a date
                        strong[m.group(0).strip()] = "phone"
            for m in LEGAL_RE.finditer(t):
                names.add(m.group(0).strip(" ,"))
    for em in [k for k, v in strong.items() if v == "email"]:
        strong.setdefault(em.split("@")[1], "web")
    if extra:
        if (extra.get("naam") or "").strip():
            names.add(extra["naam"].strip())
        if (extra.get("adres") or "").strip():
            strong[extra["adres"].strip()] = "address"
        for k, kind in (("telefoon", "phone"), ("email", "email"), ("website", "web"),
                        ("overig", "other")):
            for v in extra.get(k) or []:
                if str(v).strip():
                    strong.setdefault(str(v).strip(), kind)
    return ({t: k for t, k in strong.items() if len(t) > 3},
            {n for n in names if len(n) > 3})


# Only the company NAME is swapped for the entity's name. Address, telephone, e-mail and
# website are removed without replacement (Willem's platform rule for a TDS: "never add
# the entity's address, telephone, e-mail or website to a TDS"). A sentence that loses a
# contact detail that way is marked yellow, so he reads it once.
_KIND_FIELD = {}


def _scrub(text, strong, names, entity, strip=True):
    ent = entity if isinstance(entity, dict) else {"naam": entity}
    for n in sorted(names, key=len, reverse=True):
        text = text.replace(n, ent.get("naam", ""))
    for tok in sorted(strong, key=len, reverse=True):
        if tok in text:
            text = text.replace(tok, ent.get(_KIND_FIELD.get(strong[tok], ""), "") or "")
    text = re.sub(r"\(\s*\)|\[\s*\]", "", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip(" ,;/-\t") if strip else text


def neutralise(meta, blocks, strong, names, entity, product_name, dropped):
    ename = entity.get("naam", "Transmare Chemie NV")
    src_name = meta.get("bron_product", "")
    target = (product_name or "").strip() or src_name

    def fix(t, strip=True):
        if any(tok in t for tok in strong) and _scrub(t, strong, names, entity).strip():
            cur_flags.append(("", "a supplier contact detail was taken out of this text, "
                                  "check the sentence still reads right"))
        t = _scrub(t, strong, names, entity, strip)
        if product_name and src_name and src_name in t:
            t = t.replace(src_name, target)
        return close_hyphens(t)

    for b in blocks:
        cur_flags = b.setdefault("flags", [])
        b["titel"] = fix(b["titel"])
        keep = []
        for it in b["items"]:
            if it["type"] == "kv":
                rows = []
                for row in it["rows"]:
                    pairs = [(row[i], row[i + 1] if i + 1 < len(row) else "")
                             for i in range(0, len(row), 2)]
                    kept = []
                    for lab, val in pairs:
                        if CODE_LABELS.match(lab.strip()):
                            dropped.append(("supplier article / document code", f"{lab} {val}"))
                            continue
                        v = fix(val)
                        if val.strip() and not v.strip():
                            dropped.append(("supplier contact line", f"{lab} {val}"))
                            continue
                        kept += [fix(lab), v]
                    if kept:
                        rows.append(kept)
                it["rows"] = rows
                if rows:
                    keep.append(it)
            elif it["type"] == "table":
                it["head"] = [fix(c) for c in it["head"]] if it["head"] else None
                it["rows"] = [[fix(c) for c in r] for r in it["rows"]]
                keep.append(it)
            elif it["type"] == "rich":
                # a run keeps its own spaces: the next run carries on after it
                it["runs"] = [(t if t == "\n" or not t.strip() else fix(t, strip=False), f)
                              for t, f in it["runs"]]
                if any(t.strip() for t, _ in it["runs"]):
                    keep.append(it)
            else:
                if it.get("note"):
                    keep.append(it); continue
                lines = [fix(x) for x in it["text"].split("\n")]
                gone = [o for o, n in zip(it["text"].split("\n"), lines) if o.strip() and not n]
                dropped += [("supplier contact line", g) for g in gone]
                it["text"] = "\n".join(x for x in lines if x)
                if it["text"]:
                    keep.append(it)
        b["items"] = keep
        b["flags"] = list(dict.fromkeys(b["flags"]))
    blocks[:] = [b for b in blocks if b["items"] or b["titel"]]
    return target


def residual(blocks, strong, names):
    out = []
    for b in blocks:
        texts = [b["titel"]]
        for it in b["items"]:
            texts.append(it.get("text", ""))
            texts += [x for r in it.get("rows") or [] for x in r] + list(it.get("head") or [])
            texts.append("".join(t for t, _ in it.get("runs") or []))
        for t in texts:
            for tok in list(strong) + list(names):
                if tok and tok in (t or ""):
                    out.append((tok, t[:80]))
    return out


# ================================================ 4. the platform's own reading
class _Html(html.parser.HTMLParser):
    """The small tag set the platform writes (rule 6c): b i u br ul ol li sup sub table."""
    def __init__(self):
        super().__init__()
        self.items, self.fmt, self.runs = [], set(), []
        self.table = None
        self.row = None
        self.cell = None
        self.list_n = None

    def _flush(self):
        if self.runs and any(t.strip() for t, _ in self.runs):
            self.items.append({"type": "rich", "runs": self.runs})
        self.runs = []

    def handle_starttag(self, tag, attrs):
        if tag in ("b", "strong", "i", "em", "u", "sup", "sub", "mark"):
            self.fmt.add({"strong": "b", "em": "i"}.get(tag, tag))
        elif tag == "br":
            if self.cell is not None:
                self.cell.append(("\n", frozenset()))
            else:
                self.runs.append(("\n", frozenset()))
        elif tag == "table":
            self._flush(); self.table = {"type": "table", "head": None, "rows": []}
        elif tag == "tr":
            self.row = []
        elif tag in ("td", "th"):
            self.cell = []; self._th = tag == "th"
        elif tag in ("ul", "ol"):
            self._flush(); self.list_n = 0 if tag == "ol" else None
        elif tag == "li":
            self._flush()
            if self.list_n is not None:
                self.list_n += 1
            self.runs.append(((f"{self.list_n}. " if self.list_n else "• "), frozenset()))
        elif tag in ("p", "div"):
            self._flush()

    def handle_endtag(self, tag):
        if tag in ("b", "strong", "i", "em", "u", "sup", "sub", "mark"):
            self.fmt.discard({"strong": "b", "em": "i"}.get(tag, tag))
        elif tag in ("td", "th") and self.row is not None:
            self.row.append("".join(t for t, _ in self.cell).strip()); self.cell = None
        elif tag == "tr" and self.table is not None:
            if getattr(self, "_th", False) and self.table["head"] is None and not self.table["rows"]:
                self.table["head"] = self.row
            else:
                self.table["rows"].append(self.row)
            self.row = None
        elif tag == "table":
            self.items.append(self.table); self.table = None
        elif tag in ("li", "p", "div"):
            self._flush()

    def handle_data(self, data):
        if self.cell is not None:
            self.cell.append((data, frozenset(self.fmt)))
        else:
            self.runs.append((data, frozenset(self.fmt)))


def from_json(job):
    kop = job.get("kop") or {}
    meta = {"kind": "", "bron_product": (kop.get("bron_product") or "").strip()}
    blocks, review = [], []
    # "blokken" is the platform's document as Willem left it (sectie / tekst blocks, in his
    # order); "secties" is the older flattened copy. Prefer the first.
    src = [x for x in (job.get("blokken") or []) if x.get("type") in ("sectie", "tekst")] \
        or (job.get("secties") or [])
    for i, s in enumerate(src):
        titel = s.get("titel") if s.get("type") != "tekst" else s.get("kop")
        b = {"nummer": (s.get("nummer") or "").strip(), "titel": (titel or "").strip(),
             "items": []}
        h = (s.get("tekst_html") or "").strip()
        if h:
            hp = _Html(); hp.feed(h); hp._flush()
            b["items"] = hp.items
        elif (s.get("tekst") or "").strip():
            b["items"] = [{"type": "para", "text": s["tekst"].strip(), "rows": [], "head": None}]
        blocks.append(b)
    for o in job.get("onzeker") or []:
        if isinstance(o, dict) and o.get("ok"):
            continue                    # checked by him on screen: nothing to mark
        if not isinstance(o, dict):
            o = {"sleutel": str(o)}
        m = re.match(r"sectie\.(\d+)", str(o.get("sleutel", "")))
        review.append((int(m.group(1)) if m else -1, str(o.get("stuk") or ""),
                       str(o.get("reden") or "check against the original")))
    return meta, blocks, review, (kop.get("product") or "").strip()


# ================================================================ 5. build
def _p(doc, size=BODY_PT, before=0, after=2, keep=False, align=None):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before, pf.space_after, pf.line_spacing = Pt(before), Pt(after), 1.05
    pf.keep_with_next = keep
    if align is not None:
        p.alignment = align
    return p


def _runs(p, text, size=BODY_PT, bold=False, color=BLACK, yellow=()):
    """Write text; the exact uncertain words (yellow) get the highlight."""
    parts = [(text, False)]
    for y in sorted({y for y in yellow if y}, key=len, reverse=True):
        nxt = []
        for t, hl in parts:
            if hl or y not in t:
                nxt.append((t, hl)); continue
            bits = t.split(y)
            for k, bit in enumerate(bits):
                if bit:
                    nxt.append((bit, False))
                if k < len(bits) - 1:
                    nxt.append((y, True))
        parts = nxt
    for t, hl in parts:
        for k, line in enumerate(t.split("\n")):
            if k:
                p.add_run().add_break()
            if line:
                r = _style(p.add_run(line), size, bold, color)
                if hl or line.startswith("[") and line.endswith("- check]"):
                    mark_yellow(r)


def _cell(cell, text, bold=False, shade=None, yellow=()):
    cell.text = ""
    p = cell.paragraphs[0]
    p.paragraph_format.space_before = Pt(0.5)
    p.paragraph_format.space_after = Pt(0.5)
    _runs(p, text, BODY_PT, bold, yellow=yellow)
    if shade:
        _shade(cell, shade)


def build(meta, blocks, review, product, entity, output):
    tmp_dir = tempfile.mkdtemp(prefix="tmc_tds_")
    tmp = Path(tmp_dir) / "w.docx"
    shutil.copy(str(TEMPLATE), tmp)
    doc = Document(str(tmp))
    _clear_body(doc)
    apply_entity_footer(doc, entity)

    t = _p(doc, after=8, align=WD_ALIGN_PARAGRAPH.CENTER)
    _style(t.add_run(f"{TITLE_WORDS} – {product}" if product else TITLE_WORDS), 18, True, BLACK)
    if not product:
        _runs(t, "  [product name not found - check]", 10)

    for stuk, why in [(s_, w_) for bi, s_, w_ in review if bi < 0]:
        _runs(_p(doc, after=4), f"[{why} - check]", BODY_PT)

    W = 17.4
    for bi, b in enumerate(blocks):
        yel = [s for s, _ in b.get("flags", []) if s]
        for s, why in b.get("flags", []):
            if not s:
                _runs(_p(doc, after=2), f"[{why} - check]")
        head = ". ".join(x for x in (b["nummer"], b["titel"]) if x)
        if head:
            _runs(_p(doc, before=7, after=2, keep=True), head, 11, True, BLACK, yel)
        for it in b["items"]:
            if it["type"] == "para":
                _runs(_p(doc, after=3), it["text"], yellow=yel)
            elif it["type"] == "rich":
                p = _p(doc, after=3)
                for txt, fmt in it["runs"]:
                    if txt == "\n":
                        p.add_run().add_break(); continue
                    r = _style(p.add_run(close_hyphens(txt)), BODY_PT, "b" in fmt)
                    r.font.italic = "i" in fmt
                    r.font.underline = "u" in fmt
                    r.font.superscript = "sup" in fmt
                    r.font.subscript = "sub" in fmt
                    if any(y and y in txt for y in yel):
                        mark_yellow(r)
            elif it["type"] == "kv":
                ncol = max(len(r) for r in it["rows"])
                tb = doc.add_table(rows=len(it["rows"]), cols=ncol)
                tb.alignment = WD_TABLE_ALIGNMENT.LEFT
                tb.autofit = False
                lab = 4.0 if ncol == 2 else 3.2
                val = (W - lab * (ncol // 2)) / (ncol // 2)
                _fixed_layout(tb, [Cm(lab if k % 2 == 0 else val) for k in range(ncol)])
                for ri, row in enumerate(it["rows"]):
                    for k in range(ncol):
                        _cell(tb.rows[ri].cells[k], row[k] if k < len(row) else "",
                              bold=(k % 2 == 0), yellow=yel)
                    _row_props(tb.rows[ri])
                _p(doc, after=0).paragraph_format.space_after = Pt(1)
            elif it["type"] == "table":
                rows = ([it["head"]] if it["head"] else []) + it["rows"]
                ncol = max(len(r) for r in rows)
                tb = doc.add_table(rows=len(rows), cols=ncol)
                tb.alignment = WD_TABLE_ALIGNMENT.LEFT
                tb.autofit = False
                _borders(tb)
                first = 6.5 if ncol > 1 else W
                _fixed_layout(tb, [Cm(first)] + [Cm((W - first) / (ncol - 1))] * (ncol - 1)
                              if ncol > 1 else [Cm(W)])
                for ri, row in enumerate(rows):
                    hdr = bool(it["head"]) and ri == 0
                    for k in range(ncol):
                        _cell(tb.rows[ri].cells[k], row[k] if k < len(row) else "",
                              bold=hdr, shade=BAND_TABLE if hdr else None, yellow=yel)
                    _row_props(tb.rows[ri], header=hdr)
                _p(doc, after=0).paragraph_format.space_after = Pt(1)
    doc.core_properties.author = entity.get("naam", "")
    doc.core_properties.title = f"{TITLE_WORDS} – {product}"
    doc.core_properties.company = entity.get("naam", "")
    doc.save(str(output))
    shutil.rmtree(tmp_dir, ignore_errors=True)


# ================================================================ 6. main
def main():
    ap = argparse.ArgumentParser(description="TMC TDS / specification neutralizer")
    ap.add_argument("files", nargs="*")
    ap.add_argument("--output-dir", default=None)
    ap.add_argument("--product-name", default=None)
    ap.add_argument("--entity", default=None, help="entity JSON; default Transmare Chemie NV")
    ap.add_argument("--supplier-json", default=None,
                    help="the platform's 'leverancier' list, to be sure every identity string goes")
    ap.add_argument("--from-json", default=None, help="the platform's reading of this sheet")
    ap.add_argument("--approved", action="store_true",
                    help="with --from-json: the reading is Willem's approved 'inhoud' (Final). "
                         "His own words count as supplied values; build exactly that.")
    ap.add_argument("--finalise", action="store_true",
                    help="FILES are checked .docx drafts: render the PDF once no yellow is left")
    a = ap.parse_args()

    if a.finalise:
        bad = [f for f in a.files if not finalise(f)]
        sys.exit(1 if bad else 0)
    if a.approved and not a.from_json:
        sys.exit("--approved needs --from-json")
    if len(a.files) != 1:
        sys.exit("Give exactly one source PDF.")
    src = a.files[0]
    print("\nTransmare TDS / Specification Neutralizer")
    print("=" * 45)
    entity = load_entity(a.entity)
    code, _ = entity_code(entity)

    pages, notes, corpus = read_pdf(src)
    if any(p["scanned"] for p in pages):
        print("  i  scanned page(s): read with Tesseract; words under 70 % are marked yellow")
    supplier = json.loads(Path(a.supplier_json).read_text(encoding="utf-8")) if a.supplier_json else None
    product_given = (a.product_name or "").strip()
    if a.from_json:
        job = json.loads(Path(a.from_json).read_text(encoding="utf-8"))
        meta, blocks, review, jp = from_json(job)
        product_given = product_given or jp
        supplier = supplier or job.get("leverancier")
        dropped = []
        ident, names = harvest_identity(pages, supplier)
    else:
        meta, blocks, dropped, review = structure(pages, notes)
        ident, names = harvest_identity(pages, supplier)
    if not any(b["items"] or b["titel"] for b in blocks):
        sys.exit("FAIL  nothing could be read from this sheet. Nothing was written.")
    # flags travel with their block; only whole-sheet remarks stay in review
    for bi, stuk, why in review:
        if 0 <= bi < len(blocks):
            blocks[bi].setdefault("flags", []).append((stuk, why))
    review = [r for r in review if not 0 <= r[0] < len(blocks)]
    product = neutralise(meta, blocks, ident, names, entity, product_given, dropped)
    left = residual(blocks, ident, names)
    print(f"  i  source      : {len(pages)} page(s), kind '{meta.get('kind') or '-'}', "
          f"product '{meta.get('bron_product') or '-'}'")
    print(f"  i  blocks      : {len(blocks)}  (supplier strings found: {len(ident) + len(names)})")
    for why, t in dropped:
        print(f"  i  not copied ({why}): {t[:90]}")
    if left:
        print("  x  SUPPLIER IDENTITY STILL PRESENT:")
        for tok, ctx in left[:15]:
            print(f"       '{tok}' in \"{ctx}\"")
        sys.exit("Aborted: neutralisation incomplete. Nothing was written.")

    od = Path(a.output_dir) if a.output_dir else Path(src).parent
    od.mkdir(parents=True, exist_ok=True)
    stem = "_".join(x for x in (code, "TDS", safe_part(product)) if x)
    out, clash = non_clobbering(od / f"{stem}.docx")
    if clash:
        print(f"  !  {clash.name} already exists and is left untouched; written as {out.name}")
    build(meta, blocks, review, product, entity, out)

    # ---- HARD RULE: nothing in the output may be invented -----------------
    src_texts = corpus + [close_hyphens(t) for t in corpus]
    src_texts += [_scrub(t, ident, names, entity) for t in src_texts]
    if product_given and meta.get("bron_product"):
        src_texts += [t.replace(meta["bron_product"], product_given) for t in src_texts
                      if meta["bron_product"] in t]
    allowed = [v for v in entity.values()] + [product, TITLE_WORDS, "- check]"]
    allowed += [f"[{why} - check]" for _, _, why in review]
    allowed += [f"[{why} - check]" for b in blocks for _, why in b.get("flags", [])]
    if a.approved:
        # Final on the platform: every word in his approved reading is his, also the
        # paragraphs he typed himself. The gate still stops anything the BUILDER adds.
        def strings(x):
            if isinstance(x, str):
                yield x
            elif isinstance(x, dict):
                for v in x.values():
                    yield from strings(v)
            elif isinstance(x, list):
                for v in x:
                    yield from strings(v)
        jtxt = [re.sub(r"<[^>]+>", " ", t) for t in strings(job)]
        src_texts += jtxt + [close_hyphens(t) for t in jtxt] + \
            [_scrub(t, ident, names, entity) for t in jtxt]
    allowed += [n[2] for n in notes] + ["[product name not found - check]"]
    if code != "TMC":
        allowed.append("VAT:")
    try:
        provenance.assert_clean(str(out), src_texts, allowed, template_path=str(TEMPLATE),
                                on_fail=lambda: out.unlink(missing_ok=True))
    except RuntimeError as exc:
        print(f"  x  {exc}")
        sys.exit(1)
    print("  ok provenance: every string traced to the source or a supplied value")
    print(f"  ok DOCX -> {out.name}")

    flags = [(b["titel"] or f"block {i + 1}", s_, w_) for i, b in enumerate(blocks)
             for s_, w_ in b.get("flags", [])]
    marks = len(review) + len(flags) + sum(1 for b in blocks for it in b["items"] if it.get("note"))
    if marks:
        print(f"  !  REVIEW: {marks} part(s) marked yellow, PDF held back until checked:")
        for _, stuk, why in review:
            print(f"       - sheet: {why}")
        for where, stuk, why in flags:
            print(f"       - {where}: {stuk or '(whole part)'} - {why}")
        for b in blocks:
            for it in b["items"]:
                if it.get("note"):
                    print(f"       - {it['text']}")
        print(f"     Check in Word, remove the highlight, then: --finalise \"{out}\"")
        sys.exit(EXIT_REVIEW)
    pdf = render_pdf(out)
    print(f"  ok PDF  -> {pdf.name}")
    print("\nDone. Delivered as .docx + .pdf pair.\n")


if __name__ == "__main__":
    main()
