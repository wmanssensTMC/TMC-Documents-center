"""
HARD RULE — no invented content.
================================
Every piece of text in a produced document must be traceable to one of exactly
two places:

  1. the source document, or
  2. a value the operator supplied explicitly (entity block, product name,
     file number), or a literal declared in ALLOWED_LITERALS below.

Anything else is invented, and a document containing invented text is not
allowed to exist. check() returns the violations; the callers delete the
output and abort when the list is non-empty. There is no override flag.
"""
import hashlib
import re
import unicodedata
import zipfile

# Fixed labels the builder itself writes. Every literal the code is permitted
# to add is listed here, so the set of injectable strings stays auditable.
ALLOWED_LITERALS = (
    "Supplier",     # section 1.3 heading word, SDS only
    "VAT:",         # label in front of the entity VAT number
    "T",            # telephone marker in front of the entity phone
    "TMC file nr:",  # label in front of the supplied file number
    ":",            # the colon column the SDS two-column layout uses
)

# Text already present in the approved TMC template is not invented: it is part
# of the template. template_strings() adds it to the allowed set.


def norm(text):
    t = unicodedata.normalize("NFKD", text or "")
    t = re.sub(r"[̀-ͯ]", "", t)
    t = (t.replace("–", "-").replace("—", "-")
          .replace("’", "'").replace(" ", " "))
    t = re.sub(r"[^A-Za-z0-9]+", " ", t)
    return " ".join(t.lower().split())


def build_corpus(source_texts):
    """Normalised haystack. Pass the source's linear page text AND every table
    cell string, plus scrubbed variants, so that legitimate reflow and the
    supplier->TMC removal do not read as invention. The whole document joined
    is added too, so a value continuing across a page break still matches."""
    parts = [norm(t) for t in source_texts if norm(t)]
    return parts + [" ".join(parts)]


def docx_strings(path):
    """Every visible text run in body, headers and footers."""
    out = []
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if not re.match(r"word/(document|header\d*|footer\d*)\.xml$", name):
                continue
            xml = z.read(name).decode("utf-8", "ignore")
            for para in re.findall(r"<w:p[ >].*?</w:p>", xml, re.S):
                # a line break or tab between runs is white space, not a join
                # (v0.6.0: TDS values span several lines inside one cell)
                bits = re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>|<w:(?:br|tab|cr)\b[^>]*/>", para, re.S)
                txt = "".join(bt if bt else " " for bt in bits)
                txt = (txt.replace("&amp;", "&").replace("&lt;", "<")
                          .replace("&gt;", ">").replace("&quot;", '"')
                          .replace("&apos;", "'"))
                if txt.strip():
                    out.append((name, txt.strip()))
    return out


def _image_hashes_docx(path):
    out = set()
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if name.startswith("word/media/"):
                out.add(hashlib.sha256(z.read(name)).hexdigest())
    return out


def _image_hashes_pdf(pdf_path):
    """Hash every image in the source, both as stored and as re-encoded PNG,
    so a picture carried into the output can be matched either way."""
    out = set()
    try:
        import pymupdf
    except ImportError:
        return out
    doc = pymupdf.open(pdf_path)
    for xref in {i[0] for pno in range(len(doc)) for i in doc[pno].get_images(full=True)}:
        try:
            raw = doc.extract_image(xref)["image"]
            out.add(hashlib.sha256(raw).hexdigest())
        except Exception:
            pass
        try:
            pix = pymupdf.Pixmap(doc, xref)
            if pix.n - pix.alpha > 3:
                pix = pymupdf.Pixmap(pymupdf.csRGB, pix)
            out.add(hashlib.sha256(pix.tobytes("png")).hexdigest())
        except Exception:
            pass
    doc.close()
    return out


def template_strings(template_path):
    """Every string in the approved TMC template - labels, headers, footers."""
    if not template_path:
        return []
    try:
        return [t for _, t in docx_strings(template_path)]
    except Exception:
        return []


def traced(n, corpus):
    """True when the normalised text `n` is printed in the source corpus (build_corpus).
    A short string matched loosely ("29" inside "1129") would be a hole, so anything under
    four characters must match on word boundaries. Shared with the AI reader's check."""
    if len(n) < 4:
        pat = re.compile(r"(?:^| )%s(?:$| )" % re.escape(n))
        return any(pat.search(c) for c in corpus)
    return any(n in c for c in corpus)


def check(docx_path, source_texts, allowed_values, template_path=None,
          source_pdf=None):
    """-> list of (location, offending text). Empty means fully traceable."""
    corpus = build_corpus(source_texts)
    allowed = [norm(v) for v in (list(allowed_values) + list(ALLOWED_LITERALS)
                                 + template_strings(template_path)) if norm(v)]

    violations = []

    # Images are content too: every picture in the output must be one that was
    # in the source document or in the approved TMC template. Nothing may be
    # substituted from any other collection of pictograms.
    if source_pdf:
        allowed_imgs = _image_hashes_pdf(source_pdf)
        if template_path:
            allowed_imgs |= _image_hashes_docx(template_path)
        for h in _image_hashes_docx(docx_path) - allowed_imgs:
            violations.append(("word/media", f"<image sha256:{h[:16]}> not from the source"))

    for where, raw in docx_strings(docx_path):
        n = norm(raw)
        if not n:
            continue
        if traced(n, corpus):
            continue
        if any(n in a or a == n for a in allowed):
            continue
        # A line the builder composed from supplied values plus a declared
        # label (e.g. "VAT: BE 0435 913 050") is traceable token by token -
        # but ONLY against the supplied values, never against the source.
        # Matching body text token-by-token against the source would let an
        # invented sentence pass whenever its individual words happen to occur
        # somewhere in the document, so the source demands a contiguous match.
        tokens = n.split()
        pool = " ".join(allowed)
        if tokens and all(re.search(r"(?:^| )%s(?:$| )" % re.escape(tok), pool)
                          for tok in tokens):
            continue
        violations.append((where, raw))
    return violations


def assert_clean(docx_path, source_texts, allowed_values, on_fail=None,
                 template_path=None, source_pdf=None):
    v = check(docx_path, source_texts, allowed_values, template_path, source_pdf)
    if v:
        if on_fail:
            on_fail()
        lines = "\n".join(f"    [{w}] {t[:110]}" for w, t in v[:25])
        raise RuntimeError(
            "HARD RULE VIOLATED - text in the output cannot be traced to the "
            f"source or to a supplied value ({len(v)} item(s)):\n{lines}\n"
            "The output has been deleted. Nothing is guessed: fix the input "
            "or the mapping, then re-run.")
    return True
