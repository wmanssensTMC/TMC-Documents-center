"""Strip supplier identity from an extracted SDS and substitute the TMC entity."""
import re

TMC_EMERGENCY = "+32 (0)14 58 45 45"


TRADE_NAME_LABELS = (
    "trade name", "product name", "commercial name", "handelsnaam",
    "productnaam", "nom commercial", "handelsname",
)


def _is_trade_name(label):
    return (label or "").strip().lower().rstrip(":").strip() in TRADE_NAME_LABELS


def _sec_no(text):
    """'1.3', also written '1.3.', '1.3 Fournisseur', 'SECTION 1.3:' (20/10/2026: real MSDS)."""
    m = re.match(r"\s*(?:section|rubrique|abschnitt|rubriek)?\s*(\d{1,2}(?:\.\d{1,2})*)\.?(?=\s|:|$)",
                 text or "", re.I)
    return m.group(1) if m else None


_LATER_SECTIONS = {str(n) for n in range(2, 17)}
_SECTION_WORD = re.compile(r"\s*(?:section|rubrique|abschnitt|rubriek)\b", re.I)


def _heading(e):
    """The section number of a heading line, whatever the supplier made it look like. A plain
    line only counts with a dotted number ("1.4") or the word section: "5 Rue de la Paix" is an
    address, not section 5 (security review R1)."""
    if e["kind"] in ("sub", "section"):
        return _sec_no(e.get("text"))
    if e["kind"] == "para":
        no = _sec_no(e.get("text"))
        if no and ("." in no or _SECTION_WORD.match(e.get("text") or "")):
            return no
    return None


def find_supplier_block(els):
    """Index range of the body of '1.3 Details of the supplier ...'. The block runs to the next
    real heading (1.4, section 2): every line in it is the supplier's identity and is replaced.
    No heading after it: refused, never cut off at a guess (security review R2)."""
    start = end = None
    for i, e in enumerate(els):
        no = _heading(e)
        if start is None:
            if no == "1.3":
                start = i + 1
            continue
        if e["kind"] == "section" or no == "1.4" or (no or "").split(".")[0] in _LATER_SECTIONS:
            end = i
            break
    if start is None:
        return None, None
    if end is None:
        raise ValueError("Section 1.3 (supplier details) has no end (no 1.4 or section 2 after it) - "
                         "cannot neutralise safely.")
    return start, end


def harvest_identity(els, lo, hi):
    """Split supplier identity into globally-scrubbed vs block-only strings.

    Only highly identifying strings (company name, e-mail, domain, phone) are
    replaced document-wide. Address and country lines are removed with the 1.3
    block but never scrubbed globally: bare place names also occur in the
    supplier's regulatory framing (e.g. "United Kingdom - Occupational Exposure
    Limits"), which must be reproduced exactly.
    """
    strong, weak = set(), set()
    name_taken = False
    for e in els[lo:hi]:
        line = (e.get("text") or "").strip()
        if not line or line.lower() in ("supplier", "manufacturer", "distributor"):
            continue

        emails = re.findall(r"[\w.+-]+@[\w-]+\.[\w.-]+", line)
        # a leading "T"/"F"/"E" marker only counts when a number/e-mail follows
        rest = re.sub(r"^\s*[TFEWM]\s*[:.]?\s+(?=[+(\d])", "", line)
        phones = re.findall(r"\+?\d[\d ()/.-]{6,}\d", rest)

        for em in emails:
            strong.add(em)
            dom = em.split("@")[-1]
            strong.add(dom)
            core = dom.split(".")[0]
            if len(core) > 3:
                strong.add(core)
        for ph in phones:
            strong.add(ph.strip())
        if phones or emails:
            strong.add(rest.strip())
            continue

        if not name_taken:
            strong.add(line)          # company / legal name
            name_taken = True
        else:
            weak.add(line)            # street, postcode, city, country
    return ({t for t in strong if len(t.strip()) > 3},
            {t for t in weak if len(t.strip()) > 3})


def tmc_block(ent):
    """Entity block lines, in SDS 1.3 order. Empty fields are dropped entirely."""
    out = ["Supplier"]
    for key in ("naam", "adres"):
        if (ent.get(key) or "").strip():
            out.append(ent[key].strip())
    tel, mail = (ent.get("telefoon") or "").strip(), (ent.get("email") or "").strip()
    if tel:
        out.append("T " + tel)
    if mail:
        out.append(mail)
    for key in ("web", "btw"):
        val = (ent.get(key) or "").strip()
        if val:
            out.append(("VAT: " + val) if key == "btw" else val)
    return out


def scrub_text(text, ident):
    for tok in sorted(ident, key=len, reverse=True):
        if tok and tok in text:
            text = text.replace(tok, "")
    text = re.sub(r"\(\s*\)|\[\s*\]", "", text)
    text = re.sub(r"\s{2,}", " ", text)
    return re.sub(r"\s*[,;/]\s*(?=[,;/]|$)", "", text).strip(" ,;/-").strip()


def neutralise(els, meta, entity, product_name=None, file_nr=None):
    lo, hi = find_supplier_block(els)
    report = {"supplier_tokens": [], "removed_lines": [], "residual": [],
              "old_emergency": "", "tmc_block": [],
              "product_name_from": "", "product_name_to": "", "trade_name_was": ""}
    if lo is None:
        raise ValueError("Section 1.3 (supplier details) not found - cannot neutralise. When the supplier "
                         "details are inside a table (seen on real MSDS), a person neutralises this MSDS.")

    ident, weak = harvest_identity(els, lo, hi)
    report["supplier_tokens"] = sorted(ident)
    report["block_only"] = sorted(weak)
    report["removed_lines"] = [e.get("text", "") for e in els[lo:hi]]

    # 1.3 -> TMC entity block
    block_lines = tmc_block(entity)
    report["tmc_block"] = block_lines
    # header rows repeat on every page a table spans, so the verifier
    # must not read the extra occurrences as added content
    def _head_rows(rows):
        """A table header is its first row, plus the row after it when the
        first is a title band - the source repeats both on every page."""
        if not rows:
            return []
        out = list(rows[0])
        filled = [c for c in rows[0] if c.strip()]
        if len(rows) > 1 and len(filled) == 1:
            out += list(rows[1])
        return out

    report["repeatable"] = [c for e in els if e["kind"] == "table"
                            for c in _head_rows(e["rows"]) if c.strip()]
    new_block = [{"kind": "para", "text": t, "page": els[lo].get("page")}
                 for t in block_lines]
    els = els[:lo] + new_block + els[hi:]

    # 1.4 -> TMC emergency number
    for i, e in enumerate(els):
        if _heading(e) == "1.4":
            # the number on the heading line itself: "1.4 Emergency telephone number: +34 ..."
            m = re.match(r"(.*?:)\s*(?=[+(\d])(.+)$", e.get("text") or "")
            if m:
                # heading and TMC number as two lines: each one traceable (the gate checks lines)
                report["old_emergency"] = m.group(2)
                e["text"] = m.group(1)
                els.insert(i + 1, {"kind": "para", "text": entity.get("nood") or TMC_EMERGENCY, "page": e.get("page")})
                break
            for j in range(i + 1, len(els)):
                # only a real next heading ends 1.4: "24 h/24 +32 ..." is the number itself (R1)
                if els[j]["kind"] == "section" or (_heading(els[j]) or "").split(".")[0] in _LATER_SECTIONS:
                    break
                if els[j]["kind"] == "kv":
                    report["old_emergency"] = els[j]["value"]
                    els[j]["value"] = entity.get("nood") or TMC_EMERGENCY
                    break
                if els[j]["kind"] == "para":
                    report["old_emergency"] = els[j]["text"]
                    els[j]["text"] = entity.get("nood") or TMC_EMERGENCY
                    break
            break

    protected = {id(e) for e in new_block}

    # global scrub of any residual supplier identity
    for e in els:
        if id(e) in protected:
            continue
        if e["kind"] == "kv":
            e["label"], e["value"] = scrub_text(e["label"], ident), scrub_text(e["value"], ident)
        elif e["kind"] in ("para", "section", "sub"):
            e["text"] = scrub_text(e["text"], ident)
        elif e["kind"] == "table":
            e["rows"] = [[scrub_text(c, ident) for c in r] for r in e["rows"]]

    # Optional trade-name override.
    #
    # This deliberately touches ONLY the document title and the "Trade name"
    # field. The chemical name, IUPAC name, synonyms, CAS/EC identifiers and
    # the composition table are regulatory identity: rewriting those would
    # falsify the SDS, so they keep the values the supplier stated.
    old = (meta.get("product_name") or "").strip()
    if product_name and product_name.strip() != old:
        product_name = product_name.strip()
        hits = 0
        for e in els:
            if e["kind"] == "kv" and _is_trade_name(e["label"]):
                report["trade_name_was"] = e["value"]
                e["value"] = product_name
                hits += 1
        meta["product_name"] = product_name
        report["product_name_from"] = old
        report["product_name_to"] = product_name
        report["trade_name_fields"] = hits

    # An image row in the value column is the value of the field on its line
    # (e.g. "Hazard pictograms (CLP) :", "Orange plates :"), so it is folded
    # into that field instead of floating above it.
    folded = []
    for idx, e in enumerate(els):
        if e["kind"] == "image" and e.get("in_value_col"):
            nxt = next((f for f in els[idx + 1:idx + 4] if f["kind"] == "kv"), None)
            if nxt is not None:
                nxt.setdefault("images", []).extend(e["images"])
                continue
        folded.append(e)
    els = folded

    # drop elements that scrubbing emptied, but never drop tables or images
    els = [e for e in els if e["kind"] in ("table", "image")
           or (e.get("text") or e.get("label") or e.get("value") or "").strip()]

    # residual check - strong tokens must be gone; weak ones are flagged only
    for e in els:
        blob = (" ".join(c for r in e["rows"] for c in r) if e["kind"] == "table"
                else " ".join(str(e.get(k, "")) for k in ("text", "label", "value")))
        for s in ident:
            if len(s) > 5 and s.lower() in blob.lower():
                report["residual"].append(("STRONG", s, blob[:90]))
        for s in weak:
            if s.lower() in blob.lower():
                report["review"] = report.get("review", [])
                report["review"].append((s, blob[:90]))

    if file_nr:
        meta["file_nr"] = file_nr
    return els, meta, report
