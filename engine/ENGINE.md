---
name: transmare-doc-neutralizer-v2
description: "Re-issues supplier documents on the Transmare Chemie (TMC) layout as .docx + .pdf: certificates of analysis (COA), safety data sheets (SDS/MSDS), technical data sheets (TDS) and specification sheets. Triggers on: \"neutralize\", \"neutraliseer\", \"rebrand\", \"COA\", \"certificate of analysis\", \"MSDS\", \"SDS\", \"TDS\", \"technical data sheet\", \"spec sheet\", \"TMC template\", \"TMC letterhead\", or a batch of supplier COAs with PFIs, order confirmations, contracts or invoices. One entry point (scripts/neutralize.py) routes each file: COA to the TMC COA template (Quality standard = spec as printed), SDS to the TMC SDS layout, TDS and spec sheets to the TMC TDS layout. Nothing invented, nothing left out (provenance gate); unsure parts are marked yellow and the PDF waits until they are checked. Entity choice (TMC NV, TMC Gulf, Pharmalabo). Handles scanned PDFs via OCR."
---

# Transmare Doc Neutralizer v2

Re-issues supplier documents on the TMC layout as a .docx + .pdf pair: certificates of analysis
(COA), safety data sheets (SDS/MSDS), technical data sheets (TDS) and specification sheets.

## v0.6.0 (15/10/2026) -- start here

- **One entry point:** `python scripts/neutralize.py FILE [FILE ...] --output-dir OUT [--entity e.json]
  [--product-name NAME] [--file-nr 840.S0850] [--batch LOT] [--type coa|sds|tds]`.
  It classifies each file by its title and calls the right route:

  | Document | Route | Output name |
  |---|---|---|
  | COA (+ PFI / OC / contract / invoice) | `neutralize_docx.py` | `<CODE>_COA_<file nr>_<product>_<batch>` |
  | SDS / MSDS | `neutralize_sds_docx.py` | `<CODE>_MSDS_<product>` |
  | TDS **and specification sheets** (Willem, 15/10: "spec sheets go the TDS way") | `neutralize_tds_docx.py` | `<CODE>_TDS_<product>` |

  `<CODE>` is the entity code: `TMC` for Transmare Chemie NV (default), `TMCGULF`, `PHARMALABO`.
  Pass `--type` when the platform job already says what the document is.
- **Exit codes:** 0 = every pair written; **2 = a draft waits for a yellow check** (docx only);
  1 = failure, nothing usable. Report a 2 as "ready to check", never as done.
- **Yellow review (Final locked):** what the source does not give or what cannot be read with
  certainty is highlighted yellow in the .docx and the PDF is held back. Typical: a COA without
  product name, lot, production or expiry date; a scanned word under 70 % OCR confidence; a
  picture/chart that cannot be copied; a footer sentence kept; the platform's `onzeker` list.
  After the check in Word (correct if needed, set highlight to none):
  `python scripts/neutralize.py --finalise OUT/<name>.docx` -> renders the PDF, refuses while any
  yellow is left. Never remove a yellow mark on the user's behalf.
- **Entity choice for every type:** `--entity` takes the platform's entity record (collection
  `entiteiten`: naam, adres, telefoon, email, web, btw, nood, code). Default
  `entity.example.json` = Transmare Chemie NV. For another entity the TMC address bar and the TMC
  approval stamp leave the footer and the entity's own block is printed instead. Never make up an
  entity's address: if the record does not exist, ask for it.
- **Reading rules:** when Claude reads a supplier document itself (scan, unknown layout, check),
  follow `references/reading_rules.md` -- the platform's rules 1-9 for COA, SDS and TDS plus the
  coordinator's house rules, copied word for word.
- **Platform JSON:** `neutralize_tds_docx.py SOURCE.pdf --from-json reading.json` builds the TDS from
  the platform's own reading (`kop`, `secties` with `tekst_html`, `leverancier`, `onzeker`), so the
  platform and the skill produce the same sheet. The source PDF stays required for the gate.
- **House rules applied by the scripts:** a spaced hyphen in a number range, CAS/EC/UN number or
  hyphenated name is closed up (`4.0 - 10.0 %` -> `4.0-10.0 %`; `Nº 04 - 14/10/2026` stays);
  label and value on one line; COA built from its two tables only.

### TDS / specification route

- Title `Technical Data Sheet – <name>` (name from `--product-name`, else the original's own).
- Every block in the printed order, exact words, one column, close together; tables stay tables;
  label/value pairs stay pairs. No heading, label or line is added.
- Out: letterhead and logo, footer address, page numbers, signatures, supplier article/document
  code (e.g. `CODE pl008201`). A sentence naming the supplier keeps the sentence with the entity
  name in its place. The supplier's address, telephone, e-mail and website are REMOVED without
  replacement -- never put the entity's contact details in a TDS (platform rule); a sentence that
  loses one is marked yellow so it is read once. Everything removed is listed in the log
  ("not copied").
- Layout: the TMC COA template's letterhead, footer address bar and stamp; title 18 pt bold
  centred; headings bold, body 10 pt; no details or results table.
- Platform jobs: a job Willem approved (Final) carries `inhoud` -> write it to a file and run
  `neutralize_tds_docx.py SOURCE.pdf --from-json inhoud.json --approved` (his own words pass the
  gate, `onzeker` entries with `"ok": true` are not marked). Without `--approved` the reading is
  treated as a draft and any text not in the source is refused.
- The run aborts when a supplier string survives, and the provenance gate deletes the output when
  any string cannot be traced to the source or a supplied value.
- Official copies go to `Document Neutralizer\TDS` on Willem's laptop.

## COA route

**Scanned PDFs are handled automatically** -- no manual pre-processing required.
The script detects image-based PDFs and applies OCR before extraction.

> **v2.1 fix** — Test result rows now populate reliably for ALL supplier COA formats.
> The parser previously only recognised tables whose header contained the exact phrase
> "TEST PARAMETER". It now detects any column layout in any language (EN/NL/FR/DE)
> and falls back to text-based extraction when pdfplumber finds no structured tables.

## Key rules (read these first)

1. **Product name always comes from the commercial document** (PFI, OC, Contract, Invoice).
   Never use the product name on the supplier's own COA as the title -- the commercial doc
   has the "TMC-agreed" name.

2. **Only fill data that is actually in the supplier COA.** Do not invent or estimate values.
   If a field has no data, leave it blank.

3. **Specification -> Limit min / Limit max interpretation:**
   | Spec format | Limit min | Limit max |
   |---|---|---|
   | `36 - 39` or `36 - 39` (range) | 36 | 39 |
   | `29 Min.` or `>= 29` | 29 | *(blank)* |
   | `6.5 Max.` or `<= 6.5` | *(blank)* | 6.5 |
   | Qualitative: `Liquid`, `No odour`, `Pale yellow`, `Viscous liquid` | *(blank)* | *(blank)* |
   | `Nil` | *(blank)* | *(blank)* |

4. **Quality standard carries the specification exactly as the supplier printed it** (Willem,
   16/09/2026): `NMT 1.5`, `99.0-100.5`, `White powder`, `By IR`. Never shortened, never left out.
   Limit min / max hold numbers only. **Method** is filled only when the COA has its own method
   column for that line.

5. **Add as many test rows as needed.** The template has 3 blank rows; extend the table
   automatically for any additional parameters.

6. **All output text is explicit black.** The script forces every filled cell to
   `w:color = 000000` so text is never invisible regardless of template styling.

## How to run

### Step 1: Install dependencies (first run only)
```bash
pip install pdfplumber python-docx ocrmypdf pypdf --break-system-packages
```

For the pytesseract fallback (optional, used only if ocrmypdf is unavailable):
```bash
pip install pytesseract pdf2image --break-system-packages
```

### Step 2: Run the script
```bash
python scripts/neutralize_docx.py <file1> [<file2> ...] [--output-dir <dir>]
```

Pass ALL files in the batch -- COAs AND the commercial reference document together.
The script classifies each file automatically.

**Examples:**
```bash
# One COA + PFI
python scripts/neutralize_docx.py coa.pdf pfi.pdf --output-dir /mnt/outputs

# Scanned COA (OCR applied automatically)
python scripts/neutralize_docx.py scanned_coa.pdf pfi.pdf --output-dir /mnt/outputs

# Multiple COAs + one Contract de Vente
python scripts/neutralize_docx.py coa1.pdf coa2.pdf contrat.pdf --output-dir /mnt/outputs
```

### Step 3: Outputs

**Every certificate is delivered as a PAIR: `<stem>.docx` AND `<stem>.pdf`, same base name.**

- The `.docx` built from `assets/TMC_COA_template.docx` is the editable master.
- The `.pdf` is produced by the script from that exact `.docx` via
  `soffice --headless --convert-to pdf`, so the two can never say different things.
  This keeps the TMC letterhead, footer logo and stamp images.
- Never build the PDF by any other route (no re-rendering, no separate PDF writer).

The script verifies the pair on disk after conversion. If the PDF is missing, empty or
LibreOffice is not installed, it prints `FAIL` and **exits with code 1**. A `.docx`
without its `.pdf` twin is an incomplete run -- do not deliver it. Fix by installing
LibreOffice (`soffice` must be in PATH) and re-running. The one exception is exit code 2:
a yellow-marked draft, delivered as .docx "to check", PDF after `--finalise`.

Reference documents produce no output file.

## OCR behaviour

The script automatically detects scanned / image-based PDFs by checking whether the
extracted text is too sparse (fewer than 80 characters). When a scan is detected:

1. **ocrmypdf** (preferred) -- converts the scan to a searchable PDF, then extracts text
   and tables normally. Flags used: `--skip-text --rotate-pages --deskew --optimize 0`
   for maximum speed.
2. **pdf2image + pytesseract** (fallback) -- used only when `ocrmypdf` is not installed.
   Extracts text only (no table coordinates).

The original file is never modified; OCR output goes to a temporary file that is deleted
after extraction.

## Template structure

The TMC template (`assets/TMC_COA_template.docx`) contains:

- **Header image**: company logo banner (preserved from template -- never modify)
- **Title line**: "Certificate of Analysis - PRODUCTNAME" -> replace PRODUCTNAME with
  the product name from the commercial document
- **Section: Analysis details** (Table 0, 2 columns):
  | Row | Field | Source |
  |---|---|---|
  | 0 | Lot / batch nr | Supplier COA batch/lot number |
  | 1 | Production date (template typo "data" corrected in the output) | Supplier COA manufacture/production date |
  | 2 | Expiry date | Supplier COA expiry/retest date |
  | 3 | TMC file nr | Commercial document reference number (PFI/OC/Invoice nr) |

- **Section: Parameter test results** (Table 1, 7 columns):
  Characteristics / Limit min / Limit max / Result / Unit / Method / Quality standard

- **Footer images**: Transmare logo + stamp (preserved from template -- never modify)

## Field mapping

| TMC COA field | Source |
|---|---|
| PRODUCTNAME (title) | Commercial doc: best-matching product line item name |
| Lot / batch nr | Supplier COA: batch number / lot number |
| Production date | Supplier COA: production/manufacturing date |
| Expiry date | Supplier COA: expiry / retest date |
| TMC file nr | Commercial doc: document reference number |
| Characteristics | Supplier COA: test parameter name |
| Limit min | Parsed from supplier COA specification (see rules above) |
| Limit max | Parsed from supplier COA specification (see rules above) |
| Result | Supplier COA: result value |
| Unit | Supplier COA: UOM (treat "-" or em-dash as blank) |
| Method | Supplier COA: method name if stated, otherwise blank |
| Quality standard | Supplier COA: the specification exactly as printed |

## Spec format support (extended in v2.1)

| Spec format | Limit min | Limit max |
|---|---|---|
| `36 - 39` / `36~39` / `36 to 39` (range) | 36 | 39 |
| `29 Min.` / `Min. 29` / `>= 29` / `NLT 29` | 29 | *(blank)* |
| `6.5 Max.` / `Max. 6.5` / `<= 6.5` / `NMT 6.5` | *(blank)* | 6.5 |
| `99.5 % Min.` (unit embedded in spec) | 99.5 | *(blank)* |
| Qualitative: `Liquid`, `No odour`, `Pale yellow`, `Viscous liquid` | *(blank)* | *(blank)* |
| `Nil` | *(blank)* | *(blank)* |

## The platform is the authority -- never guess

Product name, TMC file number and lot/batch normally come from the platform job
(`product_naam`, `dossier_nummer`). Pass them explicitly:

```bash
python scripts/neutralize_docx.py coa.pdf --output-dir out \
    --product-name "Sodium Lauryl Sulphate" --file-nr "26-1234" --batch "C664124"
```

These overrule anything in the documents and appear everywhere the document
names them. When a value is NOT supplied and is not in a commercial document,
**the field is left blank** for the user to complete at review. It is never
inferred from the supplier certificate's own wording.

That rule exists because of a real failure: the old heuristic took the first
plausible-looking line of the supplier COA as the product name, and printed
`Certificate of Analysis - Sumitomo Seika Europe S.A. / N.V.` -- the supplier's
own company name, in the title and in the file name, on a document whose whole
purpose is to remove it. A blank is always safer than a guess.

A lot/batch value that is really a form label ("Production data", "no.") is
rejected and left blank. When nothing identifying is available at all, the
output falls back to `TMC_COA_<source file name>` so two drafts can never
collide in the COA folder.

## Failure is loud

The script exits non-zero and writes nothing when no certificate of analysis can
be detected, and lists how each input was classified. It never exits 0 having
produced no file. A `.docx` without its `.pdf` twin is likewise a failure.

## Regression gate

```bash
python3 tests/run_corpus.py <folder-of-supplier-COAs>
```

Runs a whole folder (read-only) and fails if any output pair is broken, any two
outputs share a name, or any supplier company name reaches the output text,
title or PDF metadata. Run it before shipping a change to the parser.

## Output file naming (fixed house convention -- do not drift)

| Document | Name |
|---|---|
| Certificate of analysis | `TMC_COA_<TMC file nr>_<product name>_<batch>` |
| Technical data sheet / specification | `TMC_TDS_<product name>` |
| Safety data sheet | `TMC_MSDS_PRODUCTNAME` |

FILECODE is the TMC file number from the commercial document (PFI / OC / contract /
invoice) -- the same value printed in the "TMC file nr" box. A part that is not present
in the input is left out of the name; it is never invented to complete the pattern.
Never overwrite an existing output -- report it and leave both files alone.

## Unreadable supplier PDFs

Some supplier PDFs (seen with KG / Ligamed certificates) are valid files that pdfminer
refuses with `No /Root object!` because `startxref` sits on the same line as its offset.
The script detects this, rewrites the file to a clean temporary PDF with pypdf and parses
that. The supplier's original file is never modified and the temp file is deleted on exit.
Requires `pypdf`; install it with the other dependencies.

## Troubleshooting

| Problem | Fix |
|---|---|
| Test results table still empty | Check the console output for the detected row count. If 0, the COA may be a scanned image — install ocrmypdf: `pip install ocrmypdf --break-system-packages` |
| "PRODUCTNAME" still in output | No commercial reference doc found; pass a PFI / OC / Contract in the same batch |
| Text appears white in Word | Update the plugin — v2 forces explicit black (000000) on all cells |
| Missing dependency | `pip install pdfplumber python-docx ocrmypdf pypdf --break-system-packages` |
| OCR very slow | Ensure ocrmypdf is installed (faster than pytesseract fallback) |
