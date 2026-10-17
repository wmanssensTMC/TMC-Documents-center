# Changelog

## 17/10/2026 · Phase 2b: worker (branch `phase-2-neutralise`)
- Worker (`web/worker/`): Node program that runs the engine unchanged. Woken by the app (POST /wake with a secret), checks every 30 min as a safety net, one job at a time, 10-minute limit, crashed runs retried up to 3 times.
- Engine called with an argument list (no shell), values as --option=value, safe local file names, no secrets in the engine's environment, log capped at 8 000 characters and stripped of server paths (review N2/N3).
- Output: every engine document becomes a "To check" draft (Word; PDF only if nothing is yellow), with its own copy of the supplier original. Engine failure (exit 1) stores nothing. Product, dossier and batch come only from typed values; empty ones are confirmed at the check.
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
