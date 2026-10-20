#!/usr/bin/env python3
"""Rules learned from Willem's real dossiers (20/10/2026, run on the laptop only; no real
document is in this test or in git). Each case is a synthetic copy of what went wrong.
Run:  python tests/test_real_corpus_rules.py      (the last check needs reportlab and LibreOffice)
"""
import subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
import neutralize_docx as N  # noqa: E402

ok = bad = 0
def check(name, cond, info=""):
    global ok, bad
    print(("  ok  " if cond else "  XX  ") + name + ("" if cond else f"\n{info}"))
    ok, bad = ok + bool(cond), bad + (not cond)


# 1. a purchase order that asks for "a certificate of analysis" is not a COA
po = ("PURCHASE ORDER PO019192\nTransmare Chemie NV\nItalielei 124, Antwerpen\nSupplier: Example BV\n"
      "Lactose 500 KG\nPlease send the certificate of analysis with every batch.")
check("purchase order is not a COA, even when it mentions one", N.classify_file(po) == "PURCHASE_ORDER", N.classify_file(po))
coa = "CERTIFICATE OF ANALYSIS\nCustomer purchase order: 4711\nBatch: A1"
check("a COA that quotes the customer's order stays a COA", N.classify_file(coa) == "COA")
check("'Contrat de vente' is a sales contract", N.classify_file("CONTRAT DE VENTE 840.S0938") == "SALES_CONTRACT")

# 2. TMC file nr: sales file number first; PO number on a purchase order (Willem 20/10)
sale = N.parse_ref_fields({"full_text": "ORDER CONFIRMATION\nYour order no PO020435832\nOur ref 837.S1190\nDate 01/10/2026"})
check("the TMC sales file number wins over a customer order number", sale.get("doc_ref") == "837.S1190", sale)
purchase = N.parse_ref_fields({"full_text": po})
check("on a purchase order the TMC PO number is the file nr", purchase.get("doc_ref") == "PO019192", purchase)
check("and the document is named a Purchase Order", purchase.get("_doc_type") == "Purchase Order")

# 3. specifications as European suppliers print them; the value stays as printed
for spec, want in [("1,0180 - 1,0250", ("1,0180", "1,0250")), (">/= 98,0", ("98,0", "")), ("</= 0,040", ("", "0,040")),
                   ("9,0 ÷ 10,3", ("9,0", "10,3")), ("99.0 - 100.5", ("99.0", "100.5")), ("≤ 5", ("", "5")), ("NMT 1.5", ("", "1.5"))]:
    check(f"spec {spec!r} -> {want}", N.parse_spec(spec) == want, N.parse_spec(spec))

# 4. columns are cut between words, never through one
header = "Characteristics          Specification     Result     Unit     Method"
line   = "Acidity as Acetic Acid   0,0050 Max.       <0,0050    %        ASTM D 1613"
starts = [header.index(w) for w in ("Characteristics", "Specification", "Result", "Unit", "Method")]
cells = N._cells_by_columns(line, starts)
check("a label is never cut in two", cells[0] == "Acidity as Acetic Acid" and cells[1] == "0,0050 Max.", cells)

# 5. running text under the table ends it
check("a disclaimer line is prose", N._is_prose("unable to exercise any control over the use of the products, including designing, testing"))
check("a test row is not prose", not N._is_prose("Appearance 20% solution   Limpid and colourless   Limpid and colourless   E 045"))

# 6. dates: format labels and the next field are not part of the date
check("format label removed", N._clean_date("(mm/dd/yy) 11/24/25") == "11/24/25", N._clean_date("(mm/dd/yy) 11/24/25"))
check("the next field is cut off", N._clean_date("12/2025 EXPIRY DATE 12/2028") == "12/2025", N._clean_date("12/2025 EXPIRY DATE 12/2028"))
check("a plain date is left as printed", N._clean_date("29th January 2028") == "29th January 2028")

# 7. "Lot/ Batchnumber : 101143", and "Date of production" is not a product name
f = N.parse_coa_fields({"full_text": "CERTIFICATE OF ANALYSIS\nLot/ Batchnumber : 101143\nDate of production : 11.2024\nRetest date : 10.2028",
                        "pages": [], "tables": [], "source": "x.pdf"})
check("batch read from 'Lot/ Batchnumber'", f.get("batch_lot") == "101143", f)
check("'Date of production' is not a product name", not (f.get("product_name") or "").startswith("ion"), f.get("product_name"))

# 8. separate MIN / MAX columns: limits filled, no joined text as Quality standard
row = N._build_test_row(["Colour", "", "10", "1", "APHA"], {"param": 0, "lim_min": 1, "lim_max": 2, "result": 3, "unit": 4})
check("MIN/MAX columns give the limits", row and N.parse_spec(row[1]) == ("", "10"), row)
check("and are marked as put together (not printed as Quality standard)", row and isinstance(row[1], N.ComposedSpec), row)

# 9. a file that is not recognised is reported, never silently left out (needs reportlab + LibreOffice)
try:
    from reportlab.pdfgen import canvas
    from reportlab.lib.pagesizes import A4
except ImportError:
    canvas = None
if canvas:
    with tempfile.TemporaryDirectory() as d:
        d = Path(d)
        c = canvas.Canvas(str(d / "coa.pdf"), pagesize=A4); W, H = A4
        for i, t in enumerate(["CERTIFICATE OF ANALYSIS", "Product: Sodium Benzoate", "Batch No: SB-1", "Manufacturing Date: 02/09/2026",
                               "Expiry Date: 01/09/2029", "Test   Specification   Result   Unit", "Assay   99.0 - 100.5   99.6   %"]):
            c.drawString(40, H - 80 - i * 16, t)
        c.save()
        c = canvas.Canvas(str(d / "letter.pdf")); c.drawString(72, 720, "Dear customer, thank you for your kind order and best regards."); c.save()
        r = subprocess.run([sys.executable, "-I", str(HERE.parent / "scripts" / "neutralize_docx.py"), str(d / "coa.pdf"), str(d / "letter.pdf"),
                            "--output-dir", str(d / "out"), "--product-name", "Sodium Benzoate", "--file-nr", "840.S0999"],
                           capture_output=True, text=True)
        out = r.stdout + r.stderr
        check("an unrecognised file is listed as NOT PROCESSED", "NOT PROCESSED" in out and "letter.pdf" in out, out[-1500:])
        check("and the run asks for a person (exit 2), the COA itself is made", r.returncode == 2 and list((d / "out").glob("*.docx")), f"exit {r.returncode}")
else:
    print("  skip unrecognised-file run (no reportlab)")

print(f"\n{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
