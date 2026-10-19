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
    # unique texts: older engine versions listed a merged cell once per grid column
    check("only confirmed parts lose their yellow; the rest stays", rc == 0 and sorted(set(left)) == ["footer sentence kept"], err + str(left))
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

    (d / "same.json").write_text(json.dumps({"y0": {"value": "PRODUCTNAME"}, "y1": {"value": "01/09/2O29"}, "y2": {"value": "footer sentence kept"}}))
    run("apply", d / "d.docx", d / "same.json", d / "same.docx")
    a = [r.text for p in Document(str(d / "d.docx")).paragraphs for r in p.runs]
    b = [r.text for p in Document(str(d / "same.docx")).paragraphs for r in p.runs]
    check("OK as is never changes the text", a == b, f"{a} != {b}")

    long_doc = Document(); long_doc.add_paragraph().add_run("x" * 600).font.highlight_color = WD_COLOR_INDEX.YELLOW
    long_doc.save(d / "long.docx")
    _, out, _ = run("list", d / "long.docx")
    check("parts over 500 characters are flagged for Word", json.loads(out)[0]["truncated"] is True, out)
    (d / "long.json").write_text(json.dumps({"y0": {"value": "x" * 500}}))
    rc, _, _ = run("apply", d / "long.docx", d / "long.json", d / "long_out.docx")
    check("and cannot be finalised on screen", rc == 1)

    (d / "forbid.json").write_text(json.dumps(["Acme Chemicals GmbH"]))
    rc, _, err = run("check", d / "all.docx", d / "forbid.json")
    check("check: a clean Word file passes", rc == 0, err)
    named = Document(); named.add_paragraph("Made by ACME   chemicals gmbh, Berlin"); named.save(d / "named.docx")
    rc, _, err = run("check", d / "named.docx", d / "forbid.json")
    check("check: refused when the supplier is named (any case or spacing)", rc == 1 and "supplier" in err, err)
    hf = Document(); hf.sections[0].footer.paragraphs[0].text = "Acme Chemicals GmbH"; hf.save(d / "hf.docx")
    rc, _, err = run("check", d / "hf.docx", d / "forbid.json")
    check("check: also looks in headers and footers", rc == 1, err)
    import zipfile
    with zipfile.ZipFile(d / "all.docx") as src, zipfile.ZipFile(d / "ext.docx", "w") as dst:
        for i in src.infolist():
            data = src.read(i)
            if i.filename == "word/_rels/document.xml.rels":
                data = data.replace(b"</Relationships>", b'<Relationship Id="rX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="http://evil.example/x.png" TargetMode="External"/></Relationships>')
            dst.writestr(i, data)
    rc, _, err = run("check", d / "ext.docx", d / "forbid.json")
    check("check: refused when it links to outside content", rc == 1 and "outside" in err, err)
    def patched(src_name, out_name, part, old, new):
        with zipfile.ZipFile(d / src_name) as src, zipfile.ZipFile(d / out_name, "w") as dst:
            for i in src.infolist():
                data = src.read(i)
                if i.filename == part:
                    data = data.replace(old, new)
                dst.writestr(i, data)

    patched("all.docx", "ext2.docx", "word/_rels/document.xml.rels", b"</Relationships>",
            b"<Relationship Id='rY' Type='http://schemas.openxmlformats.org/officeDocument/2006/relationships/image' "
            b"Target='file:///etc/passwd' targetmode='EXTERNAL'/></Relationships>")
    rc, _, err = run("check", d / "ext2.docx", d / "forbid.json")
    check("check: outside link refused however it is written (N1)", rc == 1 and "outside" in err, err)

    patched("all.docx", "link.docx", "word/_rels/document.xml.rels", b"</Relationships>",
            b'<Relationship Id="rZ" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" '
            b'Target="https://www.transmare.com" TargetMode="External"/></Relationships>')
    rc, _, err = run("check", d / "link.docx", d / "forbid.json")
    check("check: a normal web link is allowed", rc == 0, err)

    patched("all.docx", "field.docx", "word/document.xml", b"</w:body>",
            b'<w:p><w:r><w:instrText xml:space="preserve"> INCLUDEPICTURE "http://evil.example/x.png" </w:instrText></w:r></w:p></w:body>')
    rc, _, err = run("check", d / "field.docx", d / "forbid.json")
    check("check: a field that includes outside content is refused (N1)", rc == 1 and "field" in err, err)

    props = Document(); props.add_paragraph("clean text"); props.core_properties.author = "Acme Chemicals GmbH"
    props.save(d / "props.docx")
    rc, _, err = run("check", d / "props.docx", d / "forbid.json")
    check("check: supplier in the document properties is refused (N2)", rc == 1 and "supplier" in err, err)

    punct = Document(); punct.add_paragraph("Produced by ACME-Chemicals, G.m.b.H."); punct.save(d / "punct.docx")
    rc, _, err = run("check", d / "punct.docx", d / "forbid.json")
    check("check: supplier written with punctuation is refused (N2)", rc == 1 and "supplier" in err, err)

    other = Document(); other.add_paragraph("Acme is a common word; chemicals too."); other.save(d / "other.docx")
    rc, _, err = run("check", d / "other.docx", d / "forbid.json")
    check("check: parts of the name alone do not trigger", rc == 0, err)

    # name and content agree (Willem 19/10): each value of the file name is printed
    (d / "shown.json").write_text(json.dumps([["product name", "Sodium Benzoate"], ["batch", "SB-1"]]))
    shown = Document(); shown.add_paragraph("Product: SODIUM BENZOATE"); shown.add_paragraph("Lot SB-1"); shown.save(d / "shown.docx")
    rc, _, err = run("check", d / "shown.docx", d / "forbid.json", d / "shown.json")
    check("check: passes when every value of the file name is printed", rc == 0, err)
    (d / "notshown.json").write_text(json.dumps([["product name", "Benzoate Pure"]]))
    rc, _, err = run("check", d / "shown.docx", d / "forbid.json", d / "notshown.json")
    check("check: refused when the file name has a value the document does not print", rc == 1 and "not printed" in err, err)
    (d / "part.json").write_text(json.dumps([["product name", "Sodium Benzo"]]))
    rc, _, err = run("check", d / "shown.docx", d / "forbid.json", d / "part.json")
    check("check: part of a printed word does not count (review M2)", rc == 1 and "not printed" in err, err)
    (d / "cyr.json").write_text(json.dumps([["product name", "Ацетон"]]))
    rc, _, err = run("check", d / "shown.docx", d / "forbid.json", d / "cyr.json")
    check("check: a value in non-Latin letters cannot slip through unchecked (review M2)", rc == 1 and "cannot be checked" in err, err)

    patched("all.docx", "tracked.docx", "word/document.xml", b"</w:body>",
            b'<w:p><w:del w:id="9" w:author="x"><w:r><w:delText>Acme Chemicals GmbH</w:delText></w:r></w:del></w:p></w:body>')
    rc, _, err = run("check", d / "tracked.docx", d / "forbid.json")
    check("check: tracked changes are refused, deleted supplier text included (N1)", rc == 1 and "tracked" in err, err)

    # on-screen edits (Willem 19/10): what changed, and what is not in the supplier original
    from reportlab.pdfgen import canvas as pdfcanvas
    src = pdfcanvas.Canvas(str(d / "source.pdf")); src.drawString(72, 720, "Assay 99.6 % Loss on drying 0.4 %"); src.save()
    before = Document(); before.add_paragraph("Assay 99.6 %"); t = before.add_table(rows=1, cols=1)
    t.cell(0, 0).text = "Loss on drying 0.4 %"; before.save(d / "before.docx")
    after = Document(); after.add_paragraph("Assay 99.9 %"); t = after.add_table(rows=1, cols=1)
    t.cell(0, 0).text = "Loss on drying 0.4 %"; after.add_paragraph("Loss on drying 0.4 %"); after.save(d / "after.docx")
    rc, out, err = run("changes", d / "before.docx", d / "after.docx", d / "source.pdf")
    got = json.loads(out) if rc == 0 else []
    check("changes: each change listed with before and after", rc == 0 and len(got) == 2 and got[0]["before"] == "Assay 99.6 %"
          and got[0]["after"] == "Assay 99.9 %", out + err)
    check("changes: a number not in the original is a warning", got and got[0]["unknown"] == ["99.9"], out)
    check("changes: text taken from the original is not", len(got) > 1 and got[1]["unknown"] == [], out)
    rc, out, err = run("changes", d / "before.docx", d / "before.docx", d / "source.pdf")
    check("changes: nothing changed, nothing listed", rc == 0 and json.loads(out) == [], out + err)
    swap = Document(); swap.add_paragraph("Assay 6.99 %"); t = swap.add_table(rows=1, cols=1)
    t.cell(0, 0).text = "Loss on drying 0.4 %"; swap.save(d / "swap.docx")
    rc, out, err = run("changes", d / "before.docx", d / "swap.docx", d / "source.pdf")
    check("changes: digits moved around is still a new number (6.99 is not 99.6)", rc == 0 and json.loads(out)[0]["unknown"] == ["6.99"], out + err)

    (d / "zip.docx").write_bytes(b"PK\x03\x04 not really a zip")
    rc, _, err = run("check", d / "zip.docx", d / "forbid.json")
    check("check: refused when it is not a real Word file", rc == 1, err)

    if shutil.which("soffice") or shutil.which("libreoffice"):
        rc, _, err = run("preview", d / "d.docx", d / "p.pdf")
        pdf = (d / "p.pdf").read_bytes() if (d / "p.pdf").exists() else b""
        check("preview PDF made with the DRAFT stamp", rc == 0 and pdf.startswith(b"%PDF"), err)
    else:
        print("  skip preview (no LibreOffice)")

print(f"\n{ok} passed, {bad} failed")
sys.exit(1 if bad else 0)
