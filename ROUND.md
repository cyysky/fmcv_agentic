# Round 82 — browser E2E proof of the API-only scheduler chip (2026-08-09)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 81's first focus item: browser-level proof that the
/cron UI shows the API-only state when the backend runs with
`CRON_SCHEDULER_ENABLED=false`.

## What changed this round

- **Fixed a scheduler-chip race bug found by the new assertion** — the
  scheduler-status and overview fetches shared one sequence counter, so the
  overview's newer request silently discarded the scheduler response when it
  won the race; the chip stayed empty even though `/cron/scheduler` 200'd.
  Each feed now keeps its own sequence guard (`schedulerSeq`/`overviewSeq`).
- **API-only chip is asserted in browser E2E** — the cron flow now checks
  the header chip up front: `E2E_API_ONLY=1` expects "Scheduler disabled —
  API-only" + "no lease · no background firing"; the default run expects
  "Scheduler active on this node" or "Scheduler standby — lease held
  elsewhere" (screenshot + `flow.schedulerChip` recorded per run).
- **Overview lease gauge is mode-aware** — with `CRON_SCHEDULER_ENABLED=false`
  the cluster-overview lease chip renders `group · disabled · no lease`
  (previously it said "expired · <stale owner>"); the E2E asserts the
  disabled gauge text in API-only mode and the active chip otherwise.
- **Docs** — `e2e/README.md` gained the `E2E_API_ONLY` variable row and
  `README.md` shows the one-line API-only browser E2E invocation.

## Test status

- Backend unit: **181 passed / 14 suites**; `npx tsc --noEmit` +
  `npx eslint .` clean.
- Backend API E2E: **122 passed / 12 suites** with the live Docker backend
  running the scheduler (Jest keep-alive warning remains, exit code 0).
- Frontend `npx tsc --noEmit` + `npx eslint app/cron` clean; `next build`
  clean.
- Docs drift guard OK — routes 70 / docs rows 69 (no route change).
- Browser E2E: **all checks passed twice** — enabled mode (scheduler
  active/standby + active gauge chip) and `E2E_API_ONLY=1` mode (disabled
  chip + disabled gauge chip), both zero console/network/HTTP errors;
  report refreshed; screenshots regenerated (gitignored as usual).

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — docs test-count paragraphs drift with every test change; keep
  syncing manually or trim the bullets to suite counts.
- Load-all is deliberately capped (200 runs, 500 transition events,
  5 pages); a history deeper than that shows "First N runs/transitions"
  (bounded UI memory).

## Next round focus

- **Ownership in the job row** — surface `schedulerGroup` on the individual
  job cards/rows and optionally filter `/api/cron` list per group, so ops
  can see (and filter) who owns each job at the row level, not only in the
  cluster overview.
- **Tidy the docs test-count paragraphs** — trim the unit/API e2e bullets
  to suite-level counts or wire an automatic consistency check so exact
  numbers stop drifting.
- **Browse for other friction** — e.g. the E2E report only keeps the last
  mode's run; consider writing mode-suffixed reports/screenshots so both
  enabled and API-only evidence is archived per round.

## Loop state

Loop state: running — Round 82 delivered browser E2E proof of the API-only
chip (and the API-only overview gauge), plus a real frontend race bug it
caught; backend/API/browser suites are all green in both modes. No exit
condition fires; proceed to Round 83.
