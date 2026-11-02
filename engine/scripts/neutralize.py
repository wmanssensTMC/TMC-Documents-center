#!/usr/bin/env python3
"""
One entry point for every supplier document (v0.6.0, 15/10/2026).

Classifies each file and sends it down the right route:
  COA (+ PFI / OC / contract / invoice)  -> neutralize_docx.py      TMC_COA_<file>_<product>_<batch>
  SDS / MSDS                             -> neutralize_sds_docx.py  TMC_MSDS_<product>
  TDS and specification sheets           -> neutralize_tds_docx.py  TMC_TDS_<product>

Willem, 15/10/2026: a specification sheet goes the TDS way.
The entity prefix (TMC, TMCGULF, PHARMALABO ...) follows --entity.

Exit code: 0 all done (docx + pdf), 2 at least one draft waits for a yellow check,
1 something failed. Use --finalise <docx> on a checked draft to make its PDF.

  python neutralize.py FILE [FILE ...] --output-dir OUT [--entity e.json]
         [--product-name NAME] [--file-nr 840.S0850] [--batch LOT] [--type coa|sds|tds]
"""
import argparse, os, re, subprocess, sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
from tmc_common import DEFAULT_ENTITY, finalise, EXIT_REVIEW   # noqa: E402

def _phrases(words):
    return "|".join(re.escape(w).replace(r"\ ", r"\s+") for w in words)


# One list of COA titles for the dispatcher and the COA route (20/10/2026: real COAs titled
# "Quality certificate" and "PRODUCT ANALYSIS REPORT" were not recognised here).
from neutralize_docx import COA_KEYWORDS  # noqa: E402
COA_RE = re.compile(r"certificate\s+of\s+analysis|certificat\s+d.analyse|certificaat\s+van\s+analyse|"
                    r"analysenzertifikat|analysis\s+certificate|certificado\s+de\s+an[aá]lisis|"
                    r"\bC\.?O\.?A\.?\b|" + _phrases(COA_KEYWORDS), re.I)
SDS_RE = re.compile(r"safety\s+data\s+sheet|fiche\s+de\s+donn[ée]es\s+de\s+s[ée]curit[ée]|"
                    r"veiligheidsinformatieblad|sicherheitsdatenblatt|ficha\s+de\s+datos\s+de\s+seguridad|"
                    r"\bM?SDS\b", re.I)
TDS_RE = re.compile(r"technical\s+data\s+sheet|product\s+data\s+sheet|technical\s+information|technical\s+sheet|"
                    r"\bspecifications?\b|fiche\s+technique|technische\s+fiche|technisches\s+datenblatt|"
                    r"ficha\s+t[ée]cnica|\bTDS\b", re.I)
REF_RE = re.compile(r"pro\s*-?forma|\bPFI\b|order\s+confirmation|contrat\s+de\s+vente|"
                    r"sales\s+contract|commercial\s+invoice|\binvoice\b|factuur|facture|"
                    r"purchase\s+order|bestelbon|inkooporder|bon\s+de\s+commande", re.I)


def first_text(path, chars=2500):
    try:
        import pdfplumber
        with pdfplumber.open(path) as pdf:
            t = " ".join((p.extract_text() or "") for p in pdf.pages[:2])
    except Exception:
        t = ""
    if len(t.strip()) < 80:          # scan: read page 1 with Tesseract
        try:
            import pytesseract
            from pdf2image import convert_from_path
            t = pytesseract.image_to_string(convert_from_path(path, dpi=200, first_page=1,
                                                              last_page=1)[0])
        except Exception:
            pass
    return t[:chars]


def classify(path):
    t = first_text(path)
    head = t[:600]
    # an order or contract titled as such stays one, also when it asks for a COA further down
    title = "\n".join([ln for ln in t.split("\n") if ln.strip()][:3])
    if REF_RE.search(title) and not COA_RE.search(title):
        return "ref"
    # the title decides first: a COA with a "Specification" column is still a COA
    if COA_RE.search(head):
        return "coa"
    if SDS_RE.search(head):
        return "sds"
    if TDS_RE.search(head):
        return "tds"
    if REF_RE.search(head):
        return "ref"
    for rx, kind in ((COA_RE, "coa"), (SDS_RE, "sds"), (TDS_RE, "tds"), (REF_RE, "ref")):
        if rx.search(t):
            return kind
    return "unknown"


def run(cmd, ai=False):
    """`ai`: only the COA route gets the AI reader's settings and key; TDS and SDS runs never
    see them (security review F6, 27/10/2026)."""
    print("\n$ " + " ".join(Path(c).name if i == 1 else c for i, c in enumerate(cmd)))
    env = None if ai else {k: v for k, v in os.environ.items()
                           if not (k.startswith("AI_READER") or k.startswith("ANTHROPIC_"))}
    return subprocess.run(cmd, env=env).returncode


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--output-dir", required=False)
    ap.add_argument("--entity", default=str(DEFAULT_ENTITY))
    ap.add_argument("--product-name")
    ap.add_argument("--file-nr")
    ap.add_argument("--batch")
    ap.add_argument("--type", choices=["coa", "sds", "tds"],
                    help="force the route for every file (the platform's job type)")
    ap.add_argument("--from-json", help="TDS only: the platform's reading of the sheet")
    ap.add_argument("--finalise", action="store_true")
    a = ap.parse_args()

    if a.finalise:
        bad = [f for f in a.files if not finalise(f)]
        sys.exit(1 if bad else 0)

    kinds = {f: (a.type or classify(f)) for f in a.files}
    for f, k in kinds.items():
        print(f"  {Path(f).name}  ->  {k.upper()}")
    py = sys.executable
    common = ["--entity", a.entity] + (["--output-dir", a.output_dir] if a.output_dir else [])
    codes = []

    coa = [f for f, k in kinds.items() if k == "coa"]
    refs = [f for f, k in kinds.items() if k == "ref"]
    if coa:
        cmd = [py, str(HERE / "neutralize_docx.py")] + coa + refs + common
        for opt, val in (("--product-name", a.product_name), ("--file-nr", a.file_nr),
                         ("--batch", a.batch)):
            if val:
                cmd += [opt, val]
        codes.append(run(cmd, ai=True))
    for f in [f for f, k in kinds.items() if k == "tds"]:
        cmd = [py, str(HERE / "neutralize_tds_docx.py"), f] + common
        if a.product_name:
            cmd += ["--product-name", a.product_name]
        if a.from_json:
            cmd += ["--from-json", a.from_json]
        codes.append(run(cmd))
    for f in [f for f, k in kinds.items() if k == "sds"]:
        od = Path(a.output_dir or Path(f).parent)
        od.mkdir(parents=True, exist_ok=True)
        cmd = [py, str(HERE / "neutralize_sds_docx.py"), f, "--entity", a.entity,
               "--output", str(od / (Path(f).stem + ".docx")), "--auto-name", "--render-pdf"]
        if a.product_name:
            cmd += ["--product-name", a.product_name]
        if a.file_nr:
            cmd += ["--file-nr", a.file_nr]
        codes.append(run(cmd))
    unknown = [f for f, k in kinds.items() if k == "unknown"]
    for f in unknown:
        print(f"  x  {Path(f).name}: not recognised as COA, SDS, TDS or specification - "
              f"nothing written. Pass --type to force a route.")
    if refs and not coa:
        print("  i  commercial document(s) without a COA: nothing to build from them")
    if not codes:
        sys.exit(1)
    if any(c not in (0, EXIT_REVIEW) for c in codes) or unknown:
        sys.exit(1)
    sys.exit(EXIT_REVIEW if EXIT_REVIEW in codes else 0)


if __name__ == "__main__":
    main()
