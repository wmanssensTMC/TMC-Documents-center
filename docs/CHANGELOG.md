# Changelog

## 22/10/2026 · Simpler menu (branch `phase-2h-menu`)
- Five tabs in the order of the work (Willem 22/10): Neutralise, To check (with the number of drafts waiting), Labels, Library, Settings (admins).
- Jobs is folded into Neutralise: the last 15 jobs show under the form, updating themselves while running; "All jobs" keeps the full list.
- Upload is a button in the Library: "Add an existing TMC document".

## 22/10/2026 · Own on-screen editor replaces SuperDoc (branch `phase-2e-own-editor`, not merged; security gate PASS 92/100)
- Licence question closed: the check-screen editor is our own. SuperDoc is removed; no new outside library (Willem 20/10).
- The worker makes an editor view of every new draft (`yellow.py view`, stored with the draft, migration 0010). The person changes any text (body, tables, text boxes, headers, footers), sets bold, italic or underline, removes yellow and adds line breaks; "Next yellow part" jumps to each yellow part.
- Only the changed text goes back; the worker writes it into the engine's own Word file (`yellow.py edit`), so tables, pictures and the TMC layout cannot break. A piece that no longer reads what was shown is refused. All Final checks run as before (no supplier name, no yellow, file-name values printed, warnings for words not in the supplier original, feedback overview).
- Not on screen: new paragraphs or table rows, moving tables or pictures, font, size or colour. The DRAFT PDF stays for the exact look. Drafts made before this change: run the supplier document again.
- Security review fixes (first score 82): the editor view, like the DRAFT preview, is only served while the draft waits for a check (H1); browser, server and worker refuse the same invisible characters that could split a supplier name (M1, L4); tighter browser connection rule (L2); sizes from the view checked (L3). Open, Low: look-alike letters from other alphabets (L1, existed before).
- Tests: `web/worker/test_yellow.py` (view and edit), `web/components/doc-editor-model.test.ts`, edited mode in `check.test.ts` and `worker.test.ts`. Tried in the browser on a sample draft (test data).

## 20/10/2026 · Phase 3 started early: label frame with a SAMPLE template (branch `phase-3-labels`, merged 21/10; security 83/100, fixes applied)
- New label screen: choose a template, language (EN/FR) and entity, fill in the form (or start from a Final COA: product, dossier, batch and the dates it holds), send. The worker makes Word + PDF with the engine (`engine/scripts/make_label.py`); nothing heavy runs on Vercel.
- Labels are LABEL documents in the library: To check, approved like other documents, versions and Superseded, audit trail. A label is approved as it was made (no Word round trip); dossier and batch are locked at approval.
- File name (BRIEF 7.5, Willem 20/10): `<CODE>_LABEL_<file nr>_<product>_<batch>_<pack size>_<LANG>`, pack size = the printed net weight (e.g. `_25kg_`). A label keeps the name it was made with; product, dossier and batch are locked at approval.
- Fixed label texts from `engine/assets/label_texts.json`, copied from Kars' TMC Label Creator (official CLP EN/FR wording). A language or text that is not in it stops the run: Arabic follows when its texts are supplied.
- `engine/assets/TMC_LABEL_SAMPLE.docx` (A4 landscape, one label per sheet) is marked SAMPLE on the label itself; a label made with it can never become Final (checked where every document becomes Final; the flag is kept on the job).
- Provenance gate runs on every label; an empty value leaves its row out; dates dd/mm/yyyy; French decimal comma.
- Worker: job kind `label`, explicit dispatch per job kind (deploy the worker before the web app). Migration 0009: job kind `label`, column `jobs.label`.
- BRIEF 7.3: labels may show a supplier name only when the person types it in (the sample has no such field).
- Tests: `engine/tests/test_labels.py` (+ GitHub step), `web/lib/labels/labels.test.ts`, LABEL naming, worker end to end with the real engine.
- Open: questions for Kars (fields and sources, printer and label stock, Arabic texts: Kars' Label Creator has none, so they must come from his real example labels; the worker image then also needs an Arabic font).

## 20/10/2026 · MSDS round 1 on the real MSDS (branch `phase-2g-msds`, laptop only; security gate PASS 90/100)
- Reading: letters printed twice to fake bold are read once (also TDS: "OORRGGAALL" -> "ORGAL"); a letter in another font or a point lower stays in its word ("l'écart"); page-number lines ("2 / 21") are not glued into paragraphs; a box drawn around a whole section is a frame, not a table; "SECTION n:" lines are section headings also when not bold.
- Section 1.3 / 1.4: found however written; the supplier's emergency number on the 1.4 heading line itself is replaced by TMC's.
- "Technical sheet" goes to the TDS route.
- Measured on the real MSDS: one supplier's 7 MSDS went from 0 to 7 made, each 98% the same text as the TMC version colleagues made, supplier fully removed. Still open: section 1 inside a table (2 suppliers), two-column French layout (gate refuses, safe), a 426-page extended MSDS (too slow), one MSDS refused for leftover supplier identity (correct).
- Tests: `engine/tests/test_sds_reading.py` (synthetic copies of each case).

## 20/10/2026 · Engine: first run on the real dossiers (branch `phase-2f-corpus`, laptop only; security gate PASS 90/100)
- 8 real dossiers run on the laptop and compared with the TMC versions colleagues made (no real document in git, GitHub or Vercel). New tool: `engine/tests/compare_real_corpus.py`.
- Fixed: the provenance gate crashed on product lists of real order confirmations; a purchase order that mentions "certificate of analysis" became a COA; unrecognised files (scans without OCR) were left out silently (now "NOT PROCESSED", the run asks for a person).
- TMC file nr: the sales file number (840.S0938) always wins; on a purchase order the PO number (PO019423) (Willem 20/10).
- Reading: decimal commas (1,018 / 98,0), ">/=", "</=", "÷"; columns are cut between words, never through one; disclaimer text under the table ends it; "Lot/ Batchnumber"; date format labels and run-on fields removed from dates; separate MIN/MAX columns fill Limit min/max without a made-up Quality standard text.
- Result on the dossiers: no document stopped by the gate any more (was 3); purchase dossiers get their PO number and lots.
- Test: `engine/tests/test_real_corpus_rules.py` (synthetic copies of each case).
- Second round: header words only as whole words, longest wins ("Free Amine" is no "min" column, "Test results" is a result); a row with numbers is never a header; a header shifted by merged cells; an unnamed result column; a "Pesticide" first column; "Nil"/"None" kept as values; date lines kept out of the results; purchase-order items with item code and trade name line ("Lactose Monohydrate Pharmatose 200M"), tariff/ADR lines never part of a name; two order lines that fit a COA equally well give no product name (yellow, never a guess); the same batch in two files gives one document (identical) or is held back (different); "SLED" = expiry date; the analysis date is not taken as production date. The dispatcher uses the same list of COA titles as the COA route ("Quality certificate", "Product analysis report") and knows purchase orders.
- Measured on the dossiers: Cocamide DEA 55% -> 95% of the values, Lanolin 51% -> 87%; no document stopped by the gate. Open: scans need Tesseract (IT); the MSDS route fails on most real MSDS (section 1.3 not found), next step.

## 20/10/2026 · On-screen document editor (branch `phase-2e-editor`, not merged; security gate PASS 90/100)
- Check screen, "Edit the document": the draft opens as the real Word document in the browser, supplier original on the left. Any text and formatting can be changed (Willem 19/10, option A).
- Save and finalise: the worker runs every Final check on the edited file (no macros or outside links, no supplier name, file-name values printed, no yellow left). Changes that bring in words or numbers not found in the supplier original come back as warnings; the person ticks "I checked these changes" and goes on. Every change is kept in the feedback overview ("Edited on screen") and CSV.
- The last edit that did not become Final can be reopened, so no work is lost.
- Editor: SuperDoc 2.24.0 (npm), runs in the browser only, its usage reporting switched off. Licence: AGPL-3.0 (free) or a paid commercial licence: decision for Willem before go-live (see BRIEF 11).
- The quick yellow-parts list and "check in Word yourself" stay as alternatives.
- Security review fixes (first score 80): yellow shading counts as yellow too, and the editor was shown to keep the yellow highlight when it saves (F1); link addresses are read for the supplier name and a picture added in the editor is a warning (F2); in production the browser may only connect to this app and the file store (F4); a confirmation only counts for the saved version whose warnings were shown (F5); size cap on the comparison (F6); footnotes, endnotes and comments are compared too (F7). A document over 20000 paragraphs gets a warning that only the first part was compared. Open for Willem: F3 (see BRIEF 11).


## 19/10/2026 · COA batches, file-name rule, MSDS pictograms (security gate PASS 92/100)
- Engine: a COA with batches side by side (one result column per batch) gives one document per batch, each with its own values and dates. The same lot twice: kept once when only the quantity differs (noted in the log), held back for a person when an analysis result differs. Scan values the two readings do not agree on are marked yellow, never chosen. "Page 1 of 3" in a shorter file is refused as incomplete.
- A typed batch on a COA with several batches is refused (Neutralise screen: leave Batch empty).
- Check screen: the file name follows the details by the naming rule and is shown live; each value in it must be printed in the document (the worker checks, also on Approve); the batch is locked.
- Jobs screen: the engine log is also shown for jobs waiting for a check (held-back batches are visible).
- PyMuPDF added to the engine requirements: the MSDS route needs it to carry hazard pictograms over.
- Security review fixes (first score 80): a new name that lands on another document's Final needs a "Replace it" tick, checked again when it becomes Final (M1); printed-values check matches whole words only and refuses values it cannot check (M2); Approve re-checks the Word file for yellow in the worker (L1); each batch is checked against its own column readings only (L2); unreadable or missing batch details stop the job instead of dropping the batch lock (L3/R1); the replace confirmation names the exact Final shown to the person (R2); a product name needs 3 characters or more to count as printed (R3). Re-review: 92/100, open by design: supplier name optional (L4).
- Tests: `engine/tests/test_coa_batches_route.py`, `engine/tests/test_sds_pictograms.py` (pictograms kept with their field at the printed size, supplier logo dropped), printed-values check in `web/worker/test_yellow.py`, approve/rename in the web tests.


## 19/10/2026 · Phase 2 final security gate: PASS 92/100
- Fixes after the gate: engine yellow check also sees runs inside hyperlinks, fields and tracked inserts (N4, test extended); uploaded Word files with tracked changes are refused and text in deleted parts and charts is read for the supplier name (N1); the worker always lists yellow parts, a draft with any yellow keeps no PDF (N5); finalise requests count toward the 40 open jobs per person (N6).
- Open, decision for Willem: supplier name required on neutralise jobs (N2); what happens when product/dossier/batch change at the check while they are in the file name (N3).
- Before real data: restricted DB role (S2), engine under its own user and worker without internet (W2), pinned versions (N7).


## 19/10/2026 · Drag and drop (BRIEF screen 3)
- Neutralise and Upload: drop zones (drag files in, or click to choose). Wrong file types are skipped with a note.


## 19/10/2026 · Hardening before real data (reviews N1/N2)
- Word-file check reads the file's real structure, before python-docx or LibreOffice see it: relationships parsed as XML (any outside link refused except normal web links), fields that include outside content (INCLUDEPICTURE, INCLUDETEXT, LINK, DDE, IMPORT) refused, real unpacked bytes counted (max 100 MB).
- Supplier-name check now also reads footnotes, endnotes, comments, text boxes and document properties (author, title), using the engine's own normalisation (accents and punctuation ignored, also written together).


## 19/10/2026 · Engine: yellow check reads the whole document (Willem: review L2)
- `engine/scripts/tmc_common.py`: new `iter_highlighted()` finds yellow marks in body text, tables, tables inside tables, text boxes, and the headers and footers of every section (first page, even pages). A text box is stored twice by Word; only the shown version counts. `yellow_runs()` (used by --finalise) and the check screen's helper both use it, so they can never disagree.
- Test: `engine/tests/test_yellow_coverage.py` (a mark left only in a header still blocks Final).


## 19/10/2026 · Phase 2d: feedback overview (branch `phase-2-neutralise`)
- Settings > Feedback (admin only): numbers per period (drafts made, Final via neutralizer = KPI K8, rejected, failed runs, corrected vs confirmed yellow parts), most frequent corrections (same misreading grouped), all corrections (engine read -> person made it), rejected drafts with reason, failed runs with log.
- CSV download for Excel (UTF-8, semicolons; cells starting with = + - @ neutralised against formula injection). Export is logged in the audit trail.
- Read-only: nothing here changes a document.


## 19/10/2026 · Phase 2c: check screen (branch `phase-2-neutralise`)
- Worker: for each yellow draft it lists the yellow parts (web/worker/yellow.py, reusing the engine's own yellow_runs walk) and makes a preview PDF stamped "DRAFT - NOT FOR USE" (view only, never a download).
- Check screen (/documents/[id]/check): supplier original left, draft preview right; every yellow part with an edit box and "OK as is"; library details (product, dossier, batch) confirmed by the person. Finalise only when every part is confirmed; the worker writes the fixes in, removes yellow only there, and runs the engine's own --finalise (refuses while anything is yellow). Alternative: upload a checked Word file. Approve for drafts without yellow. Reject with a reason.
- Final = one transaction: supersedes the previous Final of the same name, next version number, approver = the person who checked; neutralise job "done" when no draft is left to check.
- Feedback table: every correction, confirmation, Word upload and rejection (for the overview in 2d).
- Menu: "To check" (library filtered on drafts).
- Security review 2c (85/100) fixes: "OK as is" never changes the text (no trimming; parts over 500 characters go via Word); every part needs its own confirmation on the server; uploaded Word files are refused with outside links, macros, embedded objects or when they unpack too large; before Final the worker refuses a document that names the supplier (body, tables, headers, footers); one open finalise per document (database); stricter names, invisible characters refused, DRAFT preview cleared at Final/Reject. Re-score 92/100. Name rule matches the engine's own (brackets, commas, %, & allowed; no path characters). Before real data: stricter Word-file parsing and wider supplier-name scan (N1/N2), worker without internet + engine under its own user (W2), restricted DB role (S2). Open for Willem: the engine's yellow check does not look in headers/footers/nested tables (L2, engine change).


## 17/10/2026 · Phase 2b: worker (branch `phase-2-neutralise`)
- Worker (`web/worker/`): Node program that runs the engine unchanged. Woken by the app (POST /wake with a secret), checks every 30 min as a safety net, one job at a time, 10-minute limit, crashed runs retried up to 3 times.
- Engine called with an argument list (no shell), values as --option=value, safe local file names, no secrets in the engine's environment, log capped at 8 000 characters and stripped of server paths (review N2/N3).
- Output: every engine document becomes a "To check" draft (Word; PDF only if nothing is yellow), with its own copy of the supplier original. Engine failure (exit 1) stores nothing. Product, dossier and batch come only from typed values; empty ones are confirmed at the check.
- Worker review (85/100) fixes: a timeout stops the whole engine process group (LibreOffice/OCR too) and tini cleans up; code in the image is read-only for the worker; all worker messages cleaned of server paths; a job can only be closed by the run that holds it; typed values cannot start with "-"; downloads stop above 25 MB. Before real data: engine under its own user (W2) together with the restricted DB role (S2).
- Docker image (`web/worker/Dockerfile`: Node 24, Python 3.11, LibreOffice, Tesseract, Ghostscript, poppler) and `railway.json`. GitHub checks run the worker against the real engine and build the image.


## 17/10/2026 · Phase 2a: jobs and Neutralise screen (branch `phase-2-neutralise`)
- Decisions 17/10: worker on Railway (Docker); engine output always needs a person; anyone may finalise; on-screen yellow-part editor, then Word + PDF; status Rejected; COA/MSDS/TDS from the start; wake-up call instead of office hours; Entities admin screen. Labels: waiting for Kars' files.
- Database: `jobs` table (queued/running/to_check/done/failed), `entities` table (TMC NV seeded from engine/entity.example.json; others entered by admin), status Rejected, drafts without PDF or version; only one *Final* per name, so a draft can sit next to the Final it will replace.
- Neutralise screen: several supplier PDFs at once, one row each (product, dossier, batch), "use first row for all", commercial documents for COAs; one job per supplier document, all-or-nothing.
- Security review 2a (88/100) fixes: max 40 open jobs per person; database refuses a Final document without PDF/version; wake-up call https-only, no redirects; entity changes logged with old and new values. Worker rules for 2b (N2/N3): engine called with an argument list (no shell), temp file names from storage keys, log capped and stripped of paths.
- Jobs screen (refreshes itself while jobs run, shows engine log on failure); Entities settings screen; worker wake-up call (WORKER_WAKE_URL / WORKER_WAKE_SECRET, best effort).


## 17/10/2026 · Phase 1: Library (branch `phase-1-library`)
- Database (Drizzle): documents, users, audit log. Neon online, PGlite (built-in Postgres) on laptop and in tests. Migrations run before `next build`.
- Never overwrite: same file name = new version, old one Superseded; the database itself allows only one current version per name.
- Audit log is append-only (database trigger refuses update/delete/truncate). Logged: added, superseded, viewed, downloaded, user changes.
- File names: 1:1 port of the engine (COA/MSDS/TDS/spec); shared test cases `engine/tests/naming_cases.json` checked by both web and engine tests.
- Storage: Vercel Blob with **private** files, browser uploads straight to storage (no 4.5 MB limit); laptop uses `.data/files`. Files checked on type, size (25 MB) and real content.
- Screens: Library (search + column filters, newest first, current versions), Document (supplier original left, TMC right, downloads, versions, history), Upload (live file-name preview), Settings/Users (admin), Change password.
- Users and roles in the database; env admin stays as bootstrap account. New users must change their temporary password. Role changes and blocking apply immediately.
- Types LABEL and OTHER cannot be uploaded yet: no naming rule agreed (ask Willem).
- Security review 88/100, fixes: each uploaded file belongs to one document (unique index), downloads get a sandbox CSP, audit-log comment states the owner-role limit. Open before real data: restricted DB role for the app (S2).
- Vercel: private Blob store `tmc-documents` and Neon database `tmc-document-center`, both Frankfurt, free plans; Preview deployments get their own database branch.


## 16/10/2026 · Phase 0 (branch `phase-0-setup`)
- Next.js 16 app in `web/` (TypeScript, Tailwind, TMC navy, TMC logo, phone-friendly).
- Password login behind `web/lib/auth`: signed cookie (12 h), scrypt password hash, one admin from env vars. Every page goes to /login without a valid session.
- `npm run hash-password` makes the value for `ADMIN_PASSWORD_HASH`.
- Engine: `requirements.txt` added; SDS test reads `entity.example.json` instead of a missing `entity_db.json`.
- Decisions of 16/10 recorded in `docs/BRIEF.md` section 11 (incl. supplier name visible in app, feedback overview for phase 2).
- Agents: Willem's Architect/Developer/Security/Refactor/Testing/Master set added (`.github/agents`, `.claude/agents`).
- GitHub check (`.github/workflows/checks.yml`): engine tests and web build on every push, no local Python needed.
- Security review (75/100) fixes: role claim validated and unknown roles fail closed; scrypt cost N=2^17 stored in the hash; same timing for unknown e-mail; input length caps; failed-login log line; security headers (no framing, nosniff, referrer, HSTS); hash script hides the password; GitHub check token read-only. Built-in login brake: max 2 checks at once, 5 failures per IP+e-mail lock 15 min. Still to add at deploy: Vercel Firewall rate-limit rule on POST /login.
- Security gate passed: 90/100 (Security agent, 16/10). Open: Vercel Firewall rule on POST /login (raises to 100).
