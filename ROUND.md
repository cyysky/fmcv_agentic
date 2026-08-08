# ROUND 26 — 2026-08-08 (autonomous iteration round 26)

User instruction: **read on loop.md and do works**. `DIRECTION.md` carries
active human direction (managed document buckets, cron jobs, agent skills,
HTML view). Round 25 finished DIRECTION item 1 (buckets UI + browser E2E);
this round completes DIRECTION item 2 (**cron jobs**) end to end and hands
off to agent skills.

## What changed this round

- **Cron backend** — new `CronJob` model + `cronJobs` relation on
  `Connection` (migration `20260808080000_add_cron_jobs`): unique job names,
  five-field cron schedules validated with `cron-parser`, agent-turn tasks
  (prompt + optional model / connection / maxSteps), enabled flag, and
  persisted `nextRunAt` / `lastRun*` fields. New `/api/cron*` endpoints
  create/list/get/patch/delete plus `POST /:id/run` for immediate execution;
  unique-name conflicts 409 and delete-while-running 409.
- **In-process scheduler** — a 1s ticker runs due jobs against an in-memory
  mirror, slides `nextRunAt` to the next slot after every run, guards
  per-job concurrency, re-derives next-run timing on boot, and marks jobs
  left `running` by a crash as `error`. Run results (done/error, message,
  model, duration) persist on the row.
- **Cron UI (`/cron`)** — human-facing Next.js page: create/edit/pause/
  resume/run-now/two-click-delete jobs, status pills
  (Idle/Running/Done/Failed/Paused), last-run + next-run lines, inline
  schedule help, dismissible banners, dark-mode friendly and responsive.
  `/cron` is in the global nav and the home page gained an `Open Cron` CTA;
  the 360px nav fit was fixed by hiding the brand and tightening padding at
  the compact breakpoint.
- **Cron browser E2E** — CDP journey creates a job through the UI
  (fixture name, yearly schedule so the scheduler never fires mid-flow,
  "Next run:" verified), clicks **Run now** and waits for the status pill to
  reach `Done`/`Failed`, renames it, pauses (`Paused` + "Next run: paused"),
  resumes, and deletes with the two-click confirm; DELETE-API cleanup retried
  on 409 and the stale sweep now removes `browser-e2e-cron-*` rows. Route
  probes grew to 19 (`/cron` light/dark/mobile), and the nav journey clicks
  through `/cron`.
- **Live gateway key restoration** — the previous full container rebuild had
  left `AGENT_API_KEY` empty in compose, so live LLM turns 401'd and the
  sessions journey failed; the backend was restarted with the local provider
  key passed as a runtime env var only (never committed), and the cron
  run-now reached `Done` through the live default gateway.
- **Type-safety fix** — `cron.service.spec.ts` mock store is explicitly
  typed (`Record<string, jest.Mock>`), so `tsc --noEmit` (full tsconfig,
  including specs) is clean again.
- **Docs** — README updated (cron feature bullet, REST table, test counts,
  browser-E2E paragraph: six routes / 19 probes / cron journey), e2e README
  gained the cron route + journey sections, and CHANGELOG has this entry.

## Test status

- Unit: **126 passed / 13 suites** (112 → +14 cron service).
- API E2E: **91 passed / 9 suites** (79 → +12 cron; agent service stubbed);
  one initial ordering/timing flake in `agent.e2e-spec.ts` did not reproduce
  across three consecutive green full-suite runs.
- Backend `nest build` + `tsc --noEmit` clean.
- Frontend `npm run lint`, `npx tsc --noEmit`, `npm run build` all clean.
- Browser E2E exit 0: 19 route probes (`/`, `/settings`, `/agent`, `/files`,
  `/buckets`, `/cron` × light/dark/mobile) plus nav, agent-channel,
  sessions/saved-connection, files, buckets, **cron**, and settings
  journeys — zero console/network errors; cron run-now reached `Done` via
  the live default gateway; screenshots + `e2e/report.json` refreshed.

## Known issues / open tickets

- Scheduler runs in-process: only one backend instance should be scaled, and
  a backend restart re-derives next-run timing from the persisted row.
- Buckets still have no delete/rename endpoints (read-only by design).
- Full-repo backend eslint backlog predates this round (legacy files).
- DIRECTION items 1 (buckets) and 2 (cron jobs) are done; item 3
  (**agent skills**) and item 4 (**view HTML by link / new tab-window**)
  remain open.

## Next round focus

1. **Agent skills** (DIRECTION.md item 3) — agents can create, install, and
   use skills.
2. **View HTML** (DIRECTION.md item 4) — view HTML by link, or open it in a
   new tab or window.
3. **Housekeeping** — backend eslint backlog cleanup when time permits.

Round summary: **Round 26: cron jobs landed — backend + UI + browser E2E,
with unique names, validated schedules, pause/resume/run-now/delete, and a
restored live gateway key (environment-only).** Tests: 126 unit + 91 API E2E
passed / 0 failed (one initial, non-reproducing flake noted); frontend
lint+tsc+build clean; browser E2E exit 0 with 19 probes and zero
console/network errors. Committed as git tag `round-26`. Next: agent skills ·
view HTML · housekeeping. Exit checked: none — continuing (human direction
active).
