"""LAPTOP ONLY: run the engine on real dossiers and compare with the TMC versions colleagues made
by hand. Real supplier documents never go into git, GitHub or Vercel (Willem 20/10/2026).

  python tests/compare_real_corpus.py "<OneDrive>/03 COA-SDS-Neutralizer/COA's/1. COA's" <temp output folder>

Each dossier folder holds "COA - EXTERN" (supplier COAs), "COA - INTERN" (TMC versions) and the
commercial document. Output and report.json go to the output folder only.
"""
import json, re, subprocess, sys
from pathlib import Path

ENGINE = Path(__file__).resolve().parent.parent
PY = sys.executable
FIELDS = [("lot", r"Lot\s*/\s*batch\s*nr"), ("production", r"Production\s*dat[ae]"),
          ("expiry", r"Expiry\s*date"), ("file_nr", r"TMC\s*file\s*nr")]
TOKEN = re.compile(r"[^\W_]+(?:[.,/:-][^\W_]+)*")


def text_of(path):
    path = Path(path)
    if path.suffix.lower() == ".docx":
        from docx import Document
        d = Document(str(path))
        lines = [p.text for p in d.paragraphs]
        for t in d.tables:
            for r in t.rows:
                seen = []
                for c in r.cells:
                    if c.text not in seen:
                        seen.append(c.text)
                lines.append("  ".join(seen))
        return "\n".join(lines)
    import pdfplumber
    with pdfplumber.open(str(path)) as pdf:
        return "\n".join(p.extract_text() or "" for p in pdf.pages)


def fields(text):
    out = {}
    m = re.search(r"Certificate of Analysis\s*[-–]\s*(.+)", text)
    out["product"] = m.group(1).strip() if m else ""
    for key, pat in FIELDS:
        m = re.search(pat + r"\s*[:]?\s*(.*)", text)
        out[key] = m.group(1).strip() if m else ""
    return out


def results_tokens(text):
    i = text.find("Parameter test results")
    body = text[i:] if i >= 0 else text
    return {t.lower() for t in TOKEN.findall(body)}


def norm_name(s):
    return re.sub(r"[^a-z0-9]", "", s.lower())


def main(root, out_root):
    root, out_root = Path(root), Path(out_root)
    report = []
    for dossier in sorted(p for p in root.iterdir() if p.is_dir()):
        subs = {p.name.lower(): p for p in dossier.iterdir() if p.is_dir()}
        ext = next((p for n, p in subs.items() if "extern" in n), None)
        intern = next((p for n, p in subs.items() if "intern" in n), None)
        commercial = [p for p in dossier.iterdir() if p.is_file() and p.suffix.lower() == ".pdf"]
        if not ext:
            report.append({"dossier": dossier.name, "note": "no supplier COA folder"})
            continue
        inputs = sorted(p for p in ext.rglob("*") if p.suffix.lower() == ".pdf")
        out = out_root / dossier.name
        out.mkdir(parents=True, exist_ok=True)
        run = subprocess.run([PY, "-I", str(ENGINE / "scripts" / "neutralize_docx.py"), *map(str, inputs),
                              *map(str, commercial), "--output-dir", str(out)],
                             capture_output=True, text=True, encoding="utf-8", errors="replace")
        (out / "_engine.log").write_text(run.stdout + run.stderr, encoding="utf-8")
        made = sorted(out.glob("*.docx"))
        humans = sorted(p for p in (intern.rglob("*") if intern else []) if p.suffix.lower() in (".pdf", ".docx"))
        entry = {"dossier": dossier.name, "inputs": [p.name for p in inputs], "exit": run.returncode,
                 "engine": [p.stem for p in made], "tmc": [p.name for p in humans], "pairs": []}
        if run.returncode not in (0, 1, 2) or (run.returncode == 1 and not made):
            entry["error"] = (run.stdout + run.stderr)[-1500:]
        for m in made:
            mt = text_of(m)
            mf = fields(mt)
            best, score = None, -1
            for h in humans:
                hs = norm_name(h.stem)
                s = (3 if mf["lot"] and norm_name(mf["lot"]) in hs else 0) + sum(
                    1 for w in re.findall(r"[a-z]{4,}", m.stem.lower()) if w in hs)
                if s > score:
                    best, score = h, s
            pair = {"engine": m.stem, "engine_fields": mf}
            if best is not None and score > 0:
                ht = text_of(best)
                hf = fields(ht)
                he, me = results_tokens(ht), results_tokens(mt)
                pair.update({
                    "tmc": best.name, "tmc_fields": hf,
                    "same_fields": {k: norm_name(mf[k]) == norm_name(hf[k]) for k in mf},
                    "results_recall": round(len(he & me) / len(he), 2) if he else None,
                    "missing_in_engine": sorted(he - me)[:25],
                    "extra_in_engine": sorted(me - he)[:25],
                })
            entry["pairs"].append(pair)
        report.append(entry)
    (out_root / "report.json").write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    for e in report:
        print(f"\n== {e['dossier']}  exit {e.get('exit')}  engine {len(e.get('engine', []))} doc(s), tmc {len(e.get('tmc', []))}")
        if e.get("error"):
            print("   ERROR", e["error"][-400:])
        for p in e.get("pairs", []):
            print(f"   {p['engine']}\n     vs {p.get('tmc', '(no TMC version found)')}")
            if "same_fields" in p:
                diff = {k: (p['engine_fields'][k], p['tmc_fields'][k]) for k, ok in p["same_fields"].items() if not ok}
                print(f"     results found: {p['results_recall']}  field differences: {diff or 'none'}")
                if p["missing_in_engine"]:
                    print(f"     missing in engine: {p['missing_in_engine'][:12]}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
