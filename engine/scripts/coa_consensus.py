"""
Two readings of a scan, and only what they agree on is trusted.

OCR is an interpretation of a picture, not the source text. A misread digit
("175" -> "ATS") is invisible to the provenance gate, because the gate compares
the output against the same OCR output. So a scan is read twice with different
settings and the two readings are compared: where they differ, the value is not
trusted and the run reports it instead of choosing one.

This is the scan-level form of the hard rule. It cannot make OCR correct; it
makes disagreement visible so a person checks it.
"""
import pdfplumber

import re

import coa_batches as CB
import ocr_prep

# Shipment quantities are not analysis results. The same lot can legitimately
# appear on two COAs issued at different moments with a different quantity, so
# a difference here means "another issuance", not "conflicting data".
QUANTITY_LIKE = re.compile(
    r"quantit|qty|hoeveelheid|amount|net\s*weight|gross\s*weight|packing"
    r"|packages|drums|bags|volume|aantal", re.I)

PASSES = (
    {"dpi": 400, "psm": "6", "clean": True},
    {"dpi": 300, "psm": "4", "clean": True},
)


def _param_key(label):
    """Match parameters across two OCR passes on their letters alone.

    The same row can come back as "Loss on drying" and "Lossondrying -§".
    Comparing the raw labels would report a missing value where only the label
    picked up speckle, drowning the real disagreements in noise.
    """
    return re.sub(r"[^a-z0-9]", "", (label or "").lower())


def _read(pdf_path, dpi, psm, clean):
    ocr = ocr_prep.searchable_copy(pdf_path, dpi=dpi, psm=psm, clean=clean)
    if not ocr:
        return None
    out = {}
    with pdfplumber.open(ocr) as pdf:
        for pno, page in enumerate(pdf.pages):
            found = CB.find_column_batches(page)
            if not found:
                continue
            lots, centres, top = found
            header = CB.find_header_columns(page)
            per = CB.split_columns(page, lots, centres, top,
                                   header["unit_centre"] if header else None)
            for lot, rows in per.items():
                out[(pno, lot)] = {_param_key(r[0]): (r[2], r[3], r[0])
                                   for r in rows}
    return out


def read_with_consensus(pdf_path):
    """-> (batches, disagreements). batches maps (page, lot) -> {param: (value, unit)}
    containing ONLY values both passes read identically."""
    a = _read(pdf_path, **PASSES[0])
    b = _read(pdf_path, **PASSES[1])
    if a is None or b is None:
        return (a or b or {}), [("ocr", "only one OCR pass available; "
                                        "values are unverified")]

    agreed, issues = {}, []
    for key in sorted(set(a) | set(b), key=lambda k: (k[0], str(k[1]))):
        pno, lot = key
        ra, rb = a.get(key), b.get(key)
        if ra is None or rb is None:
            issues.append((f"page {pno+1} lot {lot}",
                           "only one of the two readings found this batch"))
            continue
        fields = {}
        for param in sorted(set(ra) | set(rb)):
            va, vb = ra.get(param), rb.get(param)
            if va is None or vb is None:
                only = va or vb
                issues.append((f"page {pno+1} lot {lot} / {only[2]}",
                               f"present in one reading only ({only[0]!r})"))
                continue
            if va[0] != vb[0]:
                issues.append((f"page {pno+1} lot {lot} / {va[2]}",
                               f"readings disagree: {va[0]!r} vs {vb[0]!r}"))
                continue
            fields[param] = va
        agreed[key] = fields

    return agreed, issues


def merge_duplicate_lots(agreed):
    """One document per lot, even when the lot appears more than once.

    Only fields present in BOTH occurrences are compared - a field missing on
    one page is an OCR gap, not a disagreement. Of the fields that really
    differ:

      * a quantity-like field means the certificate was issued at a different
        moment for the same lot. The lot is kept once and the other quantity is
        noted, not printed.
      * anything else is a genuine conflict in the supplier document. Both
        readings are reported and the lot is held back, because choosing one
        analysis result would be guessing.

    -> (per_lot, notes, conflicts)
    """
    by_lot = {}
    for (pno, lot), fields in agreed.items():
        by_lot.setdefault(lot, []).append((pno, fields))

    per_lot, notes, conflicts = {}, [], []
    for lot, inst in sorted(by_lot.items()):
        inst.sort(key=lambda t: t[0])
        if len(inst) == 1:
            per_lot[lot] = inst[0][1]
            continue

        base_pno, base = max(inst, key=lambda t: (len(t[1]), -t[0]))
        qty_notes, hard = [], []
        for pno, fields in inst:
            if pno == base_pno:
                continue
            for param in set(base) & set(fields):
                if base[param] == fields[param]:
                    continue
                if QUANTITY_LIKE.search(param):
                    qty_notes.append((param, base[param][0], fields[param][0], pno))
                else:
                    hard.append((param, base[param][0], fields[param][0], pno))

        pages = ", ".join(str(p + 1) for p, _ in inst)
        if hard:
            conflicts.append((f"lot {lot}",
                              f"appears on pages {pages} with different analysis "
                              "results: "
                              + "; ".join(f"{p}: {a!r} vs {b!r} (page {pg+1})"
                                          for p, a, b, pg in hard)))
            continue

        merged = dict(base)
        for pno, fields in inst:
            for param, val in fields.items():
                merged.setdefault(param, val)
        per_lot[lot] = merged
        if qty_notes:
            notes.append((f"lot {lot}",
                          f"on pages {pages} - same lot, different issuance. Kept "
                          "once from page " + str(base_pno + 1) + "; other reading: "
                          + "; ".join(f"{p} {b!r} on page {pg+1}"
                                      for p, a, b, pg in qty_notes)))
        else:
            notes.append((f"lot {lot}",
                          f"appears on pages {pages} with the same data; kept once"))
    return per_lot, notes, conflicts
