#!/usr/bin/env python3
"""How the MSDS reader reads real-world PDFs (20/10/2026, learned on Willem's real MSDS on the
laptop; every case here is a synthetic copy, no real document is in git).

  1. letters printed twice to fake bold are read once
  2. a letter in another font, a point lower, stays in its word ("l'écart")
  3. a page number line is not glued into a paragraph
  4. a box drawn around a whole section is a frame, not a table: 1.3 and 1.4 are found
  5. "SECTION 2: ..." is a section heading also when it is not bold
  6. the emergency number on the 1.4 heading line itself is replaced by TMC's
Run:  python tests/test_sds_reading.py      (needs reportlab)
"""
import json, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "scripts"))
try:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
except ImportError:
    sys.exit("SKIP: reportlab not installed")
import pdfplumber  # noqa: E402
from extract_sds import _lines, extract  # noqa: E402
from neutralise_sds import find_supplier_block, neutralise  # noqa: E402

ok = bad = 0
def check(name, cond, info=""):
    global ok, bad
    print(("  ok  " if cond else "  XX  ") + name + ("" if cond else f"\n{str(info)[:1500]}"))
    ok, bad = ok + bool(cond), bad + (not cond)


W, H = A4
with tempfile.TemporaryDirectory() as d:
    d = Path(d)

    # 1-3: one page with fake bold, a split French word and a page number between paragraphs
    p = d / "reading.pdf"
    c = canvas.Canvas(str(p), pagesize=A4)
    c.setFont("Helvetica-Bold", 12)
    for dx in (0, 0.3):                                   # the same title drawn twice, 0.3 pt apart
        c.drawString(40 + dx, H - 150, "ORGAWHITE 2000")
    c.setFont("Helvetica", 10)
    c.drawString(40, H - 200, "Tenir à l")
    x = 40 + c.stringWidth("Tenir à l", "Helvetica", 10)
    c.setFont("Times-Roman", 10); c.drawString(x, H - 201, "’é")         # other font, 1 pt lower
    x += c.stringWidth("’é", "Times-Roman", 10)
    c.setFont("Helvetica", 10); c.drawString(x, H - 200, "cart de la chaleur.")
    c.drawString(40, H - 260, "1 / 1")                       # its own page count
    c.save()
    with pdfplumber.open(str(p)) as pdf:
        texts = [ln["text"] for ln in _lines(pdf.pages[0])]
    check("fake bold is read once", "ORGAWHITE 2000" in texts, texts)
    check("a letter in another font stays in its word", any("l’écart de la chaleur." in t for t in texts), texts)
    check("a page number line is not read as content", "1 / 1" not in texts, texts)

    # 4-6: every section in a drawn box, 1.4 number on the heading line, plain SECTION lines
    p = d / "boxed.pdf"
    c = canvas.Canvas(str(p), pagesize=A4)
    c.setFont("Helvetica", 9)
    y = H - 130
    lines = ["SECTION 1: IDENTIFICATION OF THE SUBSTANCE/MIXTURE AND OF THE COMPANY/UNDERTAKING",
             "1.1 Product identifier: BEST FRIEND",
             "1.3 Details of the supplier of the safety data sheet:",
             "EXAMPLE FRAGRANCE S.L", "C/ Example 19, 08640 Olesa", "Phone: +34 900 000 000 info@example-fragrance.com",
             "1.4 Emergency telephone number: +34 900000000 (Mon-Thu: 8-17h)"]
    top = y + 12
    for t in lines:
        c.drawString(46, y, t); y -= 14
    c.rect(40, y + 8, W - 80, top - y - 8)                  # the box around section 1
    y -= 20
    top2 = y + 12
    c.drawString(46, y, "SECTION 2: HAZARDS IDENTIFICATION"); y -= 14
    c.drawString(46, y, "2.1 Classification of the substance or mixture: not classified"); y -= 14
    c.rect(40, y + 8, W - 80, top2 - y - 8)
    c.save()
    els, meta = extract(str(p))
    kinds = [(e["kind"], (e.get("text") or "")[:30]) for e in els]
    check("a box around a section is not a table", not any(e["kind"] == "table" for e in els), kinds)
    check("'SECTION 2: ...' is a section heading", any(e["kind"] == "section" and e["text"].startswith("SECTION 2") for e in els), kinds)
    lo, hi = find_supplier_block(els)
    check("1.3 found inside the box, block ends at 1.4", lo is not None and [e.get("text") for e in els[lo:hi]] ==
          ["EXAMPLE FRAGRANCE S.L", "C/ Example 19, 08640 Olesa", "Phone: +34 900 000 000 info@example-fragrance.com"], kinds)
    ent = json.loads((ROOT / "entity.example.json").read_text(encoding="utf-8"))
    out, _meta, rep = neutralise(els, meta, ent, "Best Friend", None)
    body = "\n".join(e.get("text", "") for e in out)
    check("the supplier's emergency number on the 1.4 line is replaced", "+34 900000000" not in body and ent["nood"] in body, body)
    check("the 1.4 heading and TMC's number are two lines (each traceable)",
          any(e.get("text") == "1.4 Emergency telephone number:" for e in out), body)
    check("no supplier identity left", "example-fragrance" not in body.lower() and "EXAMPLE FRAGRANCE" not in body, body)

# review F2: the overprint rule follows the letter size; real repeated letters are never merged
with tempfile.TemporaryDirectory() as d:
    p = Path(d) / "sizes.pdf"
    c = canvas.Canvas(str(p), pagesize=A4)
    for size, y in ((22, 700), (6, 650)):
        c.setFont("Helvetica-Bold", size)
        for dx in (0, size * 0.044):                      # fake bold, as measured on a real PDF
            c.drawString(40 + dx, y - dx, "ORGAL")
    c.setFont("Helvetica", 4); c.drawString(40, 600, "Assay 1100 ll 00")   # real repeats, tiny font
    c.save()
    with pdfplumber.open(str(p)) as pdf:
        texts = [ln["text"] for ln in _lines(pdf.pages[0])]
    check("fake bold read once at size 22 and at size 6", texts.count("ORGAL") == 2, texts)
    check("real repeated letters in a 4 pt font stay ('1100', 'll', '00')", "Assay 1100 ll 00" in texts, texts)

# review fixes: real content is never dropped or cut short
from extract_sds import _is_page_number  # noqa: E402
check("'2 / 21' on a 21-page MSDS is a page number", _is_page_number("2 / 21", 21))
check("'1 / 10' on a 21-page MSDS is content (review F1)", not _is_page_number("1 / 10", 21))
check("'Page 3 of 8' is a page number", _is_page_number("Page 3 of 8", 21))
els = [{"kind": "para", "text": "1.3 Supplier"}, {"kind": "table", "rows": [["Company", "Example SA"]]}, {"kind": "para", "text": "1.4 Emergency"}]
try:
    neutralise(els, {}, json.loads((ROOT / "entity.example.json").read_text(encoding="utf-8")), None, None)
    check("a table inside 1.3 is refused for a person (review F4)", False)
except ValueError:
    check("a table inside 1.3 is refused for a person (review F4)", True)
els = [{"kind": "para", "text": "1.3 Supplier"}, {"kind": "para", "text": "Example SA"},
       {"kind": "para", "text": "1.4 Emergency telephone number: (see section 16)"}, {"kind": "section", "text": "SECTION 2: X"}]
out, _m, _r = neutralise(els, {}, json.loads((ROOT / "entity.example.json").read_text(encoding="utf-8")), None, None)
check("'(see section 16)' after 1.4 is not taken for a phone number (review F5)",
      any(e.get("text") == "1.4 Emergency telephone number: (see section 16)" for e in out), [e.get("text") for e in out])

print(f"\n{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
