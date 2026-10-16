# First prompt for Claude Code

Copy everything below the line into Claude Code, started inside the `tmc-document-center` folder.

---

You are building the TMC Document Center for Transmare Chemie. Read `CLAUDE.md` and `docs/BRIEF.md` completely first, then look at `engine/ENGINE.md` and the scripts in `engine/scripts/` so you understand the existing neutralizer.

Do NOT write code yet. Give me, in one message:

1. A short summary in plain language of what you will build in phase 0 and phase 1, and how the engine will be plugged in during phase 2.
2. The folder structure you propose (app, worker, engine, docs).
3. Your stack choice per part (BRIEF section 5). If you propose something different, explain why in one line.
4. Everything you need from me before you can start: accounts (GitHub, Vercel, Neon), the Entra app registration details, environment variables. Give step-by-step instructions for each, since I am not technical.
5. Check that the engine runs locally: install its Python dependencies, run `engine/tests/`, and tell me what passes and what fails.
6. All open questions in one list.

Then wait for my "ok" before building phase 0.
