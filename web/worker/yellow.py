#!/usr/bin/env python3
"""Yellow parts of an engine draft, for the on-screen check (phase 2c).

Reuses the engine's own helpers (tmc_common: same walk as yellow_runs, render_pdf); the
engine itself is not changed. A yellow mark is only removed for a part a person confirmed
on the check screen -- never automatically (BRIEF 7.2).

  python yellow.py --engine DIR list DOCX                     -> JSON list on stdout
  python yellow.py --engine DIR apply DOCX FIXES.json OUT.docx
  python yellow.py --engine DIR preview DOCX OUT.pdf          -> PDF stamped DRAFT
  python yellow.py --engine DIR check DOCX FORBID.json        -> exit 1 if unsafe or names the supplier
"""
import argparse, io, json, shutil, sys, tempfile
from pathlib import Path


def runs_in_order(doc):
    """Highlighted runs in the order yellow_runs() reads them, each run once
    (a merged table cell appears several times in python-docx)."""
    from docx.enum.text import WD_COLOR_INDEX
    seen = set()
    out = []

    def scan(paragraphs):
        for p in paragraphs:
            for r in p.runs:
                if r.font.highlight_color in (None, WD_COLOR_INDEX.AUTO) or not r.text.strip():
                    continue
                if id(r._r) in seen:
                    continue
                seen.add(id(r._r))
                out.append((r, p))

    scan(doc.paragraphs)
    for t in doc.tables:
        for row in t.rows:
            for c in row.cells:
                scan(c.paragraphs)
    return out


def cmd_list(docx):
    from docx import Document
    doc = Document(str(docx))
    items = []
    for i, (r, p) in enumerate(runs_in_order(doc)):
        # Over 500 characters: too long for the on-screen editor, check it in Word (review M1).
        items.append({"id": f"y{i}", "text": r.text[:500], "context": p.text[:300], "truncated": len(r.text) > 500})
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


# Uploaded Word files are untrusted (review M2): limits before python-docx or LibreOffice see them.
MAX_UNZIPPED = 100 * 1024 * 1024
MAX_ENTRIES = 2000
FORBIDDEN_PARTS = ("vbaproject.bin", "/embeddings/", "/activex/")


def all_text(doc):
    parts = []

    def walk(container):
        for p in container.paragraphs:
            parts.append(p.text)
        for t in container.tables:
            for row in t.rows:
                for c in row.cells:
                    walk(c)

    walk(doc)
    for s in doc.sections:
        for hf in (s.header, s.footer, s.first_page_header, s.first_page_footer, s.even_page_header, s.even_page_footer):
            walk(hf)
    return "\n".join(parts)


def norm(s):
    return " ".join(str(s).casefold().split())


def cmd_check(docx, forbid_path):
    """Refuses a Word file that is not safe to process, or that names the supplier (rule 3)."""
    import zipfile
    try:
        with zipfile.ZipFile(docx) as z:
            infos = z.infolist()
            if len(infos) > MAX_ENTRIES or sum(i.file_size for i in infos) > MAX_UNZIPPED:
                sys.exit("refused: the Word file unpacks too large")
            for i in infos:
                name = "/" + i.filename.lower()
                if any(f in name for f in FORBIDDEN_PARTS):
                    sys.exit("refused: the Word file contains macros or embedded objects")
                if name.endswith(".rels") and b'TargetMode="External"' in z.read(i):
                    sys.exit("refused: the Word file links to outside content")
    except zipfile.BadZipFile:
        sys.exit("refused: not a Word file")
    from docx import Document
    text = norm(all_text(Document(str(docx))))
    for name in json.loads(Path(forbid_path).read_text(encoding="utf-8")):
        if len(norm(name)) >= 3 and norm(name) in text:
            sys.exit("refused: the document still names the supplier")


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
    elif a.command == "check" and len(a.paths) == 2:
        cmd_check(*a.paths)
    else:
        ap.error("wrong number of paths")


if __name__ == "__main__":
    main()
