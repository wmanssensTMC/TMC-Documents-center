#!/usr/bin/env python3
"""COA batches in the COA route (19/10/2026, Willem: "connect side-by-side batches,
duplicate-lot and page-marker checks in the engine, add the multi-batch guard").

Builds its own synthetic supplier COAs (no supplier files needed) and checks:
  1. side by side: one result column per batch -> one document per batch, each with its
     own lot and its own dates; the batch is written next to the document (.meta.json)
  2. a typed batch on a COA with several batches is refused, nothing written
  3. the same lot twice with only another quantity -> one document, noted
  4. the same lot twice with another analysis result -> held back for a person (exit 2)
  5. "Page 1 of 3" in a one-page file -> refused as incomplete (exit 1)
Run:  python tests/test_coa_batches_route.py      (needs reportlab, LibreOffice)
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

COLS = (300, 380, 460)      # centres of the result columns


def page(c, lots, rows, marker=None):
    W, H = A4
    c.setFont("Helvetica-Bold", 16); c.drawString(40, H - 80, "CERTIFICATE OF ANALYSIS")
    c.setFont("Helvetica", 10); c.drawString(40, H - 110, "Product: Sodium Benzoate")
    y = H - 150
    c.drawString(40, y, "Parameter"); c.drawCentredString(210, y, "Unit")
    for x in COLS[:len(lots)]:
        c.drawCentredString(x, y, "Result")
    y -= 18
    c.drawString(40, y, "Lot No.")
    for x, lot in zip(COLS, lots):
        c.drawCentredString(x, y, lot)
    for label, unit, values in rows:
        y -= 18
        c.drawString(40, y, label)
        if unit:
            c.drawCentredString(210, y, unit)
        for x, v in zip(COLS, values):
            c.drawCentredString(x, y, v)
    if marker:
        c.drawString(480, 40, marker)
    c.showPage()


ROWS = [("Production date", "", ("02/09/2026", "03/09/2026", "04/09/2026")),
        ("Expiry date", "", ("01/09/2029", "02/09/2029", "03/09/2029")),
        ("Assay", "%", ("99.5", "99.6", "99.7")),
        ("Loss on drying", "%", ("0.10", "0.12", "0.11"))]


def side_by_side(p):
    c = canvas.Canvas(str(p), pagesize=A4)
    page(c, ("L-001", "L-002", "L-003"), ROWS)
    c.save()


def duplicate(p, assay_page2="99.5"):
    """Lot L-001 on both pages; page 2 has another quantity (and maybe another assay)."""
    c = canvas.Canvas(str(p), pagesize=A4)
    page(c, ("L-001", "L-002"), [ROWS[0], ROWS[1], ("Assay", "%", ("99.5", "99.6")),
                                 ("Quantity", "kg", ("500", "250"))], "Page 1 of 2")
    page(c, ("L-001", "L-004"), [ROWS[0], ROWS[1], ("Assay", "%", (assay_page2, "99.8")),
                                 ("Quantity", "kg", ("750", "100"))], "Page 2 of 2")
    c.save()


def incomplete(p):
    c = canvas.Canvas(str(p), pagesize=A4)
    page(c, ("L-001", "L-002"), ROWS, "Page 1 of 3")
    c.save()


def run(*a):
    r = subprocess.run([PY, "-I", *map(str, a)], capture_output=True, text=True)
    return r.returncode, r.stdout + r.stderr


ok = bad = 0
def check(name, cond, info=""):
    global ok, bad
    print(("  ok  " if cond else "  XX  ") + name + ("" if cond else f"\n{info[-2000:]}"))
    ok, bad = ok + bool(cond), bad + (not cond)


ARGS = ("--product-name", "Sodium Benzoate", "--file-nr", "840.S0999")

with tempfile.TemporaryDirectory() as d:
    d = Path(d)
    side_by_side(d / "sbs.pdf"); duplicate(d / "dup.pdf"); duplicate(d / "conflict.pdf", "98.1")
    incomplete(d / "incomplete.pdf")

    rc, out = run(S / "neutralize_docx.py", d / "sbs.pdf", "--output-dir", d / "o1", *ARGS)
    names = sorted(p.stem for p in (d / "o1").glob("*.docx"))
    check("side by side: one document per batch", rc == 0 and names == [
        "TMC_COA_840.S0999_Sodium_Benzoate_L-001", "TMC_COA_840.S0999_Sodium_Benzoate_L-002",
        "TMC_COA_840.S0999_Sodium_Benzoate_L-003"], out + str(names))
    check("side by side: every document has its PDF", len(list((d / "o1").glob("*.pdf"))) == 3, out)
    txt = subprocess.run(["pdftotext", "-layout", str(d / "o1" / "TMC_COA_840.S0999_Sodium_Benzoate_L-002.pdf"), "-"],
                         capture_output=True, text=True).stdout if (d / "o1").exists() else ""
    check("each batch gets its own values and dates, not the neighbour's",
          "99.6" in txt and "03/09/2026" in txt and "02/09/2029" in txt
          and "99.5" not in txt and "99.7" not in txt and "02/09/2026" not in txt, txt)
    meta = d / "o1" / "TMC_COA_840.S0999_Sodium_Benzoate_L-003.meta.json"
    check("the batch is written next to the document for the platform",
          meta.exists() and json.loads(meta.read_text())["batch"] == "L-003", out)

    rc, out = run(S / "neutralize_docx.py", d / "sbs.pdf", "--output-dir", d / "o2", *ARGS, "--batch", "L-001")
    check("a typed batch on a multi-batch COA is refused, nothing written",
          rc == 1 and "leave Batch empty" in out and not list((d / "o2").glob("*.docx")), out)

    rc, out = run(S / "neutralize_docx.py", d / "dup.pdf", "--output-dir", d / "o3", *ARGS)
    names = sorted(p.stem.rsplit("_", 1)[-1] for p in (d / "o3").glob("*.docx"))
    check("same lot twice, only the quantity differs: one document per lot",
          rc == 0 and names == ["L-001", "L-002", "L-004"], out + str(names))
    check("and the other issuance is noted", "different issuance" in out, out)

    rc, out = run(S / "neutralize_docx.py", d / "conflict.pdf", "--output-dir", d / "o4", *ARGS)
    names = sorted(p.stem.rsplit("_", 1)[-1] for p in (d / "o4").glob("*.docx"))
    check("same lot twice with another analysis result: held back, the rest goes on (exit 2)",
          rc == 2 and "HELD BACK" in out and names == ["L-002", "L-004"], out + str(names))

    rc, out = run(S / "neutralize_docx.py", d / "incomplete.pdf", "--output-dir", d / "o5", *ARGS)
    check("'Page 1 of 3' in a one-page file is refused as incomplete",
          rc == 1 and "incomplete" in out and not list((d / "o5").glob("*.docx")), out)

print(f"\n{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
