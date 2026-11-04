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

# security review of the scorecard round (26/10/2026)
_m = {"param": 0, "method": 1, "unit": 2, "spec": 3, "result": 4}
check("R1: a supplier or lab line is never a test row",
      all(N._build_test_row(c, _m) is None for c in (["Name of manufacturer", "ACME Chemicals Ltd", "", "", ""],
                                                     ["Test laboratory", "ACME QC Lab, Antwerp", "", "", "Accredited"],
                                                     ["Reference", "ACME Chemicals Ltd", "", "", ""])))
check("R1: a real test without digits stays ('Description | White powder | Complies')",
      N._build_test_row(["Description", "", "", "White powder", "Complies"], _m) is not None)
check("R2: the batch never takes the next word ('2504/ ACME', '240115- BASF')",
      all(N.parse_coa_fields({"full_text": t, "tables": []}).get("batch_lot") in ("", None)
          for t in ("Lot No: 2504/ ACME", "Batch No.: 240115- BASF Antwerp", "Batch No: A123/ Mfg. Date")))
# R6: the "incomplete" row really is yellow in the Word file and passes the gate
from tmc_common import yellow_runs  # noqa: E402
import provenance  # noqa: E402
with tempfile.TemporaryDirectory() as _d:
    _p = str(Path(_d) / "inc.docx")
    N.build_docx({"batch_lot": "L-1", "manufacture_date": "01.2026", "expiry_date": "01.2028",
                  "results_table": [["Assay", "98.0-102.0", "99.5", "%", ""]], "_incomplete": 4},
                 {"doc_ref": "840.S0999"}, "Sodium Benzoate", _p)
    check("R6: the incomplete-table note is yellow in the Word file", N.INCOMPLETE in yellow_runs(_p), yellow_runs(_p))
    _src = ["Lot L-1 Production date 01.2026 Expiry date 01.2028", "Assay 98.0-102.0 99.5 %"]
    check("R6: and the provenance gate accepts it",
          not provenance.check(_p, _src, ["Sodium Benzoate", "840.S0999", "L-1", "Production date", N.INCOMPLETE],
                               template_path=str(N.TEMPLATE_DOC)),
          provenance.check(_p, _src, ["Sodium Benzoate", "840.S0999", "L-1", "Production date", N.INCOMPLETE],
                           template_path=str(N.TEMPLATE_DOC)))

# security review R1: only one code token; a label stuck to a code or a date stays yellow for a person
check("a label stuck to a date is no batch",
      N.clean_identifier("Date:28.04.2025") == "" and N.clean_identifier("Expiry2027-01-31") == "")
check("a label in front of a LOT code is no batch", N.clean_identifier("Lot No. LOT2504280") == "")
check("'No.123' is a label with a number, no batch", N.clean_identifier("No.123") == "")

# 04/11/2026, real scanned COA: a numbered free-text table read by word position
def _words(top, *cols, page=1):
    """One printed line: (x, text) pairs; each word 6 pt per character plus a 2 pt space."""
    out = []
    for x, text in cols:
        for part in text.split():
            out.append({"page": page, "text": part, "x0": float(x), "x1": float(x + 6 * len(part)), "top": float(top)})
            x += 6 * len(part) + 2
    return out
NUM = (_words(100, (36, "Sr."), (66, "TESTS"), (201, "SPECIFICATIONS"), (431, "OBSERVATIONS"))
       + _words(112, (36, "No."))
       + _words(124, (36, "1"), (65, "Description"), (201, "White powder or"), (430, "White"))
       + _words(136, (201, "crystals."), (430, "powder."))
       + _words(150, (36, "2"), (65, "Identification"))
       + _words(162, (65, "A. IR"), (201, "Passes the test."), (430, "Passes."))
       + _words(174, (66, "B.Melting point"), (201, "125-128 C"), (430, "126.3 C"))
       + _words(188, (36, "3"), (65, "Residual solvents"), (201, "Meets USP <467>"))
       + _words(196, (83, "•"))
       + _words(204, (102, "Methanol"), (201, "NMT3000ppm"), (429, "746 ppm"))
       + _words(218, (36, "4"), (65, "Related Substances"), (201, "Impurity A: NMT 0.5%"), (430, "Not detected."))
       + _words(230, (65, "HPLC"), (201, "Total: NMT 1.0%"), (430, "Not detected."))
       + _words(244, (36, "5"), (65, "Assay"), (201, "98.0% to 102.0%"), (430, "99.7%"))
       + _words(258, (32, "Remarks: meets USP"), (300, "Lot 1 Ltd")))
rows_n, groups_n, gap_n = N.numbered_free_text_rows(NUM)
params = [r[0] for r in rows_n]
check("numbered table: one row per test, wrapped lines joined in their own column",
      rows_n[0][:3] == ["Description", "White powder or crystals.", "White powder."], rows_n[:1])
check("numbered table: sub-tests 'A.', 'B.' and after a bullet are their own rows, as printed",
      ["A. IR", "B.Melting point", "Methanol"] == [p for p in params if p in ("A. IR", "B.Melting point", "Methanol")], params)
# security review M1/L3 (04/11/2026): "Identification" alone is a test name, not an analysis heading
check("numbered table: a parent test name without values is no heading; its sub-tests stay rows",
      groups_n == [] and "A. IR" in params, groups_n)
check("numbered table: a line with its own name and result under a row that has one drops that row",
      not any(p.startswith("Related") or p == "HPLC" for p in params) and "Assay" in params, params)
check("numbered table: a numbered test without a row keeps the table flagged", gap_n is True)
check("numbered table: nothing after 'Remarks' is read", not any("Remarks" in p or "Ltd" in " ".join(r) for p, r in zip(params, rows_n)))
reads = N.numbered_column_readings(NUM)
check("numbered table: the gate reads each column of each row in order", "White powder or crystals." in reads, reads[:4])
check("numbered table: a numbered list without the header gives nothing",
      N.numbered_free_text_rows([w for w in NUM if w["top"] != 100])[0] == [])
_off = [dict(w, x0=w["x0"] + 2, x1=w["x1"] + 160) if w["text"] == "or" else w for w in NUM]
check("numbered table: a word running over a column edge drops its row",
      "Description" not in [r[0] for r in N.numbered_free_text_rows(_off)[0]])

# section headings inside a results table (04/11/2026, real COA)
check("a section heading is recognised", N._group_heading(["Chemical & Physical", "", ""]) == "Chemical & Physical"
      and N._group_heading(["OTHERS", ""]) == "OTHERS" and N._group_heading(["Microbiological"]) == "Microbiological")
check("a supplier or lab name in a one-cell row is never a heading",
      N._group_heading(["ACME QC Laboratory"]) is None and N._group_heading(["Example Chemicals Ltd"]) is None)
check("a heading needs one filled cell and no number",
      N._group_heading(["Chemical", "Physical"]) is None and N._group_heading(["Section 2 Chemical"]) is None)
_tbl = {"full_text": "", "layout_text": "", "tables": [{"page": 1, "rows": [
    ["Chemical & Physical", "", "", ""], ["Characteristic", "Unit", "Specification", "Results"],
    ["pH", "", "5.5-7.5", "6.9"], ["Microbiological", "", "", ""],
    ["Total aerobic microbial count", "cfu/g", "<= 100", "<100"]]}]}
_f = N.parse_coa_fields(_tbl)
check("section headings are kept with their place and never counted as tests",
      len(_f["results_table"]) == 2 and _f["_groups"] == [(0, "Chemical & Physical"), (1, "Microbiological")]
      and _f["_groups_n"] == 2, (_f.get("results_table"), _f.get("_groups")))
check("a table without headings is read exactly as before", "_groups" not in N.parse_coa_fields(
    {"full_text": "", "layout_text": "", "tables": [{"page": 1, "rows": _tbl["tables"][0]["rows"][1:3]}]}))
import docx as _docx  # noqa: E402
with tempfile.TemporaryDirectory() as _d:
    _p = str(Path(_d) / "groups.docx")
    N.build_docx(dict(_f, batch_lot="L-1", manufacture_date="01.2026", expiry_date="01.2028"),
                 {"doc_ref": "840.S0999"}, "Sodium Benzoate", _p)
    _rows = _docx.Document(_p).tables[1].rows
    _heads = [r.cells[0].text for r in _rows if len({id(c._tc) for c in r.cells}) == 1]
    check("headings are one row across the table, bold, in their place",
          _heads == ["Chemical & Physical", "Microbiological"]
          and all(run.bold for r in _rows if r.cells[0].text in _heads for p in r.cells[0].paragraphs for run in p.runs if run.text),
          [r.cells[0].text for r in _rows])
    check("headings are never yellow", yellow_runs(_p) == [], yellow_runs(_p))
    _q = str(Path(_d) / "numbered.docx")
    N.build_docx({"batch_lot": "L-1", "manufacture_date": "01.2026", "expiry_date": "01.2028",
                  "results_table": rows_n, "_yellow_rows": set(range(len(rows_n))), "_numbered_gap": True,
                  "_incomplete": len(rows_n), "_groups": groups_n, "_groups_n": len(rows_n)},
                 {"doc_ref": "840.S0999"}, "Sodium Benzoate", _q)
    _y = yellow_runs(_q)
    check("rows read from a numbered table are yellow for a person", all(p in _y for p in params), _y)
    check("a numbered test without a row keeps the incomplete note, whatever the count", N.INCOMPLETE in _y, _y)
    _src = N.numbered_column_readings(NUM) + [" ".join(w["text"] for w in NUM)]
    check("and the provenance gate accepts the numbered rows",
          not provenance.check(_q, _src, ["Sodium Benzoate", "840.S0999", "L-1", "Production date", N.INCOMPLETE,
                                          "01.2026", "01.2028"], template_path=str(N.TEMPLATE_DOC)),
          provenance.check(_q, _src, ["Sodium Benzoate", "840.S0999", "L-1", "Production date", N.INCOMPLETE,
                                      "01.2026", "01.2028"], template_path=str(N.TEMPLATE_DOC)))
    _r = [list(r) for r in rows_n]
    _r[[r[0] for r in _r].index("Assay")][2] = "99.9%"                  # a value the source never printed
    _z = str(Path(_d) / "invented.docx")
    N.build_docx({"batch_lot": "L-1", "manufacture_date": "01.2026", "expiry_date": "01.2028", "results_table": _r,
                  "_yellow_rows": set(range(len(_r))), "_groups": groups_n, "_groups_n": len(_r)},
                 {"doc_ref": "840.S0999"}, "Sodium Benzoate", _z)
    _v = provenance.check(_z, _src, ["Sodium Benzoate", "840.S0999", "L-1", "Production date",
                                     "01.2026", "01.2028"], template_path=str(N.TEMPLATE_DOC))
    check("the gate still refuses a value the numbered table never printed", any("99.9" in str(v) for v in _v), _v)

# 04/11/2026 review: the numbered reader's edges, synthetic lines in the same columns as NUM
_HDR = [w for w in NUM if w["top"] == 100]
def _line(top, n, p="", s="", r="", page=1):
    return _words(top, *[(x, t) for x, t in ((36, n), (65, p), (201, s), (430, r)) if t], page=page)
_four = (_HDR + _line(124, "1", "Description", "White powder", "White powder") + _line(140, "2", "pH", "5-7", "6.1")
         + _line(156, "3", "Assay", "98-102", "99.1") + _line(172, "4", "Water", "NMT 1%", "0.2%"))
_lay4 = "Sr. TESTS\n1 Description White powder\n2 pH 5-7 6.1\n3 Assay 98-102 99.1\n4 Water NMT 1% 0.2%"
_hdr3 = ["Test", "Specification", "Result"]
_part = {"full_text": _lay4, "layout_text": _lay4, "words": _four,
         "tables": [{"page": 1, "rows": [_hdr3, ["Description", "White powder", "White powder"]]}]}
_fp = N.parse_coa_fields(_part)
check("numbered table: used when the table reading found fewer rows, and every row is yellow",
      [r[0] for r in _fp["results_table"]] == ["Description", "pH", "Assay", "Water"]
      and _fp.get("_yellow_rows") == {0, 1, 2, 3} and _fp.get("_numbered_gap") is False, _fp)
_full = dict(_part, tables=[{"page": 1, "rows": [_hdr3, ["Description", "White powder", "White powder"],
                                                 ["pH", "5-7", "6.1"], ["Assay", "98-102", "99.1"], ["Water", "NMT 1%", "0.2%"]]}])
_ff = N.parse_coa_fields(_full)
check("numbered table: not used when the table reading has every numbered test (no yellow rows)",
      len(_ff["results_table"]) == 4 and "_yellow_rows" not in _ff and "_numbered_gap" not in _ff, _ff)
_fw = N.parse_coa_fields({k: v for k, v in _part.items() if k != "words"})
check("numbered table: without word positions (Word file, scan) the table reading stays as it was",
      len(_fw["results_table"]) == 1 and "_yellow_rows" not in _fw, _fw)
_fl = N.parse_coa_fields(dict(_part, words=_HDR + _line(124, "1", "Description", "White powder", "White powder")))
check("numbered table: kept only when it reads more rows than the table did",
      len(_fl["results_table"]) == 1 and "_yellow_rows" not in _fl, _fl)
_ooo = (_HDR + _line(124, "1", "Description", "White", "White") + _line(140, "2", "pH", "5-7", "6.1")
        + _line(156, "4", "Assay", "98-102", "99") + _line(172, "5", "Water", "NMT 1%", "0.2%"))
check("numbered table: a number out of order is skipped with what follows, never placed",
      [r[0] for r in N.numbered_free_text_rows(_ooo)[0]] == ["Description", "pH"], N.numbered_free_text_rows(_ooo))
_lone = (_HDR + _line(124, "1", "Description", "White", "White") + _line(140, "2", "Identification")
         + _line(156, "3", "Assay", "98-102", "99"))
_rl, _gl, _xl = N.numbered_free_text_rows(_lone)
check("numbered table: a parent without values and without sub-tests is no heading and no row, and flags the gap",
      _gl == [] and "Identification" not in [r[0] for r in _rl] and _xl is True, (_rl, _gl, _xl))
_own = (_HDR + _line(124, "1", "Description", "White", "White") + _line(140, "2", "Identification", "Positive", "Positive")
        + _line(156, "", "A. IR", "Conforms", "Conforms") + _line(172, "3", "Assay", "98", "99"))
_ro, _go, _ = N.numbered_free_text_rows(_own)
check("numbered table: a parent with its own values stays a test row, never a heading",
      _go == [] and [r[0] for r in _ro] == ["Description", "Identification", "A. IR", "Assay"], (_ro, _go))
_who = (_HDR + _line(124, "1", "Description", "White", "White")
        + _line(140, "2", "Manufacturer", "Example Pharma Ltd", "Example Pharma Ltd") + _line(156, "3", "Assay", "98-102", "99"))
_rw, _, _xw = N.numbered_free_text_rows(_who)
check("numbered table: a supplier line in the test column is never a row (rule 3), and flags the gap",
      not any("Example" in c for r in _rw for c in r) and _xw is True, _rw)
_uni = _HDR + _line(124, "1", "Lead", "≤ 0.5 µg/g", "< 0,1 µg/g") + _line(140, "2", "pH", "5-7", "6.1")
check("numbered table: unicode limits are kept exactly as printed",
      N.numbered_free_text_rows(_uni)[0][0][:3] == ["Lead", "≤ 0.5 µg/g", "< 0,1 µg/g"], N.numbered_free_text_rows(_uni))
check("numbered table: no or empty word positions give nothing and do not fail",
      N.numbered_free_text_rows(None) == ([], [], False) and N.numbered_free_text_rows([]) == ([], [], False)
      and N.numbered_column_readings(None) == [])
check("the gate reads a source without word positions as before",
      "x" in N._source_texts({"full_text": "x"}, {}, {}))

# headings: edges and abuse
check("a heading over 40 characters or 5 words, markup, or only empty cells is no heading",
      N._group_heading(["Physical " * 6]) is None and N._group_heading(["Tests & Results & Data & Analysis"]) is None
      and N._group_heading(["Chemical<script>"]) is None and N._group_heading(["", None, "  "]) is None)
check("a heading next to empty (None) cells is still a heading", N._group_heading([None, "Microbiological", ""]) == "Microbiological")
_hs = N.parse_coa_fields({"full_text": "", "layout_text": "", "tables": [{"page": 1, "rows": [
    ["Microbiological", "", ""], ["Microbiological", "", ""], _hdr3, ["TAMC", "<=100", "<10"]]}]})
check("a heading repeated in its place is kept once", _hs.get("_groups") == [(0, "Microbiological")], _hs.get("_groups"))
_he = N.parse_coa_fields({"full_text": "", "layout_text": "", "tables": [{"page": 1, "rows": [["Microbiological", "", ""], _hdr3]}]})
check("a heading above no tests gives no headings", "_groups" not in _he, _he)
_hn = N.parse_coa_fields(dict(_part, tables=[{"page": 1, "rows": [["Chemical", "", ""], _hdr3,
                                                                   ["Description", "White powder", "White powder"]]}]))
check("a table heading is dropped when the numbered reading replaces its rows",
      len(_hn["results_table"]) == 4 and "_groups" not in _hn, _hn)
_hx = N.parse_coa_fields({"full_text": "", "layout_text": "", "tables": [{"page": 1, "rows": [
    ["Example Pharma Ltd", "", ""], _hdr3, ["pH", "5-7", "6.1"]]}]})
check("a supplier name above the column names is no heading and no row",
      "_groups" not in _hx and [r[0] for r in _hx["results_table"]] == ["pH"], _hx)
with tempfile.TemporaryDirectory() as _d:
    _m = str(Path(_d) / "mismatch.docx")
    N.build_docx({"batch_lot": "L-1", "results_table": [["pH", "5-7", "6.1", "", ""]],
                  "_groups": [(0, "Microbiological")], "_groups_n": 2}, {"doc_ref": "840.S0999"}, "Sodium Benzoate", _m)
    _mt = [r.cells[0].text for r in _docx.Document(_m).tables[1].rows]
    check("headings are left out when the rows changed after reading (_groups_n differs)", "Microbiological" not in _mt, _mt)
    _pl = str(Path(_d) / "plain.docx")
    _pf = N.parse_coa_fields({"full_text": "", "layout_text": "", "words": _HDR, "tables": [{"page": 1, "rows": [_hdr3, ["pH", "5-7", "6.1"]]}]})
    N.build_docx(dict(_pf, batch_lot="L-1", manufacture_date="01.2026", expiry_date="01.2028"),
                 {"doc_ref": "840.S0999"}, "Sodium Benzoate", _pl)
    _prow = _docx.Document(_pl).tables[1].rows
    check("a plain table (word positions, no numbered run) gets no new marks: no yellow, no heading row",
          yellow_runs(_pl) == [] and not any(k in _pf for k in ("_yellow_rows", "_numbered_gap", "_groups"))
          and all(len({id(c._tc) for c in r.cells}) > 1 for r in _prow), (yellow_runs(_pl), _pf))

# security and testing review of the numbered reader (04/11/2026): the table ends where the tests
# end, supplier identity in any cell drops the row, every cell of a read row is yellow
_pg = (_HDR + _line(124, "1", "Description", "White", "White") + _line(140, "2", "pH", "5-7", "6.1") + _line(156, "3", "Assay", "98.0% to")
       + _line(40, "", "", "Example Pharma Ltd", page=2) + _line(60, "", "", "102.0%", "99.7%", page=2))
check("numbered table: a page-2 letterhead never joins a row",
      not any("Example" in c for r in N.numbered_free_text_rows(_pg)[0] for c in r), N.numbered_free_text_rows(_pg)[0])
_sig = (_HDR + _line(124, "1", "Description", "White", "White") + _line(140, "2", "pH", "5-7", "6.1")
        + _line(156, "3", "Assay", "98.0% to 102.0%", "99.7%") + _line(168, "", "", "", "For ACME Chemicals QC Manager"))
_rs, _gs, _xs = N.numbered_free_text_rows(_sig)
check("numbered table: a signature block in the result column never joins the last row",
      not any("ACME" in c or "Manager" in c for r in _rs for c in r) and [r[0] for r in _rs][:2] == ["Description", "pH"], _rs)
_tel = (_HDR + _line(124, "1", "Description", "White", "White") + _line(140, "2", "pH", "5-7", "6.1")
        + _line(156, "3", "Assay", "98.0% to 102.0%", "99.7%") + _line(168, "", "", "Tel +91 22 1234 5678", "acme@example.in"))
_rt, _gt, _xt = N.numbered_free_text_rows(_tel)
check("numbered table: a row that takes a phone number or e-mail is dropped and the table stays flagged",
      not any("Tel" in c or "@" in c for r in _rt for c in r) and "Assay" not in [r[0] for r in _rt] and _xt is True, (_rt, _xt))
_co = (_HDR + _line(124, "1", "Description", "White", "White") + _line(140, "2", "pH", "5-7", "6.1")
       + _line(156, "3", "Assay", "Example Pharma Pvt Ltd", "99.7%"))
_rc, _gc, _xc = N.numbered_free_text_rows(_co)
check("numbered table: a company form (Pvt Ltd) in a spec cell drops the row", "Assay" not in [r[0] for r in _rc] and _xc is True, _rc)
_oo = (_HDR + _line(124, "1", "Description", "White", "White") + _line(140, "2", "pH", "5-7", "6.1")
       + _line(156, "3", "Assay", "98-102", "99.1") + _line(172, "5", "Water", "NMT 1%", "0.2%") + _line(188, "6", "Ash", "NMT 0.1%", "0.05%"))
check("numbered table: numbers 1, 2, 3, 5, 6: the skipped tests keep the table flagged", N.numbered_free_text_rows(_oo)[2] is True)
_long = (_HDR + _line(124, "1", "Description", "White", "White") + _line(140, "2", "pH", "5-7", "6.1")
         + _line(156, "3", "Assay", "98.0%", "99.7%") + sum((_line(166 + 10 * i, "", "", f"w{i}", "") for i in range(5)), []))
_rl5 = N.numbered_free_text_rows(_long)
check("numbered table: more than 4 wrapped lines drop the row", "Assay" not in [r[0] for r in _rl5[0]] and _rl5[2] is True, _rl5)
_gap = (_HDR + _line(124, "1", "Description", "White", "White") + _line(136, "2", "pH", "5-7", "6.1")
        + _line(148, "3", "Assay", "98.0%", "99.7%") + _line(260, "", "", "Distributed by Example", ""))
check("numbered table: a blank band ends the table", not any("Example" in c for r in N.numbered_free_text_rows(_gap)[0] for c in r))
_mic = (_HDR + _line(124, "1", "Description", "White", "White") + _line(140, "2", "Microbiological")
        + _line(156, "", "A. TAMC", "NMT 1000", "<10") + _line(172, "3", "Assay", "98-102", "99.1"))
check("numbered table: an analysis-word parent ('Microbiological') is a heading above its sub-tests",
      N.numbered_free_text_rows(_mic)[1] == [(1, "Microbiological")], N.numbered_free_text_rows(_mic)[1])
check("an analysis word that is a test name ('Assay', 'Results') alone is no heading",
      N._group_heading(["Assay"]) is None and N._group_heading(["Results"]) is None and N._group_heading(["Identification"]) is None
      and N._group_heading(["Chemical & Physical"]) == "Chemical & Physical")
# M2: the gate reads only the rows kept, and only when the numbered reader made the table
_keptr = N.numbered_column_readings(_tel)
check("gate: numbered readings hold only the cells of kept rows, never a dropped row's text",
      not any("Tel" in t or "@" in t or "Assay" in t for t in _keptr) and "Description" in _keptr, _keptr)
_src_n = {"full_text": "", "pages": [], "layout_text": "", "tables": [], "words": _tel}
check("gate: no numbered readings when the table did not come from the numbered reader",
      "Description" not in N._source_texts(_src_n, {}, {}) and "Description" in N._source_texts(_src_n, {}, {"_yellow_rows": {0}})
      and "Description" not in N._source_texts(_src_n, {}, {"_yellow_rows": {0}}, numbered=False))
# M3: every filled cell of a read row is yellow
with tempfile.TemporaryDirectory() as _d:
    _p3 = str(Path(_d) / "m3.docx")
    N.build_docx({"batch_lot": "L-1", "manufacture_date": "01.2026", "expiry_date": "01.2028",
                  "results_table": [["Assay", "98.0% to 102.0%", "99.7%", "", ""]], "_yellow_rows": {0}},
                 {"doc_ref": "840.S0999"}, "Sodium Benzoate", _p3)
    _y3 = yellow_runs(_p3)
    check("numbered row: name, specification and result are all yellow", all(v in _y3 for v in ("Assay", "99.7%")) and
          any("98.0" in v or "102.0" in v for v in _y3), _y3)
# L2: a replaced results table never keeps the marks of the table it replaced
_mk = {"results_table": [["a", "", "1", "", ""]], "_yellow_rows": {0}, "_numbered_gap": True, "_groups": [(0, "X")], "_groups_n": 1}
N._drop_table_marks(_mk)
check("marks of a replaced table are dropped", not any(k in _mk for k in N._TABLE_MARKS) and "results_table" in _mk)

print(f"\n{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
