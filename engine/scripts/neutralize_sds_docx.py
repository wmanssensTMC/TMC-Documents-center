#!/usr/bin/env python3
"""
Transmare Chemie NV - SDS Neutralizer (DOCX output)
===================================================
Rebrands a supplier Safety Data Sheet onto the TMC layout.

What changes
------------
1. Section 1.3 (supplier details)  -> the TMC entity block.
2. Section 1.4 (emergency number)  -> the TMC emergency number.
3. Any remaining supplier identity (legal name, e-mail, domain, telephone,
   fax) is scrubbed document-wide.
4. Optional: the trade name is replaced when --product-name is given.

What does NOT change
--------------------
Everything else is reproduced verbatim, including the supplier's own
regulatory framing (the "According to ..." lines, section headings, country
headings such as "United Kingdom - Occupational Exposure Limits", dates,
version and revision lines). A built-in verification pass proves this: it
compares the token multiset of source and output and fails the run if
anything other than the supplier/TMC swap moved.

Usage
-----
    python neutralize_sds_docx.py SDS.pdf --entity entity.json \
        --output out.docx [--product-name NAME] [--file-nr 840.S0850] [--render-pdf]

entity.json (empty fields are simply left off the document):
    {"naam": "...", "adres": "...", "telefoon": "...",
     "email": "...", "web": "...", "btw": "...", "nood": "+32 (0)14 58 45 45"}
"""
import argparse, json, re, subprocess, sys, shutil
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from extract_sds import extract                      # noqa: E402
from neutralise_sds import neutralise, TMC_EMERGENCY  # noqa: E402
from build_sds_docx import build                     # noqa: E402
from verify_sds import compare                       # noqa: E402
import provenance                                   # noqa: E402

SKILL_DIR = Path(__file__).parent.parent
TEMPLATE = SKILL_DIR / "assets" / "TMC_SDS_template.docx"




# Entity codes used as the output filename prefix. The code belongs in the
# entity record ("code" field) so it is data, not something the script decides;
# KNOWN_CODES only covers the entities Willem named, and anything else falls
# back to a slug of the entity name and is reported so it can be corrected.
KNOWN_CODES = {
    "transmare chemie nv": "TMC",
    "transmare chemie": "TMC",
    "tmc gulf": "TMCGULF",
    "pharmalabo": "PHARMALABO",
}


def entity_code(entity):
    code = (entity.get("code") or "").strip()
    if code:
        return code.upper(), True
    name = (entity.get("naam") or "").strip().lower()
    if name in KNOWN_CODES:
        return KNOWN_CODES[name], True
    for key, val in KNOWN_CODES.items():
        if key in name:
            return val, True
    slug = re.sub(r"[^A-Za-z0-9]+", "", entity.get("naam") or "") or "ENTITY"
    return slug.upper(), False


def _safe(s):
    s = re.sub(r"[^\w\s\-.]", "", (s or "").strip())
    return re.sub(r"\s+", "_", s)[:60]


def output_path(entity, product_name, requested):
    """<ENTITYCODE>_MSDS_<PRODUCTNAME>.docx, e.g. TMC_MSDS_HYDROQUINONE.docx.
    Other entities give TMCGULF_MSDS_..., PHARMALABO_MSDS_..."""
    code, known = entity_code(entity)
    return (Path(requested).parent / f"{code}_MSDS_{_safe(product_name)}.docx",
            code, known)


def non_clobbering(path):
    """An existing output is never overwritten: report it and step aside."""
    p = Path(path)
    if not p.exists():
        return p, None
    n = 2
    while True:
        alt = p.with_name(f"{p.stem}_v{n}{p.suffix}")
        if not alt.exists():
            return alt, p
        n += 1


def _source_corpus(pdf_path, scrub_tokens=()):
    """Everything the source actually says, read three ways:

      1. linear page text, as printed;
      2. every table cell, since a cell's words are not adjacent in (1);
      3. the label column and the value column read separately.

    (3) matters because the SDS two-column layout interleaves the two: a label
    too long for its column wraps *under* its own value, so
    "Portable tank and bulk container special provisions" and "(ADR)" are
    adjacent in the label column but not in the linear text. Reading the
    columns separately keeps the check strict on invented values while
    recognising the document's own reading order.
    """
    import pdfplumber
    from neutralise_sds import scrub_text
    from extract_sds import LABEL_X, _furn_key, _furniture, _lines, dedupe
    texts = []
    with pdfplumber.open(pdf_path) as pdf:
        # 5. the whole text with repeated page headers/footers left out, as the reader joins a
        # paragraph over a page break (22/10/2026, real MSDS): still only the source's own text
        pages_lines = [_lines(dedupe(p), len(pdf.pages)) for p in pdf.pages]
        furniture = _furniture(pages_lines, [p.height for p in pdf.pages])
        texts.append(" ".join(ln["text"] for lines in pages_lines for ln in lines if _furn_key(ln["text"]) not in furniture))
        # 6. each column read through the whole document at the ":" columns the document itself
        # uses (at least twice, the 5 most used): a label wider than LABEL_X and a value that runs
        # over a page break are found in one piece (22/10/2026, real French MSDS). A line that does
        # not split cleanly at that column (a full-width sentence) ends the run, so no word order is
        # made that the source does not show (security review M1, M2).
        body = [ln for lines in pages_lines for ln in lines if _furn_key(ln["text"]) not in furniture]
        colons = Counter(round(w["x0"]) for ln in body for w in ln["words"] if w["text"] == ":" and w["x0"] > LABEL_X)
        for cx in [x for x, n in colons.most_common(5) if n >= 2]:
            for keep in (lambda w: w["x1"] <= cx - 8, lambda w: w["x0"] >= cx + 8):
                run = []
                for ln in body:
                    if any(w["x1"] > cx - 8 and w["x0"] < cx + 8 and w["text"] != ":" for w in ln["words"]):
                        if run:
                            texts.append(" ".join(run))
                        run = []
                        continue
                    run += [w["text"] for w in ln["words"] if keep(w)]
                if run:
                    texts.append(" ".join(run))
        for page in pdf.pages:
            texts.append(page.extract_text() or "")
            # 4. the same source as the reader sees it: letters printed twice for bold read
            # once, a letter in another font kept in its word (20/10/2026, real MSDS)
            if hasattr(page, "dedupe_chars"):
                texts.append(dedupe(page).extract_text() or "")
            texts += [ln["text"] for ln in _lines(page)]
            for table in (page.extract_tables() or []):
                for row in table:
                    for cell in row:
                        if cell:
                            texts.append(cell.replace("\n", " "))
            words = page.extract_words()
            for lo, hi in ((0, LABEL_X), (LABEL_X, 10_000)):
                col = [w for w in words if lo <= w["x0"] < hi]
                col.sort(key=lambda w: (round(w["top"] / 2.0), w["x0"]))
                texts.append(" ".join(w["text"] for w in col))
    if scrub_tokens:
        ident = set(scrub_tokens)
        texts += [scrub_text(t, ident) for t in texts]
    return texts


def main():
    ap = argparse.ArgumentParser(description="TMC SDS Neutralizer")
    ap.add_argument("pdf")
    ap.add_argument("--entity", required=True, help="JSON file with the TMC entity block")
    ap.add_argument("--output", required=True)
    ap.add_argument("--product-name", default=None)
    ap.add_argument("--file-nr", default=None)
    ap.add_argument("--template", default=str(TEMPLATE))
    ap.add_argument("--render-pdf", action="store_true",
                    help="also render a PDF via LibreOffice")
    ap.add_argument("--auto-name", action="store_true",
                    help="name the output <ENTITYCODE>_<source stem>, e.g. "
                         "TMC_..., TMCGULF_..., PHARMALABO_...")
    a = ap.parse_args()

    print("\nTransmare SDS Neutralizer")
    print("=" * 45)

    entity = json.loads(Path(a.entity).read_text(encoding="utf-8"))

    img_dir = Path(a.output).parent / ("_img_" + Path(a.pdf).stem)
    els, meta = extract(a.pdf, str(img_dir))
    n_img = sum(len(e["images"]) for e in els if e["kind"] == "image")
    print(f"  i  source      : {meta.get('pages')} page(s), "
          f"product '{meta.get('product_name')}'")
    print(f"  i  images      : {n_img} carried over "
          f"(GHS / PPE / transport pictograms; supplier logo dropped)")

    els, meta, rep = neutralise(els, meta, entity, a.product_name, a.file_nr)

    if a.auto_name:
        newp, code, known = output_path(entity, meta.get("product_name"), a.output)
        newp, clash = non_clobbering(newp)
        a.output = str(newp)
        if known:
            print(f"  i  entity code : {code}  ->  {newp.name}")
        else:
            print(f"  !  entity code : {code} derived from the entity name - add a "
                  f'"code" field to the entity record to set it explicitly')
        if clash:
            print(f"  !  {clash.name} already exists and is left untouched; "
                  f"this run is written as {newp.name}")
    print(f"  i  1.3 replaced by TMC entity block ({entity.get('naam','')})")
    print(f"  i  1.4 emergency number -> {entity.get('nood') or TMC_EMERGENCY}")
    print(f"  i  supplier strings scrubbed: {len(rep['supplier_tokens'])}")
    for t in rep["supplier_tokens"]:
        print(f"       - {t}")
    if rep["residual"]:
        print("  x  SUPPLIER IDENTITY STILL PRESENT:")
        for item in rep["residual"]:
            print("       ", item)
        sys.exit("Aborted: neutralisation incomplete.")
    for s, ctx in rep.get("review", []):
        print(f"  !  kept (regulatory context, review): '{s}' in \"{ctx}\"")
    for t in meta.get("furniture", []):
        print(f"  i  repeated page header/footer left out after its first time: '{t[:80]}'")
    for t in rep.get("removed_lines", []):
        print(f"  i  removed (supplier details): '{t[:80]}'")

    if rep.get("product_name_to"):
        print(f"  i  trade name  : '{rep['product_name_from']}' -> "
              f"'{rep['product_name_to']}' ({rep.get('trade_name_fields', 0)} field(s); "
              f"chemical name, IUPAC name and synonyms left untouched)")

    build(els, meta, a.template, a.output)

    # ---- HARD RULE: nothing in the output may be invented -------------------
    src_texts = _source_corpus(a.pdf, rep.get("supplier_tokens", []))
    allowed = [v for v in entity.values() if isinstance(v, str)]
    allowed += [a.product_name or "", a.file_nr or "", TMC_EMERGENCY]
    allowed += rep.get("tmc_block", [])
    provenance.assert_clean(
        a.output, src_texts, allowed, template_path=a.template,
        source_pdf=a.pdf,
        on_fail=lambda: Path(a.output).unlink(missing_ok=True))
    print("  ok provenance: every string traced to the source or a supplied value")

    print(f"  ok DOCX -> {Path(a.output).name}")

    pdf_out = None
    if a.render_pdf:
        soffice = shutil.which("libreoffice") or shutil.which("soffice")
        if not soffice:
            print("  !  PDF skipped: LibreOffice not found")
        else:
            subprocess.run([soffice, "--headless", "--convert-to", "pdf",
                            "--outdir", str(Path(a.output).parent), a.output],
                           capture_output=True, timeout=600)
            pdf_out = Path(a.output).with_suffix(".pdf")
            print(f"  ok PDF  -> {pdf_out.name}")

    if pdf_out and pdf_out.exists():
        lost, gained = compare(a.pdf, str(pdf_out), rep, entity, meta)
        if lost or gained:
            print("  x  VERIFICATION FAILED - content changed beyond the swap")
            if lost:
                print("     lost  :", lost)
            if gained:
                print("     gained:", gained)
            Path(a.output).unlink(missing_ok=True)
            pdf_out.unlink(missing_ok=True)
            sys.exit("Output deleted. Nothing is guessed.")
        print("  ok verification: content identical apart from the supplier/TMC swap")

    print("\nDone.\n")


if __name__ == "__main__":
    main()
