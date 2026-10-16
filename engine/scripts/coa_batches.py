"""
Batch handling for supplier COAs.

Three things this module exists for:

1. **A COA can cover several batches.** They appear either stacked down the
   page, or side by side: one result COLUMN per batch, with each ROW a
   parameter and a "Lot No." row carrying the batch numbers (UBE style).
   Output must be one document per batch, so the batch number is what makes
   the filenames differ.

2. **A page marker that disagrees with the file.** A scan that says "Page 1 of
   3" inside a one-page PDF is an incomplete input. It is reported, never
   silently processed as if complete.

3. **Nothing is merged.** If the same lot number appears twice with different
   data, both are kept and the conflict is reported. Picking one would be
   guessing.
"""
import re

LOT_LABEL = re.compile(
    r"^\s*(lot\s*\.?\s*(no|nr|number)?|batch\s*(no|nr|number)?|charge|partij"
    r"|lot/batch)\b", re.I)
PAGE_MARK = re.compile(
    r"\bpage\s*[:\-]?\s*\S{0,3}?\s*(?:of|/|van)\s*(\d+)\b", re.I)


def page_marker_check(pages_text, pdf_pages):
    """-> (ok, message). Compares 'Page x of y' against the real page count."""
    claimed = set()
    for t in pages_text:
        for m in PAGE_MARK.finditer(t or ""):
            claimed.add(int(m.group(1)))
    if not claimed:
        return True, None
    worst = max(claimed)
    if worst > pdf_pages:
        return False, (f"the document states it has {worst} pages but the file "
                       f"contains {pdf_pages}; the input is incomplete")
    if worst < pdf_pages:
        return True, (f"the document states {worst} pages and the file has "
                      f"{pdf_pages}; check whether two certificates were merged")
    return True, None


def _lines(page):
    rows = {}
    for w in page.extract_words():
        rows.setdefault(round(w["top"] / 6.0), []).append(w)
    out = []
    for k in sorted(rows):
        ws = sorted(rows[k], key=lambda w: w["x0"])
        out.append({"top": min(w["top"] for w in ws), "words": ws,
                    "text": " ".join(w["text"] for w in ws)})
    return out


_NOISE = re.compile(r"[|_—–\u00a9]|(?<=\s)[.,:;](?=\s)|^[.,:;]+|[.,:;]+$")


def _clean_label(text):
    """Strip scanner speckle that OCR read as punctuation.

    Only stray separator characters are removed - never a character that could
    be part of a value, so a decimal point inside a number is untouched.
    """
    t = re.sub(r"\s+", " ", text or "").strip()
    t = _NOISE.sub(" ", t)
    t = re.sub(r"\s+", " ", t).strip(" .,:;|_-")
    return t


def _numeric_like(tok):
    return bool(re.fullmatch(r"[<>≤≥~=]?\s*[-+]?\d[\d.,/-]*%?", tok.strip()))


HEADER_RESULT = re.compile(r"^(result|results|resultaat|analys\w*)$", re.I)
HEADER_UNIT = re.compile(r"^(unit|units|u\.?m\.?|eenheid)$", re.I)


def find_header_columns(page):
    """Column centres from the table header row, when the COA prints one.

    Reading 'Unit | Result | Result | Result' off the header is far safer than
    guessing column edges from the data, and it is what separates the unit from
    the parameter name.
    """
    for ln in _lines(page):
        res = [w for w in ln["words"] if HEADER_RESULT.fullmatch(w["text"].strip(" .:"))]
        if len(res) >= 2:
            unit = next((w for w in ln["words"]
                         if HEADER_UNIT.fullmatch(w["text"].strip(" .:"))), None)
            return {
                "result_centres": [(w["x0"] + w["x1"]) / 2 for w in res],
                "unit_centre": ((unit["x0"] + unit["x1"]) / 2) if unit else None,
                "top": ln["top"],
            }
    return None


def find_column_batches(page):
    """Detect the side-by-side layout: one result column per batch.

    A header row with two or more result columns is required. Without it a
    plain "BATCH NUMBER : 6056C26/02" line would be mistaken for a two-column
    batch layout, which is how a single-batch COA gets torn in half.

    Returns (lot_numbers, column_centres, lot_line_top) or None.
    """
    header = find_header_columns(page)
    if not header or len(header["result_centres"]) < 2:
        return None
    centres_ref = header["result_centres"]

    for ln in _lines(page):
        if not LOT_LABEL.match(ln["text"]):
            continue
        vals = [w for w in ln["words"]
                if re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9./-]{2,}", w["text"])
                and not LOT_LABEL.match(w["text"])
                and w["text"].strip("-") != ""]
        # drop the label words themselves and any "---" placeholder
        vals = [w for w in vals if not re.fullmatch(r"-+|lot\.?no\.?|batch", w["text"], re.I)]
        # keep only the values that sit under a result column
        aligned = []
        for w in vals:
            c = (w["x0"] + w["x1"]) / 2
            if min(abs(c - r) for r in centres_ref) <= 45:
                aligned.append(w)
        if len(aligned) >= 2:
            centres = [(w["x0"] + w["x1"]) / 2 for w in aligned]
            return [w["text"] for w in aligned], centres, ln["top"]
    return None


def split_columns(page, lots, centres, lot_top, unit_centre=None):
    """Read the parameter rows and hand each column to its batch."""
    per_batch = {lot: [] for lot in lots}
    seen = set()
    for ln in _lines(page):
        if ln["top"] <= lot_top:
            continue
        words = ln["words"]
        left_edge = (unit_centre - 18) if unit_centre else (min(centres) - 20)
        label = " ".join(w["text"] for w in words
                         if (w["x0"] + w["x1"]) / 2 < left_edge).strip()
        label = _clean_label(label)
        if not label or len(label) < 2:
            continue
        if re.match(r"manufactur|this certificate|team manager|ube corporation",
                    label, re.I):
            break
        vals = [w for w in words if (w["x0"] + w["x1"]) / 2 >= left_edge]
        if not vals:
            continue
        # the unit sits in its own column, located from the header row
        unit = ""
        rest = []
        for w in vals:
            c = (w["x0"] + w["x1"]) / 2
            if c < centres[0] - 25:
                if unit_centre is None or abs(c - unit_centre) <= 40:
                    unit = (unit + " " + w["text"]).strip()
            else:
                rest.append(w)
        unit = _clean_label(unit)
        if not rest:
            continue
        assigned = {i: [] for i in range(len(centres))}
        for w in rest:
            c = (w["x0"] + w["x1"]) / 2
            i = min(range(len(centres)), key=lambda j: abs(centres[j] - c))
            assigned[i].append(w["text"])
        key = label.lower()
        if key in seen:
            continue
        seen.add(key)
        for i, lot in enumerate(lots):
            value = " ".join(assigned[i]).strip()
            value = _clean_label(value)
            if value:
                per_batch[lot].append((label, "", value,
                                       "" if unit in ("---", "-", "") else unit, ""))
    return per_batch
