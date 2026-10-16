"""Provenance gate must block every invented value on an SDS.

Needs a supplier SDS at engine/samples/job2.pdf (not in git). Run:
    python -m pytest tests/test_sds_rejects_invented_values.py
"""
import sys, json, tempfile
from pathlib import Path
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
from extract_sds import extract
from neutralise_sds import neutralise
from build_sds_docx import build
import provenance
from neutralize_sds_docx import _source_corpus

SRC = str(ROOT / "samples" / "job2.pdf")
ent = json.load(open(ROOT / "entity.example.json", encoding="utf-8"))

CASES = {
    "altered number (165 -> 171 C)":
        {"kind": "kv", "label": "Flash point", "value": "171 °C (Closed cup, 1013 hPa)"},
    "invented test method":
        {"kind": "kv", "label": "Melting point", "value": "172 °C (ASTM D3418)"},
    "rounded purity":
        {"kind": "kv", "label": "Assay", "value": "99.6 %"},
    "hallucinated regulatory claim":
        {"kind": "para", "text": "This product is authorised for cosmetic use in the EU."},
    "invented phone":
        {"kind": "kv", "label": "Telephone", "value": "+32 3 555 12 34"},
    "plausible reworded sentence":
        {"kind": "para", "text": "Harmful if swallowed and may cause cancer in humans."},
}

def test_sds_rejects_invented_values():
    if not Path(SRC).exists():
        import pytest
        pytest.skip(f"sample SDS missing: {SRC}")
    ok, bad = run()
    assert bad == 0, f"{bad} invented value(s) let through"


def run():
  ok = bad = 0
  tmp = Path(tempfile.mkdtemp())
  for label, case in CASES.items():
      case.setdefault("page", 5)
      els, meta = extract(SRC)
      els, meta, rep = neutralise(els, meta, ent, None, None)
      els.insert(40, case)
      out = str(tmp / f"n_{abs(hash(label))}.docx")
      build(els, meta, str(ROOT / "assets" / "TMC_SDS_template.docx"), out)
      allowed = [v for v in ent.values() if isinstance(v, str)] + rep.get("tmc_block", [])
      try:
          provenance.assert_clean(out, _source_corpus(SRC, rep["supplier_tokens"]), allowed,
                                  on_fail=lambda o=out: Path(o).unlink(missing_ok=True))
          print(f"  LET THROUGH : {label}")
          bad += 1
      except RuntimeError as e:
          offend = str(e).strip().split("\n")[1].strip()
          print(f"  blocked     : {label}")
          print(f"                {offend}   | file deleted: {not Path(out).exists()}")
          ok += 1
  print(f"\n  {ok}/{len(CASES)} invented values blocked, {bad} let through")
  return ok, bad


if __name__ == "__main__":
    _, bad = run()
    sys.exit(1 if bad else 0)
