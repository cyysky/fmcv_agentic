# ROUND 27 — 2026-08-08 (autonomous iteration round 27)

User instruction: **read on loop.md and do works**. `DIRECTION.md` carries
active human direction (managed document buckets, cron jobs, agent skills,
HTML view). Rounds 25–26 completed DIRECTION items 1 (buckets) and 2 (cron
jobs); this round completes item 3 (**agent skills**) end to end and hands
off to item 4 (view HTML).

## What changed this round

- **Skills backend** (commit `72453b3`) — new Prisma `Skill` model +
  migration `20260808072441_add_skills`; REST API
  `POST/GET /api/skills`, `GET/PATCH/DELETE /api/skills/:id`,
  `POST /api/skills/:id/install|uninstall`. Unique slug-form names (409),
  install requires non-empty content, uninstall keeps the record, delete
  removes it, empty PATCH 400, content capped at 200k chars.
- **Agent integration** — `BaseAgentService` takes an optional
  `SkillsService` (`@Optional()`); installed skills become a system-prompt
  registry block on every `runTurn`/`converse`/channel turn, and a
  `read_skill` tool returns the full markdown body of a named skill
  (per-turn injection is stripped from persisted transcripts).
- **Skills UI (`/skills`)** — create/edit/install/uninstall/two-click-delete,
  status pills (Installed/Not installed), banners, dark-mode + responsive;
  form fields gained aria-labels and rows carry `data-name` so the CDP
  harness can drive them like the cron/files pages. `/skills` joined the
  global nav (7 links) and the home page gained an `Open Skills` CTA;
  360px nav fit verified for the 7-link nav.
- **Skills browser E2E** — 21 route probes across 7 routes (skills
  light/dark/mobile added; skills-dark checks the create form's dark input
  style and uses a per-route form selector), nav journey clicks `/skills`,
  and a new skills journey creates a skill with install-now checked, verifies
  the Installed pill + notice, reload-persists, edits, uninstalls,
  reinstalls, and deletes via two-click confirm; cleanup uses the skills
  DELETE API and `staleSweep()` now removes `browser-e2e-skill-*` rows.
- **Docs** — README (skills feature bullet, `/api/skills` REST table, test
  counts, browser-E2E paragraph: seven routes / 21 probes / skills journey),
  e2e README (skills route + journey), CHANGELOG Round 27 entry.

## Test status

- Unit: **142 passed / 14 suites** (126 → +12 skills service, +4 base-agent
  skills integration); verified this round.
- API E2E: **101 passed / 10 suites** (91 → +11 skills, real Postgres);
  verified this round.
- Backend `nest build` + `tsc --noEmit` clean; scoped eslint clean for the
  new skills files.
- Frontend `npm run lint`, `npx tsc --noEmit`, `npm run build` all clean.
- Browser E2E exit 0: 21 route probes (7 routes × light/dark/mobile) plus
  nav, agent-channel, sessions/saved-connection, files, buckets, cron,
  **skills**, and settings journeys — zero console/network errors;
  screenshots + `e2e/report.json` refreshed.

## Known issues / open tickets

- Scheduler runs in-process: only one backend instance should be scaled, and
  a backend restart re-derives next-run timing from the persisted row.
- Buckets have no delete/rename endpoints (read-only by design).
- Skills are authored in-app and surfaced via the `read_skill` tool +
  system-prompt registry; installed state is in-memory per backend instance
  (single-instance deployment assumed, same as the scheduler).
- Full-repo backend eslint backlog predates this round (legacy files).
- DIRECTION items 1–3 are done; item 4 (**View HTML by link / new
  tab-window**) remains open.

## Next round focus

1. **View HTML** (DIRECTION.md item 4) — view HTML by link, or open it in a
   new tab or window.
2. **Housekeeping** — backend eslint backlog cleanup when time permits.
