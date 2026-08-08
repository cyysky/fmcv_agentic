# ROUND 74 — 2026-08-08 (autonomous iteration round 74)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 73's two focus items: run-history jump-to-newest and
per-group event-window clarity.

## What changed this round

- **Jump-to-newest pager** — when a cron run history is paged past page 0,
  the pager now shows a one-click **Jump to newest** that returns to page 0
  (Newer still pages back one step at a time). Browser proof pages to the
  last 3-row page, jumps, and asserts page 0 / 20 rows / Older available.
- **Per-group event-window clarity** — `GET /api/cron/overview` now returns
  `eventStats` (per-lease-group transition totals from a `groupBy _count`),
  the filter chips show `All (N)` / `{group} (N)` with `data-event-total`,
  and the Transitions line labels its window as `newest N of M transitions`
  (with ` for {group}` when filtered) — so "none recorded yet" for a group
  whose newest event fell out of the newest-10 window is self-explanatory.
- **Fixed run-history pager race** — the 5 s expanded-history auto-refresh
  could overwrite a just-clicked Older/Newer/Jump navigation with a stale
  re-fetch of the old page, leaving the list stuck on the wrong page; the
  refresh now skips applying a response when the open list moved to another
  page while the fetch was in flight.
- **Fixed overview filter race** — an in-flight scheduler/overview poll
  started before a filter click (or before a seeded event appeared in the
  next poll) could arrive after the fresher response and clobber it (chips
  flickered back to All, or the newest-N-of-M label read "newest 6 of 1");
  responses now apply only if they are still the newest requested (per-
  effect sequence guard), on top of the existing cross-instance cancel.
- **Browser E2E fixes** — the new window label predicate embedded the e2e
  group as a bare identifier (`label.includes(" for " + e2e-…)`), which
  threw ReferenceError on every poll and was swallowed by `waitFor` as a
  15 s timeout despite a correct DOM; the group is now embedded as a JSON
  string literal. The group-chip click waits for the specific chip to exist
  before clicking. The pre-run stale sweep now also prunes synthetic
  `cron_scheduler_events` (`browser-e2e-event-%`) left by interrupted runs
  and filters psql command tags out of its report — proven by planting a
  leftover event before the final run and watching the sweep delete it.
- **Serial API E2E** — `backend/test/jest-e2e.json` sets `maxWorkers: 1`
  and `backend/README.md` explains why (shared Postgres + boot-time
  interrupted-run sweep make parallel suites clobber each other).
- **Docs** — README cron prose and the overview API row now describe
  Jump to newest, chip totals, and the newest-N-of-M window label; the
  browser-journey paragraph covers both new checks (API e2e count 115→118).

## Test status

- Backend unit: **166 passed / 14 suites**; `tsc --noEmit` + `eslint .` clean.
- Backend API E2E: **118 passed / 11 suites** (run earlier this round with
  the live backend stopped and restarted after; known Jest keep-alive
  warning unchanged, exit code 0).
- Frontend `npx tsc --noEmit` + `npx eslint app/cron` + `next build`
  (Docker image rebuild) clean.
- Docs drift guard OK — routes 69 / docs rows 68.
- Browser E2E: **all checks passed** — cron flow proves
  `historyPaged`, `historyJumpToNewest`, `eventWindowClarity` (chip total 1,
  window `1:1`, label "newest 1 of 1 for <group>"), `overviewFiltered`,
  and the All-view label stays coherent ("newest N of M" matching the All
  chip); zero console/network/HTTP errors; report + screenshots refreshed
  (`cron-history-jump-to-newest.png`, `cron-overview-event-filter.png`).
- Baseline afterwards: 0 cron jobs / 0 cron_runs / 0 synthetic events
  (final run also confirmed the sweep removes a planted leftover event);
  5 authentic `default`-group `acquired` events remain as demo failover
  history.

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- Startup acquisition in `onModuleInit` is deliberately not recorded as an
  event — only transitions observed inside `tick()` write audit rows.
- Run history still pages 20 at a time; Jump to newest removes the
  "click Newer many times" pain, but there is no load-all/infinite scroll.
- Transitions still shows only the newest 10 events; per-group totals and
  the newest-N-of-M label clarify the window, but a group whose newest event
  is older than the 10th newest still reads "none recorded yet" when
  selected.

## Next round focus

- **Load-all / infinite scroll for run histories** — replace repeated
  paging with a "Load all runs" or infinite-scroll option while keeping the
  current page-aware polling and Jump to newest.
- **Per-group transition history depth** — let a selected group show more
  than the newest 10 of its events (e.g. last-N-per-group or a window
  selector), removing the last empty-filter surprise entirely.
- Any DIRECTION.md instruction.

## Loop state

Loop state: running — Round 74 delivered jump-to-newest, per-group
eventStats + chip totals + newest-N-of-M window labels, and fixed two real
poll/navigation races (run-history page clobber, overview stale-response
overwrite) plus the new E2E predicate bug; backend 166 unit / 118 API e2e,
frontend build/lint, docs guard, and the full browser journey all green.
No exit condition fires; proceed to Round 75.
