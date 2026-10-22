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
    # also "1 .3" with a space before the dot (22/10/2026, real MSDS)
    m = re.match(r"\s*(?:section|rubrique|abschnitt|rubriek)?\s*(\d{1,2}(?:\s?\.\s?\d{1,2})*)\.?(?=\s|:|$)",
                 text or "", re.I)
    return re.sub(r"\s", "", m.group(1)) if m else None


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
        # a "Company name : X" row is a kv; a plain line may start with its label: only the
        # value is the identity, so "X" is also found in the disclaimer (22/10/2026, real MSDS)
        raw = ((e.get("value") if e["kind"] == "kv" else e.get("text")) or "").strip()
        line = _ID_LABEL.sub("", raw).strip()
        # a line that is only a label ("Company name:") is no name (review L1)
        if not line or line.lower() in ("supplier", "manufacturer", "distributor") or _ONLY_LABEL.fullmatch(raw):
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
            if raw != line:
                strong.add(raw)       # also as written: "Name Chemicals Ltd" (review L1)
            name_taken = True
        else:
            weak.add(line)            # street, postcode, city, country
    return ({t for t in strong if len(t.strip()) > 3},
            {t for t in weak if len(t.strip()) > 3})


_ID_LABEL = re.compile(
    r"^(?:company(?:\s+name)?|supplier|manufacturer|distributor|name|firma|soci[ée]t[ée]|fournisseur|fabricant"
    r"|hersteller|lieferant|raison\s+sociale|address|adresse|anschrift)\s*[:.]?\s+(?=\S)", re.I)


_ONLY_LABEL = re.compile(
    r"\s*(?:company(?:\s+name)?|supplier|manufacturer|distributor|name|firma|soci[ée]t[ée]|fournisseur|fabricant"
    r"|hersteller|lieferant|raison\s+sociale|address|adresse|anschrift)\s*[:.]?\s*", re.I)


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

    # A table inside 1.3: its supplier name, phone and e-mail could not be harvested for the
    # scrub of the rest of the document, so refused for a person (security review F4).
    if any(e["kind"] == "table" for e in els[lo:hi]):
        raise ValueError("Section 1.3 (supplier details) is a table - a person neutralises this MSDS.")
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

    # 1.4 -> TMC emergency number, and only that: the supplier's other emergency numbers (its own
    # service contracts, "Other Emergency Numbers: NCEC ...") go too, as colleagues do on the TMC
    # MSDS (22/10/2026, real MSDS). Heading and TMC number stay separate lines: each is traceable.
    tmc_no = entity.get("nood") or TMC_EMERGENCY

    def line_of(b):
        return b.get("text") or f"{b.get('label', '')} : {b.get('value', '')}"

    def is_contact(text):
        """A supplier phone number (6+ digits) or e-mail: identity, removed (review M2)."""
        return len(re.findall(r"\d", text)) >= 6 or bool(re.search(r"[\w.+-]+@[\w-]+\.[\w.-]+", text))

    # 1.4 is looked for only between 1.3 and the section 2 heading (review M1)
    sec2 = next((k for k in range(lo, len(els)) if (_heading(els[k]) or "").split(".")[0] in _LATER_SECTIONS), len(els))
    for i in range(lo, sec2):
        e = els[i]
        if _heading(e) != "1.4":
            continue
        page = e.get("page")
        # the number on the heading line itself: "1.4 Emergency telephone number: +34 ..."
        m = re.match(r"(.*?:)\s*(?=[+(\d])(.+)$", (e.get("text") or "")[:300])
        # only a telephone number (6+ digits), never "(see section 16)" (review F5)
        on_heading = bool(m and len(re.findall(r"\d", m.group(2))) >= 6)
        if on_heading:
            report["old_emergency"] = m.group(2)
            e["text"] = m.group(1)
        end = sec2
        lines = [b for b in els[i + 1:end] if b["kind"] in ("kv", "para", "sub")]
        # Phone numbers in 1.4 are removed inside 1.4 only, its tables included (review M3): a
        # national poison-centre number in section 4 is no supplier identity. E-mail addresses
        # are the supplier's and are scrubbed everywhere.
        local = set()
        for b in els[i + 1:end]:
            texts = [line_of(b)] if b["kind"] != "table" else [c for r in b.get("rows", []) for c in r if c]
            for t in texts:
                for tok in re.findall(r"\+?\d[\d ()/.-]{6,}\d|[\w.+-]+@[\w-]+\.[\w.-]+", t):
                    local.add(tok.strip())
                    if "@" in tok:
                        ident.add(tok.strip())
        for b in els[i + 1:end]:
            if b["kind"] == "table":
                b["rows"] = [[scrub_text(c, local) for c in r] for r in b["rows"]]
        if len(lines) > 8:
            # far longer than an emergency block: never cleared on a guess, a person checks it
            for b in lines:
                b["yellow"] = True
            report.setdefault("review", []).append(("1.4", "long emergency block kept for a person to check"))
            els = els[:i + 1] + [{"kind": "para", "text": tmc_no, "page": page}] + els[i + 1:]
            break
        # Only the supplier's numbers and e-mails go (their own emergency contracts, as colleagues
        # do on the TMC MSDS); any other line ("available outside office hours") stays (review M2).
        new, first_done = [], on_heading
        for b in els[i + 1:end]:
            if b["kind"] in ("kv", "para", "sub") and is_contact(line_of(b)):
                report["removed_lines"].append(line_of(b))
                if not first_done:
                    report["old_emergency"] = line_of(b)
                    if b["kind"] == "kv":
                        new.append(dict(b, value=tmc_no))
                    else:
                        lm = re.match(r"([^:]{3,60}:)", b["text"][:300])     # its label, whatever follows
                        if lm:
                            new.append({"kind": "para", "text": lm.group(1).strip(), "page": page})
                        new.append({"kind": "para", "text": tmc_no, "page": page})
                    first_done = True
                continue
            new.append(b)
        if on_heading or not first_done:
            new.insert(0, {"kind": "para", "text": tmc_no, "page": page})
        els = els[:i + 1] + new + els[end:]
        break
    report["supplier_tokens"] = sorted(ident)

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
