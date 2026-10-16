# CLAUDE.md: TMC Document Center

Read `docs/BRIEF.md` first. It is the source of truth for scope, data model and business rules.

## Who you work for
Willem Manssens, AI lead at Transmare Chemie NV (TMC). He is not a developer: explain choices in plain language, short and structured, then give the technical detail.

## How to work
- **Plan first.** Before building anything, show the plan and the proposed changes and wait for "ok". Ask all questions in one message.
- **Build in phases** exactly as in BRIEF section 3. Finish, test and show a phase before starting the next.
- **Extend, never rebuild.** Reuse the existing engine in `engine/` (Python neutralizer: COA, MSDS, TDS, provenance gate, OCR, yellow review). Do not rewrite its logic in TypeScript.
- **Never guess or invent data**, field meanings or business rules. Ask.
- **Least work, best overview:** when reviewing, simplify rather than add.
- Keep secrets out of git (`.env.local`, never committed). Add a `.env.example`.
- Small commits with clear messages. Keep a short `docs/CHANGELOG.md`.

## Hard rules (from the brief, never break)
1. The provenance gate in `engine/scripts/provenance.py` must run on every engine output and can never be bypassed.
2. Yellow-marked drafts can never become Final automatically.
3. No supplier identity on any output; supplier name is internal metadata only.
4. Never overwrite a document: new version, old one `Superseded`.
5. File names exactly as in BRIEF section 7.5.
6. Tests in `engine/tests/` must keep passing. Add tests for new logic.

## Architecture guard rails
- The Next.js app must not run Python/OCR/LibreOffice in serverless functions. The engine runs in a separate worker (`worker/`) that polls the `job` table.
- Storage, auth and queue sit behind small interfaces (`lib/storage`, `lib/auth`, `lib/jobs`) so Vercel → Azure is configuration, not a rebuild.
- On Vercel, use test/sample documents only until Willem confirms otherwise.
- Pilot runs on Willem's Vercel **Hobby** account: keep usage small (no cron jobs, no heavy functions).
- Pilot login is a simple password login (`lib/auth`), no Entra. Build it so Microsoft Entra can replace it in phase 4 without touching the pages.

## Style
- UI: TMC navy `#213371`, TMC logo (`engine/assets/logo.png`), clean, phone-friendly. Dates dd/mm/yyyy.
- Text for users in English first; NL/FR later via a translation file.
- No em dashes in any text Willem will send by mail.

## Agents (added 16/10/2026)
- Willem's agent set lives in `.github/agents/*.agent.md` (GitHub Copilot format, verbatim) and in `.claude/agents/` (same text, tool names for Claude Code).
- Per phase, the main session runs the Master workflow: `architect` (design) -> build -> `security` -> `refactor` -> `testing` -> docs. Small fixes inside a phase only need `security` and `testing` when they touch login, uploads or file handling.
- Master's "Migration Branch Gate", "Publication" and Aikido steps do not apply here (no Aikido). Instead: one branch per phase, checks on GitHub must pass, Willem says ok, then merge to `main`.

## Checks
- `.github/workflows/checks.yml` runs the engine tests (Python, LibreOffice, OCR) and the web build on GitHub for every push. Nothing needs installing on a laptop for that.
