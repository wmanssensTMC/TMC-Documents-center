"""Checks against the three supplier samples Willem supplied.

Run from the skill root with the sample PDFs in samples/:
    python tests/test_scan_and_batches.py
"""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).parent.parent / "scripts"))
import pdfplumber
import ocr_prep, coa_batches as CB
from coa_consensus import read_with_consensus

S = pathlib.Path(__file__).parent.parent / "samples"

EXPECT_BATCHES = {
    "multi.pdf": [["51029", "51101", "51102"],
                  ["51025", "51026", "51027", "51028"],
                  ["51019", "51022", "51025"]],
    "scan.pdf": [None],
    "tm.pdf": [None, None],
}

for name, expect in EXPECT_BATCHES.items():
    f = S / name
    if not f.exists():
        print(f"  skip {name} (not in samples/)")
        continue
    ocr = ocr_prep.searchable_copy(str(f), dpi=400, psm="6")
    with pdfplumber.open(ocr) as pdf:
        got = [c[0] if c else None for c in
               (CB.find_column_batches(p) for p in pdf.pages)]
    print(("  ok   " if got == expect else "  FAIL ") + name, got)

f = S / "tm_page1only.pdf"
if f.exists():
    ocr = ocr_prep.searchable_copy(str(f), dpi=400, psm="6")
    with pdfplumber.open(ocr) as pdf:
        ok, msg = CB.page_marker_check([p.extract_text() or "" for p in pdf.pages],
                                       len(pdf.pages))
    print(("  ok   " if not ok else "  FAIL ") + "incomplete input detected:", msg)

f = S / "multi.pdf"
if f.exists():
    from coa_consensus import merge_duplicate_lots
    agreed, issues = read_with_consensus(str(f))
    per, notes, conflicts = merge_duplicate_lots(agreed)
    # 10 lot entries, lot 51025 twice with a different quantity -> 9 documents
    print(("  ok   " if len(per) == 9 else "  FAIL ")
          + f"duplicate lot merged to one document ({len(per)} docs)")
    print(("  ok   " if not conflicts else "  FAIL ")
          + "quantity-only difference is not treated as a conflict")
    print(("  ok   " if any("51025" in w for w, _ in notes) else "  FAIL ")
          + "other issuance noted for lot 51025")
    real = [w for w, _ in issues]
    print(("  ok   " if len(issues) <= 4 else "  FAIL ")
          + f"OCR noise filtered, {len(issues)} real disagreement(s) left")
