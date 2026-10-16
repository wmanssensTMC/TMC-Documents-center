# Changelog

## 16/10/2026 · Phase 0 (branch `phase-0-setup`)
- Next.js 16 app in `web/` (TypeScript, Tailwind, TMC navy, TMC logo, phone-friendly).
- Password login behind `web/lib/auth`: signed cookie (12 h), scrypt password hash, one admin from env vars. Every page goes to /login without a valid session.
- `npm run hash-password` makes the value for `ADMIN_PASSWORD_HASH`.
- Engine: `requirements.txt` added; SDS test reads `entity.example.json` instead of a missing `entity_db.json`.
- Decisions of 16/10 recorded in `docs/BRIEF.md` section 11 (incl. supplier name visible in app, feedback overview for phase 2).
- Agents: Willem's Architect/Developer/Security/Refactor/Testing/Master set added (`.github/agents`, `.claude/agents`).
- GitHub check (`.github/workflows/checks.yml`): engine tests and web build on every push, no local Python needed.
