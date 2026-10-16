"""Fidelity check for the SDS neutraliser.

The output must differ from the source ONLY by the supplier -> TMC swap.
compare() returns (lost, gained): tokens that moved for any other reason.
Both must be empty for the run to be considered faithful.
"""
import re, unicodedata
from collections import Counter
import pdfplumber


def _tokens(text):
    t = unicodedata.normalize("NFKD", text).replace("–", "-").replace("—", "-")
    t = re.sub(r"[̀-ͯ]", "", t)          # drop combining accents
    return [w for w in re.sub(r"[^A-Za-z0-9]+", " ", t).lower().split() if w]


def _doc_tokens(path, drop_exact, drop_prefixes):
    keep = []
    page_no = re.compile(r"^\d+\s*/\s*\d+$")
    with pdfplumber.open(path) as pdf:
        for page in pdf.pages:
            for line in (page.extract_text() or "").split("\n"):
                s = line.strip()
                if not s or s in drop_exact or page_no.match(s):
                    continue
                if any(s.startswith(p) for p in drop_prefixes if p):
                    continue
                keep.append(s)
    return Counter(_tokens(" ".join(keep)))


def compare(src_pdf, out_pdf, report, entity, meta=None):
    """-> (unexpected_lost, unexpected_gained)"""
    # The running page header/footer repeats once per page, and the two layouts
    # do not have the same page count, so it is excluded on both sides.
    meta = meta or {}
    drop_exact = {meta.get("product_name", ""), meta.get("doc_kind", "")}
    drop_exact |= set(meta.get("framing", []))
    drop_exact.discard("")
    drop_prefixes = [meta.get("control_line", "")]

    src = _doc_tokens(src_pdf, drop_exact, drop_prefixes)
    out = _doc_tokens(out_pdf, drop_exact, drop_prefixes)

    expect_lost = Counter()
    for line in report.get("removed_lines", []):
        expect_lost.update(_tokens(line))
    for tok in report.get("supplier_tokens", []):
        expect_lost.update(_tokens(tok))
    expect_lost.update(_tokens(report.get("old_emergency", "")))

    expect_gain = Counter()
    for line in report.get("tmc_block", []):
        expect_gain.update(_tokens(line))
    expect_gain.update(_tokens(entity.get("nood", "")))

    # a trade-name override is an intended, reported change on both sides
    expect_lost.update(_tokens(report.get("trade_name_was", "")))
    expect_lost.update(_tokens(report.get("product_name_from", "")))
    expect_gain.update(_tokens(report.get("product_name_to", "")))
    # A table's header row repeats once per page the table spans. The two
    # layouts do not paginate identically, so that count may go up or down;
    # it is pagination, not content, and is tolerated in both directions.
    for head in report.get("repeatable", []):
        expect_gain.update(_tokens(head))
        expect_lost.update(_tokens(head))
    if meta.get("file_nr"):
        expect_gain.update(_tokens("TMC file nr " + str(meta["file_nr"])))

    lost = {w: src[w] - out.get(w, 0) for w in src if src[w] > out.get(w, 0)}
    gained = {w: out[w] - src.get(w, 0) for w in out if out[w] > src.get(w, 0)}

    lost = {w: n for w, n in lost.items() if w not in expect_lost}
    gained = {w: n for w, n in gained.items() if w not in expect_gain}
    return lost, gained


if __name__ == "__main__":
    import sys, json
    print(compare(sys.argv[1], sys.argv[2],
                  json.load(open(sys.argv[3])), json.load(open(sys.argv[4]))))
