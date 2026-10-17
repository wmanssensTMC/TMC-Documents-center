"""File names: the web library (web/lib/naming.ts) and the engine must agree.
Both run the same cases from tests/naming_cases.json.
Run:  python tests/test_naming_parity.py
"""
import json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "scripts"))
from neutralize_docx import make_output_stem      # noqa: E402
from neutralize_sds_docx import _safe             # noqa: E402
from tmc_common import safe_part                  # noqa: E402


def engine_name(c):
    code = c["entity"]
    if c["type"] == "COA":
        src = f"x/{c['fallbackStem']}.pdf" if c.get("fallbackStem") else ""
        return make_output_stem(c.get("fileNr"), c.get("productName"), c.get("batch"), src, code)
    if c["type"] == "MSDS":
        return f"{code}_MSDS_{_safe(c.get('productName'))}"
    return "_".join(x for x in (code, "TDS", safe_part(c.get("productName"))) if x)


def test_naming_parity():
    cases = json.loads((HERE / "naming_cases.json").read_text(encoding="utf-8"))
    bad = [(c["expected"], engine_name(c)) for c in cases if engine_name(c) != c["expected"]]
    assert not bad, f"engine names differ: {bad}"


if __name__ == "__main__":
    test_naming_parity()
    print("naming parity: ok")
