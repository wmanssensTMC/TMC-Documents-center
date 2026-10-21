# TMC Document Center: project brief

Version 0.2 · 16/10/2026 · Owner: Willem Manssens (AI lead) · Business partner: Kars Groen
Roadmap item: AI.S002 (track B). First in-house AI project after the external vendors (Ennovative, Tradewind/SDSExtract) were put on hold on 16/10/2026.

## 1. Why

Today supplier documents (COA, MSDS/SDS, TDS, spec sheets, labels) are rebranded one by one and stored in personal folders. Nobody has one place to find "the TMC COA for batch X of product Y". The Document Center gives TMC:

1. **One central library** of all TMC-branded documents, searchable by product, batch, dossier, type and entity.
2. **One flow to create them**: upload the supplier document, the existing neutralizer engine makes the TMC version, a person checks the yellow parts, then it becomes Final.
3. **Later: labels** (Kars' TMC Label Creator: EN/FR, Word + PDF) in the same place.

## 2. Users (pilot) · assumption, confirm

| Who | Role in pilot |
|---|---|
| Willem | Admin, uploads, approves (Final) |
| Kars | Uploads, approves (Final), owner of labels |
| Dennis Boeren, Sigi Berben | Upload, search, download |
| Later: logistics team (Stijn, Mila, Anthony …), sales | Search and download |

Pilot login: simple password login built into the app (no Entra yet). Microsoft login (Entra ID) comes with the Azure phase. No public access.

## 3. Scope per phase (strictly in order, each phase shown to Willem before the next)

| Phase | What | Done when |
|---|---|---|
| 0. Setup | Repo on GitHub, Next.js app, simple password login, deploy to Vercel | Willem logs in on the Vercel URL |
| 1. Library | Upload finished TMC documents with metadata; list, filter, search, view, download; versioning (never overwrite) | 20 real TMC documents uploaded and findable in < 10 s |
| 2. Neutralise | Upload supplier COA/MSDS/TDS (+ PFI/OC) → engine job → Word draft with yellow marks → check → Final (PDF) → into the library; check screen side by side (original left, TMC right); corrections go to the admin feedback overview | Same output as the current skill on the test corpus, provenance gate passing |
| 3. Labels | Kars' Label Creator as a module (EN/FR, Word + PDF), labels stored in the library | Kars signs off on 3 real labels |
| 4. Azure | Move app to Azure, switch login to Microsoft (Entra ID), worker to Azure Container Apps, files to SharePoint library "TMC Document Center" | Pilot users work on the Azure URL, Vercel switched off |
| 5. Link to Sonar Logistics | Documents per dossier visible in Sonar; BC data (product, batch, dossier) via the Dynamate API key | Opening a dossier shows its COA/MSDS |

Out of scope for now: e-signatures, external customer portal, automatic mail sending.

## 4. Hosting plan: Vercel first, then Azure (Willem, 16/10)

- **Vercel (phases 0-3):** Next.js front end + API routes. Start on Willem's **Hobby** account for the prototype with test documents only. Hobby is meant for personal, non-commercial use and has one user, so upgrade to Pro (≈ $20/user/month incl. $20 usage) or move to Azure before colleagues work in it.
- **Important limit:** the neutralizer engine is Python with OCR (Tesseract/ocrmypdf) and Word→PDF (LibreOffice). That does **not** run in Vercel serverless functions. So the engine runs as a separate **worker**:
  - pilot: worker runs on Willem's laptop (or a small container), picks up jobs from the database, writes results back;
  - Azure: the same worker as a container in Azure Container Apps.
- **Data rule for the Vercel phase:** use test/sample documents (e.g. the Klassif.ai sample set in OneDrive `Willem/COA's/DATA_Klassif.ai`) until Jeroen agrees real supplier documents may be stored outside the Microsoft tenant.
- **Build portable:** storage, auth and job queue behind small interfaces so the Azure move is a config change, not a rebuild.

## 5. Proposed stack (Claude Code may propose better, but must explain why)

| Part | Vercel phase | Azure phase |
|---|---|---|
| Front end + API | Next.js (App Router, TypeScript), Tailwind | Same code on Azure App Service / Static Web Apps |
| Login | Simple password login (users and hashed passwords in env vars or DB), behind `lib/auth` | Microsoft Entra ID (app registration) |
| Database | Postgres (Neon via Vercel) with Drizzle or Prisma | Azure Database for PostgreSQL |
| File storage | Vercel Blob | SharePoint document library via Microsoft Graph |
| Engine worker | Python 3.11, `engine/` folder (existing skill), polls `jobs` table | Azure Container Apps |
| Secrets | Vercel env vars | Azure Key Vault |

Needed from IT only in phase 4 (Cheops / Willem as admin): one **Entra app registration** for Microsoft login and Graph permission `Sites.Selected` for the SharePoint library.

## 6. Data model (first version)

**document**
- id, type: `COA | MSDS | TDS | SPEC | LABEL | OTHER`
- product_name (TMC name, as agreed with the client), inci_name (optional, see pricing tool), cas_number (optional)
- batch (lot), file_nr (TMC dossier, format `NNN.SNNNN`, e.g. `840.S0850`), po_number (optional)
- entity: `TMC` (Transmare Chemie NV) | `TMCGULF` | `PHARMALABO`
- language (EN default; FR, NL…)
- manufacturing_date, expiry_or_retest_date (only when on the source)
- supplier_name: internal metadata, visible to every logged-in user in the app (for checking), **never printed on any output** (Willem, 16/10)
- status: `Draft` → `To check` (yellow left) → `Final` → `Superseded`
- version (1, 2, 3 …), previous_version_id
- files: source (supplier original, internal), docx, pdf
- created_by, created_at, approved_by, approved_at
- tags (free)

**job** (neutralise run): id, document_id, input files, type, parameters (entity, product_name, file_nr, batch), state (`queued | running | to_check | done | failed`), exit_code, log, started/finished.

**audit_log**: append-only, every create/update/approve/download with user and time.

**entity** (settings): naam, adres, telefoon, email, web, btw, nood, code → see `engine/entity.example.json`. Only Willem adds entities; never invent an address.

## 7. Business rules (non-negotiable, from Willem's earlier decisions)

1. **Never invent, never leave out.** Every value on a TMC document comes from the source document or from a value a user typed. Every specification on the source COA must reach the output. The engine's provenance gate enforces this; it must never be bypassed or switched off.
2. **Yellow = must check.** Anything uncertain is marked yellow in the Word draft; the PDF/Final is blocked until all yellow is resolved by a person. Never remove a yellow mark automatically.
3. **No supplier identity on output:** supplier name, address, phone, e-mail, website, logo, article codes, colours. The UFI code stays. GHS/transport pictograms stay with their own colours. Exception for labels: a supplier name may appear only when the person making the label types it in; the app never fills it in (Willem 20/10).
4. **Hard values win:** product name, dossier number and batch typed by the user replace whatever the supplier document says. The product name comes from the commercial document (PFI, OC, contract, invoice) when available, otherwise the supplier's stays.
5. **File names** (settled, do not change):
   - COA: `<CODE>_COA_<file nr>_<product>_<batch>` e.g. `TMC_COA_840.S0850_Betaine_AI_test_BT-3877`
   - MSDS: `<CODE>_MSDS_<product>` e.g. `TMC_MSDS_HYDROQUINONE`
   - TDS/spec: `<CODE>_TDS_<product>`
   - Label: `<CODE>_LABEL_<file nr>_<product>_<batch>_<pack size>_<LANG>` e.g. `TMC_LABEL_840.S0850_Betaine_AI_test_BT-3877_25kg_FR` (one label per language; pack size = the net weight printed on the label; parts cleaned like a COA; the dossier is in the name but not printed on the label) (Willem 20/10)
   - A part that is not known is left out, never invented.
6. **Never overwrite.** Same name again = new version; the old one becomes `Superseded` and stays retrievable. Tell the user the document already exists.
7. **One COA per batch.** A COA with several batches gives one document per batch. A batch appearing twice with only a different quantity is taken once (note kept); a different analysis value is held back for a person.
8. **Incomplete input is caught** (e.g. page marker says 3 pages, file has 2).
9. **Emergency number** on MSDS section 1.4: +32 (0)14 58 45 45. Supplier's regulatory framing (UK REACH etc.) is kept as supplied.
10. Dates shown European (dd/mm/yyyy).

## 8. Screens (pilot)

1. **Library:** one table, filters in the column headers (type, product, batch, dossier, entity, status), search box, newest first. Row click opens the document.
2. **Document:** preview PDF, metadata, versions, download Word/PDF, audit trail. Approve button for approvers.
3. **New document:** drag and drop, one type per drop, several COAs at once; fields: entity, product name, dossier number (with "use first for all"), batch. Commercial document may be dropped with the COAs; typed values overrule it.
4. **To check:** list of drafts with yellow parts; download Word, upload checked Word, Finalise.
5. **Settings (admin):** entities, users/roles.

Look and feel: TMC navy `#213371`, TMC logo, clean, phone-friendly, NL/EN/FR labels later.

## 9. Open points

| # | Question | Who |
|---|---|---|
| 1 | Confirm pilot users and approvers (section 2) | Willem / Kars |
| 2 | Entra app registration for phase 4: who creates it (Willem as admin or Cheops)? | Willem |
| 3 | Vercel: Hobby for the prototype; Pro (who pays) before colleagues use it | Willem / Jeroen |
| 4 | Real supplier documents on Vercel: allowed or test data only? | Jeroen |
| 5 | Azure subscription for phase 4 | Cheops |
| 6 | Label Creator: Kars shares his example label and project files | Kars |
| 7 | Which document types first in the pilot: COA + MSDS (proposal), TDS next | Willem / Kars |

## 10. Success measures (KPI link)

- K8 documents auto-processed: count of Final documents made via the engine per month.
- K1 time saved: time per COA/MSDS manual vs via Document Center (baseline with Stijn).
- Search time: a document found in under 10 seconds.

## 11. Decisions log

| Date | Decision | By |
|---|---|---|
| 16/10/2026 | Project folder `C:\Users\wilman\Projects\tmc-document-center`, git branch per phase | Willem |
| 16/10/2026 | Vercel phase: test/sample documents only until Jeroen decides on real documents (open point 4) | Willem |
| 16/10/2026 | Supplier original is visible to every logged-in user, for checking. **Screen-by-screen policy:** on the check screen the supplier original is on the left and the TMC (neutralised) version on the right; the user makes the final call before downloading | Willem |
| 16/10/2026 | Finished TMC documents (phase 1 upload) may be added directly as Final by anyone with upload rights | Willem |
| 16/10/2026 | An approver may approve their own upload (no second person required) | Willem |
| 16/10/2026 | Phase 0 login: one admin account from env vars, own signed-cookie session behind `web/lib/auth`; users and roles move to the database in phase 1 | Claude, agreed by Willem |
| 16/10/2026 | Q6 and Q7 confirmed. Supplier name visible to every logged-in user in the app, never on any TMC output (section 6 updated) | Willem |
| 16/10/2026 | **Feedback overview (phase 2):** every correction a user makes when checking a draft (yellow part fixed, value changed, draft rejected, with a short reason) is stored and shown to the admin on one overview page, to improve the engine's reading rules. Never used to change a document automatically | Willem |
| 19/10/2026 | Supplier name on neutralise jobs stays optional (review N2) | Willem |
| 19/10/2026 | **File name = content:** the file name is made from the checked details by the naming rule (7.5); every value in it (product name, dossier, batch for a COA) must be printed in the document, otherwise Final is refused; the batch a document was made for cannot be changed (it is what makes the names differ); Approve goes through the worker too | Willem |
| 19/10/2026 | A COA with several batches (also side by side, one column per batch) gives one document per batch; the same lot twice with only another quantity is kept once; with another analysis result it is held back for a person; "Page 1 of 3" in a shorter file is refused as incomplete; a typed batch on a multi-batch COA is refused | Willem |
| 19/10/2026 | **Check-screen editor (option A):** the draft is edited as a document in the browser, any text may be changed, free formatting allowed. A value that is not in the supplier original gives a warning, the person may still go on (recorded in the audit trail and feedback). A document that names the supplier is always refused (hard rule 3). Word for the web (Microsoft 365) may follow in phase 4 | Willem |
| 20/10/2026 | Purchase dossiers: when there is no sales file number, the PO number (e.g. PO019423) is the TMC file nr, also in the file name | Willem |
| 20/10/2026 | COA product name = the name on the commercial document (contract, order); the person can change it at the check | Willem |
| 20/10/2026 | Real supplier documents (OneDrive corpus) are only run on the laptop; IT is asked to install LibreOffice and Tesseract (admin needed) | Willem |
| 20/10/2026 | Labels (phase 3) are made by BUCOS BU (Warre, Kars, Gilles) and logistics (Sigi, Dennis). Still needed from Kars: the Label Creator files, 2 or 3 real example labels (EN/FR, Word + PDF), the fields and where each value comes from | Willem |
| 20/10/2026 | Pilot users: Willem (wilman@), Stijn Van den Brande (stivdb@), Sigi Berben (sigber@), Brick Caumette (bricau@), Anthony De Moor (antdem@), Yari Mertens (yarmer@), all @transmare.com. Sales not needed now. Everyone else later through Microsoft login (Entra) | Willem |
| 20/10/2026 | Logistics mailboxes per BU (for notifications later; always the BU box in CC, initials in the subject): BU Stijn: Logistics-WA@ (Brick, Stephanie, Jolien); BU Dennis: Logistics-COFI@ (Julie, Sigi); BU Angely: Logistics-LATAM@ (Carlos, Mary Ann, Sigi); BU Anthony: Logistics-PHME@ (Willem, Hindou, Yari, Mila, Axel). Documents, Transexp and Van Moer inboxes stay as they are | Willem |
| 20/10/2026 | Microsoft login (Entra) moved forward from phase 4: all TMC staff (sales included) sign in with their Microsoft account; who may enter is set with an Entra group (pilot group first). Same TMC Entra as the logistics app, but its own app registration | Willem |
| 20/10/2026 | **Labels (phase 3 frame, started early):** LABEL documents in the library with the same versions, Superseded, audit and approvers as other documents. A label = template + form, made by the worker (Word + PDF), one label per language, one per A4 landscape sheet, one template for now. Form may start from a Final COA (product, dossier, batch, dates it holds). Fixed label texts EN/FR from Kars' TMC Label Creator (official CLP wording); Arabic follows when its texts are supplied, never translated by the app. Naming rule added to 7.5, with the pack size (net weight) so two packs of one batch get their own label; the dossier number is not printed on the label (not needed). Supplier name on a label only when typed by the person (7.3). A clearly marked SAMPLE template stands in for Kars' template; sample labels can never become Final. Labels are not uploaded through the library upload in this phase | Willem |
| 20/10/2026 | **Open for Willem:** trade names on TMC output (e.g. "Pharmatose 200M", "SuperTab 21AN") are product names but can point to the supplier. Default for now: allowed, as colleagues already write them on TMC COAs; the supplier company name itself never | Claude, default per Willem |
| 20/10/2026 | Next work while waiting for Cheops, Kars and IT: first an MSDS round on the real MSDS (laptop only), then the label frame (phase 3 started early, with a sample template that Kars replaces); plan first | Willem |
