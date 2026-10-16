# Changelog

## 16/10/2026 · Phase 0 (branch `phase-0-setup`)
- Next.js 16 app in `web/` (TypeScript, Tailwind, TMC navy, TMC logo, phone-friendly).
- Password login behind `web/lib/auth`: signed cookie (12 h), scrypt password hash, one admin from env vars. Every page goes to /login without a valid session.
- `npm run hash-password` makes the value for `ADMIN_PASSWORD_HASH`.
- Engine: `requirements.txt` added; SDS test reads `entity.example.json` instead of a missing `entity_db.json`.
- Decisions of 16/10 recorded in `docs/BRIEF.md` section 11 (incl. supplier name visible in app, feedback overview for phase 2).
- Agents: Willem's Architect/Developer/Security/Refactor/Testing/Master set added (`.github/agents`, `.claude/agents`).
- GitHub check (`.github/workflows/checks.yml`): engine tests and web build on every push, no local Python needed.
- Security review (75/100) fixes: role claim validated and unknown roles fail closed; scrypt cost N=2^17 stored in the hash; same timing for unknown e-mail; input length caps; failed-login log line; security headers (no framing, nosniff, referrer, HSTS); hash script hides the password; GitHub check token read-only. Built-in login brake: max 2 checks at once, 5 failures per IP+e-mail lock 15 min. Still to add at deploy: Vercel Firewall rate-limit rule on POST /login.
