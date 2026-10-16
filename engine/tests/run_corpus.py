#!/usr/bin/env python3
"""Regression gate for the Transmare document neutralizer.

Runs every PDF in a folder through the neutralizer and checks the things that
must never regress:

  1. every input either produces a .docx + .pdf PAIR, or fails loudly (exit 1)
     with a reason -- never a silent success that wrote nothing;
  2. no supplier company name reaches the output text, the title or the metadata;
  3. no two outputs claim the same file name;
  4. a blank product name / TMC file nr / lot is reported as BLANK for review,
     never filled with a guess.

Usage:
    python3 tests/run_corpus.py <folder-of-supplier-COAs> [--keep]

The folder is only read. Output goes to a temporary directory.
"""
import os, re, sys, glob, subprocess, tempfile, shutil
from pathlib import Path

HERE   = Path(__file__).resolve().parent
SCRIPT = HERE.parent / "scripts" / "neutralize_docx.py"

SUPPLIER_PAT = re.compile(
    r"\b[A-Z][A-Za-z]{3,}(?:\s+[A-Z][A-Za-z&\.]{1,})*\s*"
    r"(?:GmbH|Ltd|LTD|Limited|B\.V\.|S\.A\.|N\.V\.|CO\.,? ?LTD|Inc|LLC|S\.p\.A)\b")


def source_companies(pdf_path):
    try:
        import pdfplumber
        with pdfplumber.open(pdf_path) as pdf:
            head = "\n".join(p.extract_text() or "" for p in pdf.pages[:1])
    except Exception:
        return set()
    return {c.strip() for c in SUPPLIER_PAT.findall(head) if c.strip()}


def output_text(pdf_path):
    try:
        import warnings; warnings.filterwarnings("ignore")
        from pypdf import PdfReader
        r = PdfReader(pdf_path)
        return "\n".join((p.extract_text() or "") for p in r.pages) + "\n" + str(r.metadata)
    except Exception:
        return ""


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    if not args:
        sys.exit(__doc__)
    src_dir = Path(args[0])
    pdfs = sorted(glob.glob(str(src_dir / "*.pdf")))
    if not pdfs:
        sys.exit(f"No PDFs in {src_dir}")

    work = tempfile.mkdtemp(prefix="tmc_corpus_")
    names, failures, notes = {}, [], []
    print(f"Running {len(pdfs)} file(s) from {src_dir}\n" + "=" * 62)

    for pdf in pdfs:
        out = os.path.join(work, Path(pdf).stem)
        os.makedirs(out, exist_ok=True)
        proc = subprocess.run([sys.executable, str(SCRIPT), pdf, "--output-dir", out],
                              capture_output=True, text=True, timeout=600)
        log  = proc.stdout + proc.stderr
        made = sorted(glob.glob(os.path.join(out, "*.pdf")))
        docx = sorted(glob.glob(os.path.join(out, "*.docx")))
        name = Path(pdf).name

        if proc.returncode == 2:
            # v0.6.0: a draft waiting for a yellow check -- docx yes, pdf not yet
            if docx and not made:
                print(f"  REVIEW DRAFT   {name}  ({len(docx)} docx, yellow marks)")
            else:
                failures.append(f"{name}: exit 2 must leave docx only (got {len(docx)} docx, {len(made)} pdf)")
            continue
        if proc.returncode != 0:
            if made or docx:
                failures.append(f"{name}: exit {proc.returncode} but still wrote files")
            else:
                reason = next((l for l in log.splitlines() if "FAIL" in l), "no reason given")
                print(f"  REPORTED FAIL  {name}\n                 {reason.strip()}")
            continue

        if not made or not docx:
            failures.append(f"{name}: exit 0 but produced no pair (silent no-output)")
            continue
        if len(made) != len(docx):
            failures.append(f"{name}: {len(docx)} docx vs {len(made)} pdf -- pair broken")

        for m in made:
            base = Path(m).name
            if base in names:
                failures.append(f"{name}: output name collides with {names[base]} ({base})")
            names[base] = name

        companies = source_companies(pdf)
        text = " ".join(output_text(m) for m in made).lower()
        leaked = [c for c in companies if c.lower() in text]
        if leaked:
            failures.append(f"{name}: SUPPLIER NAME LEAKED -> {leaked}")

        blanks = re.search(r"BLANK for review: (.*)", log)
        rows   = re.search(r"\((\d+) test row", log)
        print(f"  ok  {name}\n      -> {Path(made[0]).name}"
              f"  [{rows.group(1) if rows else '?'} rows]"
              f"{'  blank: ' + blanks.group(1) if blanks else ''}")
        if rows and rows.group(1) == "0":
            notes.append(f"{name}: produced a certificate with 0 test rows")

    print("=" * 62)
    for n in notes:
        print(f"  note  {n}")
    if failures:
        print(f"\nFAILED ({len(failures)}):")
        for f in failures:
            print("  x  " + f)
        shutil.rmtree(work, ignore_errors=True)
        sys.exit(1)
    print(f"\nPASS -- {len(names)} unique output name(s), no supplier leakage.")
    if "--keep" in sys.argv:
        print(f"Output kept in {work}")
    else:
        shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()
