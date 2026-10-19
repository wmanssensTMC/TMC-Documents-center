#!/usr/bin/env python3
"""Yellow parts of an engine draft, for the on-screen check (phase 2c).

Reuses the engine's own helpers (tmc_common: same walk as yellow_runs, render_pdf); the
engine itself is not changed. A yellow mark is only removed for a part a person confirmed
on the check screen -- never automatically (BRIEF 7.2).

  python yellow.py --engine DIR list DOCX                     -> JSON list on stdout
  python yellow.py --engine DIR apply DOCX FIXES.json OUT.docx
  python yellow.py --engine DIR preview DOCX OUT.pdf          -> PDF stamped DRAFT
  python yellow.py --engine DIR changes DRAFT EDITED SOURCE.pdf -> JSON list of changes on stdout
  python yellow.py --engine DIR check DOCX FORBID.json [SHOWN.json]
                                     -> exit 1 if unsafe, names the supplier, or does not
                                        print a value of its file name (SHOWN: [[label, value]])
"""
import argparse, io, json, re, shutil, sys, tempfile
from pathlib import Path


def runs_in_order(doc):
    """Highlighted runs exactly as the engine reads them (tmc_common.iter_highlighted):
    body, tables, nested tables, text boxes, headers and footers. One walk for both the
    check screen and the engine's --finalise, so they can never disagree."""
    from tmc_common import iter_highlighted
    return list(iter_highlighted(doc))


def cmd_list(docx):
    from docx import Document
    doc = Document(str(docx))
    items = []
    for i, (r, p) in enumerate(runs_in_order(doc)):
        # Over 500 characters: too long for the on-screen editor, check it in Word (review M1).
        items.append({"id": f"y{i}", "text": r.text[:500], "context": (p.text if p is not None else r.text)[:300], "truncated": len(r.text) > 500})
    json.dump(items, sys.stdout, ensure_ascii=False)


def cmd_apply(docx, fixes_path, out):
    from docx import Document
    from tmc_common import clear_mark
    fixes = json.loads(Path(fixes_path).read_text(encoding="utf-8"))
    doc = Document(str(docx))
    found = runs_in_order(doc)
    ids = {f"y{i}" for i in range(len(found))}
    unknown = set(fixes) - ids
    if unknown:
        print(f"unknown yellow part(s): {sorted(unknown)}", file=sys.stderr)
        sys.exit(1)
    for i, (r, _p) in enumerate(found):
        fix = fixes.get(f"y{i}")
        if fix is None:
            continue  # not confirmed: stays yellow, finalise will refuse
        if len(r.text) > 500:
            print(f"y{i}: too long for the on-screen check; check it in Word", file=sys.stderr)
            sys.exit(1)
        value = str(fix.get("value", ""))
        if any(ord(ch) < 32 for ch in value) or len(value) > 500:
            print(f"y{i}: value refused", file=sys.stderr)
            sys.exit(1)
        if value != r.text:          # "OK as is" never touches the text (review M1)
            r.text = value
        clear_mark(r)                # highlight and yellow shading
    doc.save(str(out))


# Uploaded Word files are untrusted (reviews M2/N1/N2). Checked on the raw file, before
# python-docx or LibreOffice read it.
MAX_UNZIPPED = 100 * 1024 * 1024
MAX_ENTRIES = 2000
FORBIDDEN_PARTS = ("vbaproject.bin", "/embeddings/", "/activex/")
# Field codes that make Word or LibreOffice fetch or include outside content.
FIELD_RE = re.compile(r"\b(INCLUDEPICTURE|INCLUDETEXT|INCLUDE|LINK|DDEAUTO|DDE|IMPORT)\b", re.I)
REL_HYPERLINK = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"
W_NS = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def read_all(z, info, budget):
    """Real bytes, not the size the zip claims (a crafted file can understate it)."""
    out = bytearray()
    with z.open(info) as f:
        while chunk := f.read(65536):
            out += chunk
            budget[0] -= len(chunk)
            if budget[0] < 0:
                sys.exit("refused: the Word file unpacks too large")
    return bytes(out)


A_NS = "{http://schemas.openxmlformats.org/drawingml/2006/main}"


def xml_text(root):
    """All text of a part, per paragraph: Word text (w:t), deleted text (w:delText) and text
    in charts and diagrams (a:t) -- review N1."""
    kinds = (f"{W_NS}t", f"{W_NS}delText", f"{A_NS}t")
    lines = []
    for p in list(root.iter(f"{W_NS}p")) + list(root.iter(f"{A_NS}p")):
        lines.append("".join(e.text or "" for e in p.iter() if e.tag in kinds))
    return "\n".join(lines)


def cmd_check(docx, forbid_path, engine_scripts, shown_path=None):
    """Refuses a Word file that is not safe to process, that names the supplier (rule 3), or
    that does not print a value its file name is made of (name and content agree, Willem 19/10)."""
    import xml.etree.ElementTree as ET
    import zipfile
    sys.path.insert(0, str(engine_scripts))
    from provenance import norm               # the engine's own normalisation

    texts = []
    budget = [MAX_UNZIPPED]
    try:
        with zipfile.ZipFile(docx) as z:
            infos = z.infolist()
            if len(infos) > MAX_ENTRIES:
                sys.exit("refused: the Word file has too many parts")
            for i in infos:
                name = "/" + i.filename.lower()
                if any(f in name for f in FORBIDDEN_PARTS):
                    sys.exit("refused: the Word file contains macros or embedded objects")
                data = read_all(z, i, budget)
                if name.endswith(".rels"):
                    for rel in ET.fromstring(data):
                        mode = next((v for k, v in rel.attrib.items() if k.lower() == "targetmode"), "")
                        if mode.lower() == "external" and rel.attrib.get("Type") != REL_HYPERLINK:
                            sys.exit("refused: the Word file links to outside content")
                        texts.append(rel.attrib.get("Target", ""))   # link addresses too (review F2)
                elif name.startswith("/word/") and name.endswith(".xml"):
                    root = ET.fromstring(data)
                    # Tracked changes keep deleted text that a PDF may still show (review N1).
                    if next(root.iter(f"{W_NS}ins"), None) is not None or next(root.iter(f"{W_NS}del"), None) is not None:
                        sys.exit("refused: the Word file has tracked changes; accept or reject all changes first")
                    if b"instrText" in data or b"fldSimple" in data:
                        codes = [t.text or "" for t in root.iter(f"{W_NS}instrText")]
                        codes += [e.get(f"{W_NS}instr", "") for e in root.iter(f"{W_NS}fldSimple")]
                        if any(FIELD_RE.search(c) for c in codes):
                            sys.exit("refused: the Word file includes outside content through a field")
                    # body, headers, footers, footnotes, endnotes, comments, text boxes, charts
                    texts.append(xml_text(root))
                    # field codes (HYPERLINK "...") and bookmark-link targets are not shown as text
                    texts.extend(t.text or "" for t in root.iter(f"{W_NS}instrText"))
                    texts.extend(h.get(f"{W_NS}anchor", "") for h in root.iter(f"{W_NS}hyperlink"))
                elif name in ("/docprops/core.xml", "/docprops/app.xml"):
                    root = ET.fromstring(data)
                    texts.extend(e.text or "" for e in root.iter())
    except (zipfile.BadZipFile, ET.ParseError):
        sys.exit("refused: not a valid Word file")

    haystack = norm("\n".join(texts))
    compact = haystack.replace(" ", "")
    for supplier in json.loads(Path(forbid_path).read_text(encoding="utf-8")):
        n = norm(supplier)
        if len(n) < 3:
            continue
        if f" {n} " in f" {haystack} " or (len(n.replace(' ', '')) >= 6 and n.replace(" ", "") in compact):
            sys.exit("refused: the document still names the supplier")

    for label, value in json.loads(Path(shown_path).read_text(encoding="utf-8")) if shown_path else []:
        n = norm(value)
        # norm() keeps Latin letters and digits only: a value with other letters, or too
        # short to mean anything, cannot be checked and is refused (review M2)
        shortest = 3 if label == "product name" else 2      # review R3
        if not latin_only(value) or len(n.replace(" ", "")) < shortest:
            sys.exit(f"refused: the {label} '{value}' cannot be checked against the document; "
                     "use Latin letters and digits")
        # whole words only: "Acetone" must not match inside another name
        if f" {n} " not in f" {haystack} ":
            sys.exit(f"refused: the {label} '{value}' is not printed in the document; "
                     "the file name must match the document, so change one of them")


def latin_only(value):
    """True when every letter or digit is plain Latin once accents are taken off."""
    import unicodedata
    t = unicodedata.normalize("NFKD", value)
    return all(ord(ch) < 128 or unicodedata.combining(ch) or not ch.isalnum() for ch in t)


MC_FALLBACK = "{http://schemas.openxmlformats.org/markup-compatibility/2006}Fallback"


def paragraph_texts(docx):
    """Every paragraph's text in reading order: body (tables, text boxes), then headers and
    footers. A text box is stored twice by Word; only the shown version is read."""
    import xml.etree.ElementTree as ET
    import zipfile
    P, T = f"{W_NS}p", f"{W_NS}t"

    def walk(el, out):
        for c in el:
            if c.tag == MC_FALLBACK:
                continue
            if c.tag == P:
                own, nested = [], []
                collect(c, own, nested)
                out.append("".join(own))
                out.extend(nested)
            else:
                walk(c, out)

    def collect(el, own, nested):
        for c in el:
            if c.tag == MC_FALLBACK:
                continue
            if c.tag == T:
                own.append(c.text or "")
            elif c.tag == P:
                walk(_wrap(c), nested)          # a text box inside this paragraph
            else:
                collect(c, own, nested)

    def _wrap(p):
        holder = ET.Element("holder")
        holder.append(p)
        return holder

    out = []
    with zipfile.ZipFile(docx) as z:
        names = z.namelist()
        parts = ["word/document.xml"] + sorted(n for n in names if re.fullmatch(r"word/(header|footer)\d*\.xml", n))
        # also footnotes, endnotes and comments (review F7)
        parts += ["word/footnotes.xml", "word/endnotes.xml", "word/comments.xml"]
        for n in parts:
            if n in names:
                walk(ET.fromstring(z.read(n)), out)
    return [t.strip() for t in out if t.strip()]


# A word or a number as written: "99.6", "0,4", "SB-2026-114" stay whole, so 99.6 -> 6.99 is a change.
WORD = re.compile(r"[^\W_]+(?:[.,/:-][^\W_]+)*")


def words(text):
    import unicodedata
    return {w.lower() for w in WORD.findall(unicodedata.normalize("NFKC", text))}


def pictures(docx):
    """Fingerprints of the pictures in a Word file."""
    import hashlib
    import zipfile
    with zipfile.ZipFile(docx) as z:
        return {hashlib.sha256(z.read(n)).hexdigest() for n in z.namelist() if n.lower().startswith("word/media/")}


def cmd_changes(draft, edited, source_pdf):
    """What a person changed on screen, as JSON: [{before, after, unknown}]. unknown = new words
    or numbers that are not in the supplier original: a warning, the person may go on (Willem
    19/10). Nothing is refused here; the safety checks are in cmd_check."""
    import difflib
    import unicodedata
    import pdfplumber

    try:
        with pdfplumber.open(source_pdf) as pdf:
            source = "\n".join(p.extract_text() or "" for p in pdf.pages[:200])
    except Exception:
        source = ""                                # unreadable original: every new value warns
    known = words(source)

    # capped so a huge file cannot hold the worker for minutes (review F6)
    full_a, full_b = paragraph_texts(draft), paragraph_texts(edited)
    a, b = full_a[:20000], full_b[:20000]
    changes = []
    if len(full_a) > 20000 or len(full_b) > 20000:
        changes.append({"before": "", "after": "[very long document: only the first 20000 paragraphs were compared]",
                        "unknown": ["check the rest yourself"]})
    # a picture that was not in the draft: it could be a supplier logo (review F2)
    for _ in range(len(pictures(edited) - pictures(draft))):
        changes.append({"before": "", "after": "[new picture added]", "unknown": ["picture: check it is not a supplier logo"]})
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == "equal":
            continue
        before, after = "\n".join(a[i1:i2]), "\n".join(b[j1:j2])
        had = words(before)
        unknown = []
        for word in WORD.findall(unicodedata.normalize("NFKC", after)):
            if word.lower() not in had and word.lower() not in known and word not in unknown:
                unknown.append(word)
        changes.append({"before": before[:500], "after": after[:500], "unknown": unknown[:20]})
        if len(changes) >= 200:
            break
    json.dump(changes, sys.stdout, ensure_ascii=False)


def cmd_preview(docx, out, engine_scripts):
    sys.path.insert(0, str(engine_scripts))
    from tmc_common import render_pdf          # the engine's own Word -> PDF
    from pypdf import PdfReader, PdfWriter
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas

    with tempfile.TemporaryDirectory() as d:
        copy = Path(d) / "draft.docx"
        shutil.copy(docx, copy)
        pdf = render_pdf(copy)
        reader = PdfReader(str(pdf))
        writer = PdfWriter()
        for page in reader.pages:
            w, h = float(page.mediabox.width), float(page.mediabox.height)
            buf = io.BytesIO()
            c = canvas.Canvas(buf, pagesize=(w, h) if w and h else A4)
            c.setFillColorRGB(0.85, 0.1, 0.1, alpha=0.25)
            c.setFont("Helvetica-Bold", 54)
            c.translate(w / 2, h / 2)
            c.rotate(45)
            c.drawCentredString(0, 0, "DRAFT - NOT FOR USE")
            c.save()
            buf.seek(0)
            page.merge_page(PdfReader(buf).pages[0])
            writer.add_page(page)
        with open(out, "wb") as f:
            writer.write(f)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--engine", required=True, help="engine folder (contains scripts/)")
    ap.add_argument("command", choices=["list", "apply", "preview", "check", "changes"])
    ap.add_argument("paths", nargs="+")
    a = ap.parse_args()
    scripts = Path(a.engine) / "scripts"
    sys.path.insert(0, str(scripts))
    if a.command == "list" and len(a.paths) == 1:
        cmd_list(a.paths[0])
    elif a.command == "apply" and len(a.paths) == 3:
        cmd_apply(*a.paths)
    elif a.command == "preview" and len(a.paths) == 2:
        cmd_preview(a.paths[0], a.paths[1], scripts)
    elif a.command == "changes" and len(a.paths) == 3:
        cmd_changes(a.paths[0], a.paths[1], a.paths[2])
    elif a.command == "check" and len(a.paths) in (2, 3):
        cmd_check(a.paths[0], a.paths[1], scripts, a.paths[2] if len(a.paths) == 3 else None)
    else:
        ap.error("wrong number of paths")


if __name__ == "__main__":
    main()
