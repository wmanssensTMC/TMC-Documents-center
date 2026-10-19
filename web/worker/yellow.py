#!/usr/bin/env python3
"""Yellow parts of an engine draft, for the on-screen check (phase 2c).

Reuses the engine's own helpers (tmc_common: same walk as yellow_runs, render_pdf); the
engine itself is not changed. A yellow mark is only removed for a part a person confirmed
on the check screen -- never automatically (BRIEF 7.2).

  python yellow.py --engine DIR list DOCX                     -> JSON list on stdout
  python yellow.py --engine DIR apply DOCX FIXES.json OUT.docx
  python yellow.py --engine DIR preview DOCX OUT.pdf          -> PDF stamped DRAFT
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
        r.font.highlight_color = None
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
        if n and f" {n} " not in f" {haystack} " and n.replace(" ", "") not in compact:
            sys.exit(f"refused: the {label} '{value}' is not printed in the document; "
                     "the file name must match the document, so change one of them")


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
    ap.add_argument("command", choices=["list", "apply", "preview", "check"])
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
    elif a.command == "check" and len(a.paths) in (2, 3):
        cmd_check(a.paths[0], a.paths[1], scripts, a.paths[2] if len(a.paths) == 3 else None)
    else:
        ap.error("wrong number of paths")


if __name__ == "__main__":
    main()
