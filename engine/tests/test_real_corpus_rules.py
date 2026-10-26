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

# 10. header words only as whole words; a row with numbers is never a header
check("'Free Amine' is not the 'min' column", N._classify_hdr("Free Amine") is None, N._classify_hdr("Free Amine"))
check("'Test results (avg)' is still a result header", N._classify_hdr("Test results (avg)") == "result")
data = {"full_text": "x", "pages": [], "source": "x.pdf", "tables": [{"page": 1, "rows": [
    ["TEST PARAMETER", "UOM", "SPECIFICATION", "RESULTS"],
    ["Free Amine", "%", "5.0 Max.", "5.0"],
    ["Free Fatty Acid", "%", "Nil", "Nil"]]}]}
rows = N.parse_coa_fields(data).get("results_table") or []
check("a row with 'Amine' and 'Max.' is kept as a test row", any(r[0] == "Free Amine" for r in rows), rows)
check("'Nil' is a value, not an empty cell", any(r[0] == "Free Fatty Acid" and r[1] == "Nil" and r[2] == "Nil" for r in rows), rows)

# 11. a header shifted by merged cells; an unnamed result column; a 'Pesticide' first column
data = {"full_text": "x", "pages": [], "source": "x.pdf", "tables": [
    {"page": 1, "rows": [["", "TEST PARAMETER", "", "UOM", "SPECIFICATION", "RESULTS"],
                         ["Moisture Content", None, None, "%", "0.5 Max.", "0.1"]]},
    {"page": 1, "rows": [["ANALYSIS", "UNIT", "METHOD", "SPECIFICATION", ""],
                         ["Acid value", "mg KOH/g", "USP", "MAX. 1", "0,4"], ["Water", "%", "USP", "MAX. 0,25", "0,1"],
                         ["Manufacture date (mm/dd/yy)", "", "", "", "11/24/25"]]},
    {"page": 2, "rows": [["Pesticide", "Specification", "Detected amount", "Result"], ["Aldrin", "≤ 10 ppm", "<0,05 ppm", "OK"]]}]}
rows = N.parse_coa_fields(data).get("results_table") or []
check("shifted header: the test name is found", any(r[0] == "Moisture Content" and r[2] == "0.1" for r in rows), rows)
check("unnamed result column is used", any(r[0] == "Acid value" and r[2] == "0,4" for r in rows), rows)
check("a date line is not a test result", not any("date" in r[0].lower() for r in rows), rows)
check("'Pesticide' table: first column is the test, detected amount the result",
      any(r[0] == "Aldrin" and r[2] == "<0,05 ppm" for r in rows), rows)

# 12. purchase order: the trade name on the next line belongs to the item; tariff lines do not
ref = N.parse_ref_fields({"full_text": "PURCHASE ORDER PO019192\nNo. Description Qty\n"
                          "100413-BAG25 Lactose Monohydrate 600 BAG 25 15.000,00 KG 2,550\nPharmatose 200M\n"
                          "100417-DRUM50 Lactose Anhydrous 36 DRUM 50 1.800,00 KG 5,650\nSupertab 21AN\nTotal Net Qty.: 16.800,00\n"})
names = [p["name"] for p in ref.get("_products", [])]
check("item code removed and trade name kept", names == ["Lactose Monohydrate Pharmatose 200M", "Lactose Anhydrous Supertab 21AN"], names)
sale = N.parse_ref_fields({"full_text": "ORDER CONFIRMATION 837.S1190\nCocamide DEA 1 IBC 1.000 KG 2,10\nCustoms Tariff: 34024200, Net Weight"})
check("a 'Customs Tariff:' line is not part of the name", [p["name"] for p in sale.get("_products", [])] == ["Cocamide DEA"],
      sale.get("_products"))

# 13. never guess the product: two order lines that fit equally well -> empty (yellow)
prods = [{"name": "Lactose Monohydrate Pharmatose 200M"}, {"name": "Lactose Monohydrate Supertab 11SD"}]
check("a tie between order lines gives no product name", N.match_pfi_product({"product_name": "lactose monohydrate"}, prods) == "")
check("a clear match still gives the name",
      N.match_pfi_product({"product_name": "Supertab 11SD lactose"}, prods) == "Lactose Monohydrate Supertab 11SD")

# 14. the same batch in two files: one document if identical, held back if different
def job(src, lot, result):
    return ({"_source": src, "batch_lot": lot, "results_table": [["Assay", "", result, "%", ""]], "expiry_date": "2028"}, {}, "P", 1)
held = []
kept = N._one_document_per_batch([job("a.pdf", "L1", "99.5"), job("b.pdf", "L1", "99.5"), job("c.pdf", "L2", "1")], held)
check("identical certificate twice: one document", [j[0]["_source"] for j in kept] == ["a.pdf", "c.pdf"] and not held, (kept, held))
held = []
kept = N._one_document_per_batch([job("a.pdf", "L1", "99.5"), job("b.pdf", "L1", "98.0")], held)
check("same batch, different data: held back, no document", kept == [] and held, (kept, held))

# 15. "SLED" is the expiry date
f = N.parse_coa_fields({"full_text": "Batch number: BI30564743 Date of analysis:29.01.2026\nSLED: 28.01.2028",
                        "pages": [], "tables": [], "source": "x.pdf"})
check("SLED is read as the expiry date", f.get("expiry_date") == "28.01.2028", f.get("expiry_date"))
check("an analysis date is not taken as production date", not f.get("manufacture_date"), f.get("manufacture_date"))

# 16. MSDS: section 1.3 found however it is written (real MSDS: "1.3 Fournisseur" as a plain line)
from neutralise_sds import _sec_no, find_supplier_block  # noqa: E402
check("section numbers in their usual forms", [_sec_no(t) for t in ("1.3 Fournisseur", "1.3.", "SECTION 1.3: Details", "28 Rue de Renory",
                                                                  "100 %", "1 IDENTIFICATION")]
      == ["1.3", "1.3", "1.3", "28", None, "1"], [_sec_no(t) for t in ("1.3 Fournisseur", "1.3.", "SECTION 1.3: Details", "28 Rue de Renory", "100 %", "1 IDENTIFICATION")])
els = [{"kind": "para", "text": "1.2 Uses"}, {"kind": "para", "text": "1.3 Fournisseur"}, {"kind": "para", "text": "Example SA"},
       {"kind": "para", "text": "Rue de Renory 28"}, {"kind": "sub", "text": "SCC Number : CU-1"}, {"kind": "para", "text": "1.4 Urgence"},
       {"kind": "para", "text": "+32 4 000 00 00"}]
check("the supplier block runs from 1.3 to 1.4, certificate number included", find_supplier_block(els) == (2, 5), find_supplier_block(els))
els = [{"kind": "para", "text": "1.3 Supplier"}, {"kind": "para", "text": "Example SA"}, {"kind": "para", "text": "5 Rue de la Paix"},
       {"kind": "para", "text": "75002 Paris"}, {"kind": "para", "text": "1.4 Emergency"}]
check("an address line '5 Rue de la Paix' does not end the supplier block (review R1)", find_supplier_block(els) == (1, 4),
      find_supplier_block(els))
try:
    find_supplier_block([{"kind": "para", "text": "1.3 Supplier"}, {"kind": "para", "text": "Example SA"}])
    check("a 1.3 block without an end is refused (review R2)", False)
except ValueError:
    check("a 1.3 block without an end is refused (review R2)", True)

import json  # noqa: E402
from neutralise_sds import neutralise  # noqa: E402
ent = json.loads((HERE.parent / "entity.example.json").read_text(encoding="utf-8"))
els = [{"kind": "sub", "text": "1 IDENTIFICATION"}, {"kind": "para", "text": "1.3 Supplier"}, {"kind": "para", "text": "Example Chemicals SA"},
       {"kind": "para", "text": "info@example-chem.com"}, {"kind": "para", "text": "1.4 Emergency telephone"},
       {"kind": "para", "text": "24 h/24 +32 4 000 00 00"}, {"kind": "sub", "text": "2 HAZARDS IDENTIFICATION"}]
out, _meta, _rep = neutralise(els, {}, ent, None, None)
texts = [e.get("text", "") for e in out]
check("a 1.4 emergency number starting with a digit is replaced by TMC's (review)",
      "24 h/24 +32 4 000 00 00" not in texts and any("58 45 45" in t for t in texts), texts)

# 17. the trade-name line only where the order's layout proves it (review R3); date clean-up stays fast (R4)
ref = N.parse_ref_fields({"full_text": "PURCHASE ORDER PO019192\nNo. Description Qty\n"
                          "100413-BAG25 Lactose Monohydrate 600 BAG 25 15.000,00 KG 2,550\nBulk\nDelivery terms CIP"})
check("a line not followed by another item or the total is not part of the name",
      [p["name"] for p in ref.get("_products", [])] == ["Lactose Monohydrate"], ref.get("_products"))
import time  # noqa: E402
t0 = time.time(); N._clean_date("11/24/25" + " " * 20000 + "x"); N._clean_date(" " * 20000)
check("date clean-up is fast on long space runs", time.time() - t0 < 0.5, time.time() - t0)

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

# 26/10/2026, real COA (first live run): "Batch: LOT2504280" was dropped as if "LOT" were a label
check("a batch code that starts with LOT is kept", N.clean_identifier("LOT2504280") == "LOT2504280")
check("a label alone is still no batch", N.clean_identifier("Lot No") == "" and N.clean_identifier("Batch") == "")
check("the Batch line is read from the text",
      N.parse_coa_fields({"full_text": "EUXYL PE 9010 Material Number: 967371\nBatch: LOT2504280\n",
                          "tables": []}).get("batch_lot") == "LOT2504280")
# ...and the LOT fix lets no label or sentence through as a batch
check("a label with a short number is still no batch", N.clean_identifier("Lot No 12") == "")
check("a sentence with a long number is no batch",
      N.clean_identifier("please see the batch number 2504280 on the label") == "")
check("a sentence around a LOT code is no batch",
      N.clean_identifier("see attached certificate LOT2504280 for details") == "")
check("an over-long LOT code is no batch", N.clean_identifier("LOT" + "1" * 50) == "")
check("a Batch line holding only a label gives no batch",
      N.parse_coa_fields({"full_text": "EUXYL PE 9010\nBatch: Lot No\n", "tables": []}).get("batch_lot") in ("", None))

# 26/10/2026 scorecard (real COA): "Method of analysis" is the method column, not a second name column
_, cols = N._find_test_header_row([["Characteristic", "Method of analysis", "Unit", "Specification", "Results"]])
check("'Method of analysis' is the method column", cols.get("method") == 1 and cols.get("param") == 0, cols)
check("a test whose name holds a header word is kept: 'Identification (Flame test)'",
      N._build_test_row(["Identification (Flame test)", "D: USP-NF", "", "Pass", "Pass"], cols) is not None)
check("a repeated header row is still skipped",
      N._build_test_row(["Characteristic", "Method of analysis", "Unit", "Specification", "Results"], cols) is None)

# 26/10/2026 scorecard (real scanned COA): "Batch No U3/P1/MP/ 1610925" was cut at the space
check("a batch that goes on after a slash and a space is read whole",
      N.parse_coa_fields({"full_text": "Batch No       U3/P1/MP/ 1610925\nPack Size 148", "tables": []}).get("batch_lot")
      == "U3/P1/MP/ 1610925")
check("a batch cut off after a slash is no batch (yellow), never printed half",
      N.parse_coa_fields({"full_text": "Batch No U3/P1/MP/\nPack Size", "tables": []}).get("batch_lot") in ("", None))
# ...and missing rows are flagged: the gate catches invented text, not text left out
lay = "\n".join(["Sr. TESTS   SPECIFICATIONS   OBSERVATIONS", "1   Description   White powder   Complies",
                 "    crystals.", "2   Solubility   Slightly soluble   Complies", "3   Identification",
                 "4   Color of solution   clear   Complies", "Remarks: meets USP"])
check("numbered tests in the original are counted (1, 2, 3, 4)", N.numbered_tests(lay) == 4, N.numbered_tests(lay))
check("an address or a date line is no numbered test run",
      N.numbered_tests("12 Main Street\n2025 Production\n1 kg drum") == 0)

# security review R1: only one code token; a label stuck to a code or a date stays yellow for a person
check("a label stuck to a date is no batch",
      N.clean_identifier("Date:28.04.2025") == "" and N.clean_identifier("Expiry2027-01-31") == "")
check("a label in front of a LOT code is no batch", N.clean_identifier("Lot No. LOT2504280") == "")
check("'No.123' is a label with a number, no batch", N.clean_identifier("No.123") == "")

print(f"\n{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
