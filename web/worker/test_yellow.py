"""Tests for web/worker/yellow.py. Run:  python web/worker/test_yellow.py
Needs python-docx (engine requirements). The preview test also needs LibreOffice."""
import json, shutil, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ENGINE = HERE.parent.parent / "engine"
sys.path.insert(0, str(ENGINE / "scripts"))
from docx import Document                      # noqa: E402
from docx.enum.text import WD_COLOR_INDEX      # noqa: E402
from tmc_common import yellow_runs             # noqa: E402  (the engine's own check)


def run(*args):
    r = subprocess.run([sys.executable, "-I", str(HERE / "yellow.py"), "--engine", str(ENGINE), *map(str, args)],
                       capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


def draft(path):
    doc = Document()
    p = doc.add_paragraph("Product: ")
    p.add_run("PRODUCTNAME").font.highlight_color = WD_COLOR_INDEX.YELLOW
    t = doc.add_table(rows=1, cols=2)
    t.cell(0, 0).text = "Expiry date"
    r = t.cell(0, 1).paragraphs[0].add_run("01/09/2O29")   # OCR doubt
    r.font.highlight_color = WD_COLOR_INDEX.YELLOW
    m = doc.add_table(rows=1, cols=2)
    merged = m.cell(0, 0).merge(m.cell(0, 1))          # appears twice in python-docx
    merged.paragraphs[0].add_run("footer sentence kept").font.highlight_color = WD_COLOR_INDEX.YELLOW
    doc.save(path)


ok = bad = 0
def check(name, cond, info=""):
    global ok, bad
    print(("  ok  " if cond else "  XX  ") + name + ("" if cond else f"\n{info}"))
    ok, bad = ok + bool(cond), bad + (not cond)


with tempfile.TemporaryDirectory() as d:
    d = Path(d)
    draft(d / "d.docx")

    rc, out, err = run("list", d / "d.docx")
    items = json.loads(out) if rc == 0 else []
    check("lists every yellow part once (merged cell counted once)", [i["text"] for i in items] ==
          ["PRODUCTNAME", "01/09/2O29", "footer sentence kept"], out + err)
    check("gives the surrounding text", items and items[0]["context"] == "Product: PRODUCTNAME", out)

    (d / "some.json").write_text(json.dumps({"y0": {"value": "Sodium Benzoate"}, "y1": {"value": "01/09/2029"}}))
    rc, out, err = run("apply", d / "d.docx", d / "some.json", d / "some.docx")
    left = yellow_runs(d / "some.docx")
    check("only confirmed parts lose their yellow; the rest stays", rc == 0 and left == ["footer sentence kept"], err + str(left))
    text = "\n".join(p.text for p in Document(str(d / "some.docx")).paragraphs)
    check("corrections are written in", "Product: Sodium Benzoate" in text, text)

    (d / "all.json").write_text(json.dumps({"y0": {"value": "Sodium Benzoate"}, "y1": {"value": "01/09/2029"},
                                            "y2": {"value": "footer sentence kept"}}))
    rc, out, err = run("apply", d / "d.docx", d / "all.json", d / "all.docx")
    check("all confirmed: the engine's own check finds no yellow", rc == 0 and yellow_runs(d / "all.docx") == [], err)

    (d / "bad.json").write_text(json.dumps({"y9": {"value": "x"}}))
    rc, _, err = run("apply", d / "d.docx", d / "bad.json", d / "bad.docx")
    check("unknown part refused, nothing written", rc == 1 and not (d / "bad.docx").exists(), err)

    (d / "ctrl.json").write_text(json.dumps({"y0": {"value": "a\u0007b"}}))
    rc, _, err = run("apply", d / "d.docx", d / "ctrl.json", d / "ctrl.docx")
    check("control characters refused", rc == 1, err)

    if shutil.which("soffice") or shutil.which("libreoffice"):
        rc, _, err = run("preview", d / "d.docx", d / "p.pdf")
        pdf = (d / "p.pdf").read_bytes() if (d / "p.pdf").exists() else b""
        check("preview PDF made with the DRAFT stamp", rc == 0 and pdf.startswith(b"%PDF"), err)
    else:
        print("  skip preview (no LibreOffice)")

print(f"\n{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
