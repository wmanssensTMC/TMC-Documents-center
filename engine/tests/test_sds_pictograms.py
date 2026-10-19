#!/usr/bin/env python3
"""MSDS hazard pictograms are carried over from the original, in the right place
(19/10/2026, Willem: "take the dangerous icons from the original and put it in the
neutralised doc on the right place is also very important").

Builds its own synthetic supplier SDS (no supplier files needed) and checks:
  1. both GHS pictograms are taken from the source file itself
  2. they stay with their own field ("Hazard pictograms"), between "Signal word" and
     "Hazard statements" in section 2, not floating elsewhere
  3. they keep the size printed on the source (legal minimum size, never scaled)
  4. the supplier logo in the page header is not carried over
Run:  python tests/test_sds_pictograms.py
"""
import json, re, sys, tempfile, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT / "scripts"))
try:
    from PIL import Image, ImageDraw
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
except ImportError:
    sys.exit("SKIP: reportlab or Pillow not installed")
from extract_sds import extract                 # noqa: E402
from neutralise_sds import neutralise           # noqa: E402
from build_sds_docx import build                # noqa: E402

PICTO_PT = 50                                    # printed size of each pictogram


def diamond(path, inner):
    """A GHS-like pictogram: red diamond on white, a different symbol colour each."""
    im = Image.new("RGB", (120, 120), "white")
    d = ImageDraw.Draw(im)
    d.polygon([(60, 4), (116, 60), (60, 116), (4, 60)], outline=(220, 0, 0), width=8)
    d.ellipse((42, 42, 78, 78), fill=inner)
    im.save(path)


def sds(pdf, picto_a, picto_b, logo):
    W, H = A4
    c = canvas.Canvas(str(pdf), pagesize=A4)
    y = lambda top, h=0: H - top - h            # noqa: E731  pdfplumber top -> reportlab y
    c.drawImage(str(logo), 450, y(15, 40), 100, 40)                       # header band
    c.setFont("Helvetica-Bold", 16); c.drawString(40, y(60), "SODIUM BENZOATE")
    c.setFont("Helvetica-Bold", 11); c.drawString(40, y(150), "SECTION 2: Hazards identification")
    c.setFont("Helvetica", 8)

    def kv(top, label, value):
        c.drawString(40, y(top), label); c.drawString(210, y(top), ":"); c.drawString(220, y(top), value)
    kv(180, "Signal word", "Warning")
    c.drawImage(str(picto_a), 220, y(200, PICTO_PT), PICTO_PT, PICTO_PT)
    c.drawImage(str(picto_b), 280, y(200, PICTO_PT), PICTO_PT, PICTO_PT)
    kv(215, "Hazard pictograms", "")
    kv(270, "Hazard statements", "H319 Causes serious eye irritation.")
    c.setFont("Helvetica-Bold", 11); c.drawString(40, y(320), "SECTION 3: Composition")
    c.save()


ok = bad = 0
def check(name, cond, info=""):
    global ok, bad
    print(("  ok  " if cond else "  XX  ") + name + ("" if cond else f"\n{str(info)[-2000:]}"))
    ok, bad = ok + bool(cond), bad + (not cond)


with tempfile.TemporaryDirectory() as d:
    d = Path(d)
    diamond(d / "ghs07.png", (0, 0, 0)); diamond(d / "ghs05.png", (0, 0, 160))
    Image.new("RGB", (200, 80), (30, 60, 200)).save(d / "logo.png")
    sds(d / "sds.pdf", d / "ghs07.png", d / "ghs05.png", d / "logo.png")

    els, meta = extract(str(d / "sds.pdf"), image_dir=str(d / "img"))
    shown = [i for e in els if e["kind"] == "image" for i in e["images"]]
    check("source has three images (two pictograms and the logo)", len(meta["image_shas"]) == 3, meta["image_shas"])
    check("both pictograms are taken from the source, the logo is not", len(shown) == 2, shown)

    ent = json.loads((ROOT / "entity.example.json").read_text(encoding="utf-8"))
    els, meta, _rep = neutralise(els, meta, ent, "Sodium Benzoate", None)
    field = next((e for e in els if e["kind"] == "kv" and e["label"].startswith("Hazard pictograms")), None)
    check("the pictograms belong to their own field", field is not None and len(field.get("images", [])) == 2,
          [(e["kind"], e.get("label"), len(e.get("images", []))) for e in els])

    out = d / "out.docx"
    build(els, meta, str(ROOT / "assets" / "TMC_SDS_template.docx"), str(out))
    with zipfile.ZipFile(out) as z:
        body = z.read("word/document.xml").decode("utf-8")
    text_at = lambda s: body.find(s)            # noqa: E731
    a, b = text_at("Hazard pictograms"), text_at("Hazard statements")
    check("in section 2, between Signal word and Hazard statements",
          0 < text_at("Hazards identification") < text_at("Signal word") < a < b < text_at("Composition"), body[:500])
    check("both pictograms sit with that field, none elsewhere in the body",
          body.count("<w:drawing") == 2 and body[a:b].count("<w:drawing") == 2, body.count("<w:drawing"))
    widths = [int(x) for x in re.findall(r'<wp:extent cx="(\d+)"', body)]
    want = round(PICTO_PT / 72 * 2.54 * 360000)  # EMU
    check("the printed size is kept (never scaled)", widths and all(abs(w - want) < 2000 for w in widths), (widths, want))

print(f"\n{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
