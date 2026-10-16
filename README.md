# TMC Document Center: starter pack

Starter pack for building the TMC Document Center with Claude Code (16/10/2026).

## What is in here

| File / folder | What it is |
|---|---|
| `docs/BRIEF.md` | The project brief: why, users, phases, data model, rules, open points |
| `CLAUDE.md` | Working rules Claude Code reads automatically in this folder |
| `KICKOFF_PROMPT.md` | The first prompt to paste into Claude Code |
| `engine/` | Copy of the current neutralizer (COA, MSDS, TDS, OCR, provenance gate, templates, tests) |
| `samples/` | Put test documents here (see below) |

## How to start (5 steps)

1. Unzip this folder somewhere on your laptop, for example `C:\Users\wilman\Projects\tmc-document-center` (not inside OneDrive sync, which slows builds).
2. Install once: Git, Node.js LTS, Python 3.11, and Claude Code. Claude Code can guide you if something is missing.
3. Put 5 to 10 test documents in `samples/`: some COAs (with their PFI/OC), 2 MSDS, 1 TDS. The Klassif.ai sample set in OneDrive `Willem/COA's/DATA_Klassif.ai` is a good start.
4. Open a terminal in the folder and start Claude Code (`claude`).
5. Paste the text from `KICKOFF_PROMPT.md`. Claude Code answers with a plan and questions; it builds nothing until you say ok.

## Before phase 0 can go live on Vercel

- Your Vercel Hobby account is fine for the prototype with test documents; Pro before colleagues use it
- GitHub account (code storage); Claude Code puts the code there, Vercel deploys it from there
- No Entra needed for the pilot: simple password login first, Microsoft login in the Azure phase
- Decision from Jeroen whether real supplier documents may be stored on Vercel; until then, test documents only

## Engine check (16/10/2026, run in the cloud)

| Test | Result |
|---|---|
| `tests/test_v060_routes.py` | 15 passed, 0 failed |
| `tests/test_scan_and_batches.py` | runs, but skips the scan cases because the sample PDFs are not included |
| `tests/test_sds_rejects_invented_values.py` | fails: it needs an `entity_db.json` file that is not in the package. First fix for Claude Code (create it from `entity.example.json`) |
