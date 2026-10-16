#!/usr/bin/env python3
"""Regression for v0.6.0 (15/10/2026). Builds its own synthetic supplier documents
(no real supplier files in the plugin) and checks every new rule:

  1. COA: Quality standard carries the spec as printed, ranges closed up (house rule 2)
  2. COA: empty required fields -> yellow, exit 2, no PDF; --finalise stays locked
  3. TDS: supplier name -> entity name in sentences, e-mail / phone -> entity's,
          footer address and page number not copied, provenance passes, pair written
  4. TDS --from-json: an invented sentence is refused and nothing is written
  5. dispatcher: spec sheet -> TDS, COA -> COA
Run:  python3 tests/test_v060_routes.py      (needs reportlab, LibreOffice)
"""
import json, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
S = HERE.parent / "scripts"
PY = sys.executable
try:
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
except ImportError:
    sys.exit("SKIP: reportlab not installed")


def coa_pdf(p, dates=True):
    c = canvas.Canvas(str(p), pagesize=A4); W, H = A4
    c.setFont("Helvetica", 9); c.drawString(40, H - 40, "ACME Chemicals GmbH, Tel +49 30 1234567")
    c.setFont("Helvetica-Bold", 16); c.drawString(40, H - 80, "CERTIFICATE OF ANALYSIS")
    c.setFont("Helvetica", 10); y = H - 110
    for t in ["Product: Sodium Benzoate", "Batch No: SB-2026-114"] + (
            ["Manufacturing Date: 02/09/2026", "Expiry Date: 01/09/2029"] if dates else []):
        c.drawString(40, y, t); y -= 14
    y -= 10
    for row in [("Test", "Specification", "Result", "Unit"), ("Appearance", "White powder", "Complies", "-"),
                ("Assay", "99.0 - 100.5", "99.6", "%"), ("Loss on drying", "NMT 1.5", "0.4", "%")]:
        for x, v in zip((40, 180, 330, 430), row):
            c.drawString(x, y, v)
        y -= 14
    c.save()


def tds_pdf(p, kind="Technical Data Sheet", contacts=True):
    c = canvas.Canvas(str(p), pagesize=A4); W, H = A4
    c.setFont("Helvetica-Bold", 22); c.drawString(40, H - 100, kind)
    c.setFont("Helvetica", 16); c.drawString(40, H - 125, "GLYCOSOFT 200")
    y = H - 165
    c.setFont("Helvetica-Bold", 10); c.drawString(40, y, "1. Description"); y -= 15
    c.setFont("Helvetica", 9); c.drawString(40, y, "Glycosoft 200 is a mild emulsifier for creams."); y -= 22
    c.setFont("Helvetica-Bold", 9); c.drawString(40, y, "Property"); c.drawString(250, y, "Value"); y -= 12
    c.setFont("Helvetica", 9); c.drawString(40, y, "HLB"); c.drawString(250, y, "12 - 13"); y -= 22
    if not contacts:
        c.save(); return
    c.setFont("Helvetica-Bold", 10); c.drawString(40, y, "2. Disclaimer"); y -= 15
    c.setFont("Helvetica", 9)
    c.drawString(40, y, "Acme Oleo GmbH guarantees the information above to the best of its knowledge."); y -= 12
    c.drawString(40, y, "For questions contact info@acme-oleo.de or call +49 40 555 1234.")
    c.setFont("Helvetica", 7)
    c.drawString(40, 40, "Acme Oleo GmbH - Hafenstrasse 12 - 20457 Hamburg - www.acme-oleo.de")
    c.drawString(480, 40, "Page 1 of 1")
    c.save()


def run(*a):
    r = subprocess.run([PY, "-I", *map(str, a)], capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


ok = bad = 0
def check(name, cond, info=""):
    global ok, bad
    print(("  ok  " if cond else "  XX  ") + name + ("" if cond else f"\n{info[-1500:]}"))
    ok, bad = ok + bool(cond), bad + (not cond)


with tempfile.TemporaryDirectory() as d:
    d = Path(d)
    coa_pdf(d / "coa.pdf"); coa_pdf(d / "coa_nodates.pdf", dates=False)
    tds_pdf(d / "tds.pdf"); tds_pdf(d / "spec.pdf", kind="SPECIFICATIONS", contacts=False)

    rc, out = run(S / "neutralize_docx.py", d / "coa.pdf", "--output-dir", d / "o1",
                  "--product-name", "Sodium Benzoate", "--file-nr", "840.S0999")
    pdfs = list((d / "o1").glob("*.pdf"))
    txt = subprocess.run(["pdftotext", "-layout", str(pdfs[0]), "-"], capture_output=True,
                         text=True).stdout if pdfs else ""
    check("COA pair written", rc == 0 and pdfs, out)
    check("COA quality standard = spec as printed", "NMT 1.5" in txt and "White powder" in txt, txt)
    check("COA range closed up (house rule 2)", "99.0-100.5" in txt, txt)
    check("COA supplier gone", "ACME" not in txt and "+49" not in txt, txt)

    rc, out = run(S / "neutralize_docx.py", d / "coa_nodates.pdf", "--output-dir", d / "o2",
                  "--product-name", "Sodium Benzoate")
    check("COA missing dates -> exit 2, no PDF", rc == 2 and not list((d / "o2").glob("*.pdf")), out)
    dx = list((d / "o2").glob("*.docx"))
    rc, out = run(S / "neutralize_docx.py", "--finalise", dx[0]) if dx else (0, "")
    check("COA finalise locked while yellow", rc == 1, out)

    rc, out = run(S / "neutralize_tds_docx.py", d / "tds.pdf", "--output-dir", d / "o3")
    dx = list((d / "o3").glob("*.docx"))
    from docx import Document
    txt = "\n".join(p.text for p in Document(str(dx[0])).paragraphs) if dx else ""
    check("TDS with a contact taken out of a sentence -> yellow draft (exit 2, no PDF)",
          rc == 2 and dx and not list((d / "o3").glob("*.pdf")), out)
    check("TDS title", "Technical Data Sheet – GLYCOSOFT 200" in txt, txt)
    check("TDS supplier name -> Transmare in sentence",
          "Transmare Chemie NV guarantees" in txt and "Acme" not in txt, txt)
    check("TDS contacts removed, never replaced by the entity's (platform TDS rule)",
          "acme-oleo" not in txt and "+49" not in txt and "trans@transmare.com" not in txt
          and "+32 3 21398 40" not in txt, txt)
    check("TDS footer address / page number not copied", "Hafenstrasse" not in txt, txt)
    if dx:
        doc = Document(str(dx[0]))
        for p in doc.paragraphs:
            for r in p.runs:
                r.font.highlight_color = None
        doc.save(str(dx[0]))
        rc, out = run(S / "neutralize_tds_docx.py", "--finalise", dx[0])
        check("TDS finalise after the check -> PDF", rc == 0 and dx[0].with_suffix(".pdf").exists(), out)

    rc, out = run(S / "neutralize_tds_docx.py", d / "spec.pdf", "--output-dir", d / "o3b",
                  "--product-name", "GLYCOSOFT 200")
    check("spec sheet without contacts -> pair straight away",
          rc == 0 and list((d / "o3b").glob("*.pdf")), out)

    job = {"kop": {"bron_product": "GLYCOSOFT 200"},
           "secties": [{"nummer": "1", "titel": "Description",
                        "tekst_html": "Glycosoft 200 is a mild emulsifier for creams. "
                                      "It is approved for food use worldwide."}],
           "leverancier": {"naam": "Acme Oleo GmbH"}, "onzeker": []}
    (d / "bad.json").write_text(json.dumps(job))
    rc, out = run(S / "neutralize_tds_docx.py", d / "tds.pdf", "--from-json", d / "bad.json",
                  "--output-dir", d / "o4")
    check("TDS invented sentence refused, nothing written",
          rc == 1 and not list((d / "o4").glob("*.docx")), out)

    rc, out = run(S / "neutralize.py", d / "spec.pdf", d / "coa.pdf", "--output-dir", d / "o5",
                  "--product-name", "X")
    check("dispatcher routes spec -> TDS and COA -> COA",
          "spec.pdf  ->  TDS" in out and "coa.pdf  ->  COA" in out, out)

print(f"\n{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
