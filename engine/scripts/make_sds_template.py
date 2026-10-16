"""Generate assets/TMC_SDS_template.docx: TMC header/footer, empty body.

Header : TMC banner logo (inline) - identification lines are filled per document.
Footer : TMC address bar (inline) + document control line + page number.
The round COA approval stamp is deliberately NOT used: an SDS is not an
approved-and-signed certificate.
"""
import sys
from pathlib import Path
from docx import Document
from docx.shared import Pt, Cm
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

assets = Path(sys.argv[1])
out = Path(sys.argv[2])

doc = Document()
s = doc.sections[0]
s.page_width, s.page_height = Cm(21.0), Cm(29.7)
s.left_margin = s.right_margin = Cm(1.8)
s.top_margin, s.bottom_margin = Cm(4.4), Cm(2.4)
s.header_distance, s.footer_distance = Cm(0.8), Cm(0.6)

st = doc.styles["Normal"]
st.font.name = "Arial"
st.font.size = Pt(8)
st.element.rPr.rFonts.set(qn("w:eastAsia"), "Arial")

hp = s.header.paragraphs[0]
hp.alignment = WD_ALIGN_PARAGRAPH.LEFT
hp.paragraph_format.space_after = Pt(2)
hp.add_run().add_picture(str(assets / "logo.png"), width=Cm(17.4))

fp = s.footer.paragraphs[0]
fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
fp.paragraph_format.space_before = Pt(0)
fp.paragraph_format.space_after = Pt(0)
fp.add_run().add_picture(str(assets / "stamp.png"), width=Cm(15.0))  # address bar

pg = s.footer.add_paragraph()
pg.alignment = WD_ALIGN_PARAGRAPH.CENTER
pg.paragraph_format.space_before = Pt(1)


def _field(par, instr):
    for kind, txt in (("begin", None), ("instr", instr), ("end", None)):
        run = par.add_run()
        run.font.size = Pt(6.5)
        run.font.name = "Arial"
        if kind == "instr":
            e = OxmlElement("w:instrText")
            e.set(qn("xml:space"), "preserve")
            e.text = txt
        else:
            e = OxmlElement("w:fldChar")
            e.set(qn("w:fldCharType"), kind)
        run._r.append(e)


def _txt(par, s_):
    run = par.add_run(s_)
    run.font.size = Pt(6.5)
    run.font.name = "Arial"


_field(pg, " PAGE ")
_txt(pg, " / ")
_field(pg, " NUMPAGES ")

doc.save(str(out))
print("template ->", out)
