"""
Make a scanned supplier COA readable.

Supplier scans arrive with tiled brand watermarks, big centre logos, dotted
table leaders and grey scanner noise. Plain OCR reads the watermark as text and
loses the numbers. This module renders each page, removes everything that is
lighter than real print, and runs OCR over the cleaned image, producing a
searchable PDF whose text layer has correct geometry.

Nothing here invents content: it only decides which ink on the page is print
and which is background.
"""
import os
import shutil
import subprocess
import tempfile

import numpy as np
from PIL import Image

try:
    import pymupdf
except ImportError:                                    # pragma: no cover
    pymupdf = None

DPI = 400
INK_MAX = 140          # grey level at or below which a pixel counts as print
WATERMARK_MIN = 170    # lighter than this is background / watermark


def _remove_dot_leaders(arr):
    """Erase dotted rulers, keep decimal points.

    Supplier COAs often separate rows and columns with dotted leader lines.
    OCR reads those dots as characters and the numbers next to them get
    mangled. A leader dot is tiny AND one of many aligned on the same band; a
    decimal point is tiny but stands alone. Requiring a long aligned run is
    what keeps "99.9" intact while the rulers go.
    """
    try:
        from scipy import ndimage
    except ImportError:
        return arr

    ink = arr < 250
    lab, n = ndimage.label(ink)
    if n == 0:
        return arr
    objs = ndimage.find_objects(lab)

    small = []
    for idx, sl in enumerate(objs, start=1):
        if sl is None:
            continue
        h = sl[0].stop - sl[0].start
        w = sl[1].stop - sl[1].start
        if h <= 9 and w <= 14 and h * w <= 90:
            small.append((idx, (sl[0].start + sl[0].stop) // 2,
                          (sl[1].start + sl[1].stop) // 2, sl))

    drop = []
    # horizontal rulers: many small blobs sharing a y band
    rows = {}
    for idx, cy, cx, sl in small:
        rows.setdefault(cy // 5, []).append((idx, cx, sl))
    for band in rows.values():
        if len(band) >= 12:
            xs = sorted(b[1] for b in band)
            if xs[-1] - xs[0] > arr.shape[1] * 0.25:
                drop += [(b[0], b[2]) for b in band]
    # vertical rulers: many small blobs sharing an x band
    cols = {}
    for idx, cy, cx, sl in small:
        cols.setdefault(cx // 4, []).append((idx, cy, sl))
    for band in cols.values():
        if len(band) >= 12:
            ys = sorted(b[1] for b in band)
            if ys[-1] - ys[0] > arr.shape[0] * 0.15:
                drop += [(b[0], b[2]) for b in band]

    if not drop:
        return arr
    out = arr.copy()
    for idx, sl in drop:
        region = out[sl]
        region[lab[sl] == idx] = 255
    return out


def _clean_page(img):
    """Drop the watermark, keep the print.

    A supplier watermark is printed light so that it does not obscure the text;
    the text itself is near-black. Splitting on grey level therefore removes the
    watermark (tiled text, centre logo, background tint) and keeps every
    character, without touching the characters themselves.
    """
    grey = np.asarray(img.convert("L"), dtype=np.uint8)
    out = np.full_like(grey, 255)
    out[grey <= INK_MAX] = grey[grey <= INK_MAX]
    # mid-grey pixels are usually anti-aliased edges of real glyphs; keep them
    # only where they sit next to ink, so isolated watermark edges disappear
    mid = (grey > INK_MAX) & (grey < WATERMARK_MIN)
    if mid.any():
        ink = out < 255
        neigh = np.zeros_like(ink)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                neigh |= np.roll(np.roll(ink, dy, 0), dx, 1)
        out[mid & neigh] = grey[mid & neigh]
    out = _remove_dot_leaders(out)
    return Image.fromarray(out)


def is_scanned(pdf_path, min_chars=80):
    import pdfplumber
    with pdfplumber.open(pdf_path) as pdf:
        text = "".join((p.extract_text() or "") for p in pdf.pages)
    return len(text.strip()) < min_chars * max(1, len(text) // 1)


def searchable_copy(pdf_path, out_path=None, dpi=DPI, clean=True, psm="6"):
    """-> path to a searchable PDF, or None when OCR is unavailable."""
    if pymupdf is None or not shutil.which("tesseract"):
        return None
    out_path = out_path or tempfile.mktemp(suffix="_ocr.pdf", prefix="tmc_")
    tmp = tempfile.mkdtemp(prefix="tmc_ocr_")
    parts = []
    try:
        doc = pymupdf.open(pdf_path)
        for pno, page in enumerate(doc):
            pix = page.get_pixmap(dpi=dpi)
            img = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
            if clean:
                img = _clean_page(img)
            png = os.path.join(tmp, f"p{pno:03d}.png")
            img.save(png, dpi=(dpi, dpi))
            stem = os.path.join(tmp, f"p{pno:03d}")
            r = subprocess.run(
                ["tesseract", png, stem, "-l", "eng", "--psm", psm,
                 "-c", "preserve_interword_spaces=1", "pdf"],
                capture_output=True, timeout=300)
            if r.returncode != 0 or not os.path.exists(stem + ".pdf"):
                return None
            parts.append(stem + ".pdf")
        doc.close()

        merged = pymupdf.open()
        for p in parts:
            with pymupdf.open(p) as s:
                merged.insert_pdf(s)
        merged.save(out_path)
        merged.close()
        return out_path
    except Exception:
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    import sys, pdfplumber
    src = sys.argv[1]
    out = searchable_copy(src, sys.argv[2] if len(sys.argv) > 2 else None)
    print("ocr ->", out)
    with pdfplumber.open(out) as pdf:
        for i, p in enumerate(pdf.pages):
            t = p.extract_text() or ""
            print(f"--- page {i+1}: {len(t)} chars")
            print(t[:700])
