# ROUND 73 — 2026-08-08 (autonomous iteration round 73)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 72's first focus item: per-group overview transitions
in the cron UI.

## What changed this round

- **Per-group overview transitions** — `GET /api/cron/overview` accepts an
  optional `?group=` filter that scopes the newest-10 transition events to
  one lease group, and the payload now advertises `eventGroups` (all groups
  with transition history) so the UI can build the filter. The cron page's
  Transitions line gains All/group filter chips whenever more than one
  group has history; switching a chip refetches immediately and the 5 s
  poll keeps the chosen scope (`eventGroupFilter` re-runs the effect).
- **Browser E2E proof** — the cron journey seeds a synthetic second-group
  transition event (cascade-cleaned by id), asserts the filter control
  appears, proves the group chip narrows the list to `<group> · acquired`
  while hiding `default · acquired`, proves All restores both, and
  screenshot `cron-overview-event-filter.png` captures the filtered state.
- **Fixed browser E2E cleanup verifier** — the round's new cron cleanup
  check parsed psql's `-tA` output with `Number(...)`, which reads the
  `DELETE 1` command tag as `NaN` and misreported "synthetic event missing
  at cleanup" even though the row was deleted. The statement now uses
  `RETURNING id` and the check compares the first output line to the event
  id, so a real leftover would fail while a clean deletion passes.
- **Docs** — README cron prose, the overview API row (optional `group=`,
  `eventGroups`), and the browser-journey paragraph now describe the
  per-group Transitions filter.

## Test status

- Backend unit: **166 passed / 14 suites** (new per-group filter test;
  state diff empty after run).
- Backend API E2E: **118 passed / 11 suites** (new overview `?group=` e2e;
  live backend stopped, suite run, backend restarted immediately; known
  keep-alive warning unchanged, exit code 0).
- Backend `npx tsc --noEmit` + `npx eslint .` clean; docs guard OK —
  routes 69 / docs rows 68.
- Frontend `npx tsc --noEmit` + `npx eslint app/cron` + `next build` clean;
  backend + frontend images rebuilt and recreated; live stack healthy
  (frontend 200, overview 200).
- Browser E2E: **all checks passed** — cron journey includes the
  per-group filter proof (`overviewFiltered`, seeded second group), zero
  console/network/HTTP errors; report + screenshots refreshed (new
  `cron-overview-event-filter.png`).
- Baseline afterwards: 0 cron jobs / 0 cron_runs / 0 synthetic events;
  4 authentic `default`-group `acquired` events (backend stop/start during
  API-e2e plus image recreation) retained as demo failover history.

## Known issues / open tickets

- **Low** — Jest e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- Startup acquisition in `onModuleInit` is deliberately not recorded as an
  event — only transitions observed inside `tick()` write audit rows, so a
  replica that boots straight into a free lease produces no initial
  `acquired` row (keeps the table meaningful for failovers).
- **Low** — the Transitions filter lists groups from `eventGroups` (all
  history) while the list shows only the newest 10 events; a group whose
  newest event fell out of the newest-10 window shows "none recorded yet"
  when selected even though it has history. Acceptable today, worth a
  "last N per group" note or window hint if multi-group activity grows.

## Next round focus

- **History UX polish** — add a jump-to-newest affordance (and optionally a
  load-all/infinite-scroll option) for paged run histories; currently after
  paging Older deep into a history the user must click Newer back through
  many pages.
- **Per-group event window clarity** — surface how many events a filtered
  group shows vs. its total history (or per-group newest-10 semantics) so
  the empty-filter surprise above is self-explanatory.
- Any DIRECTION.md instruction.

## Loop state

Loop state: running — Round 73 delivered Round 72's per-group overview
transitions (backend `?group=` filter + `eventGroups`, frontend All/group
chips, unit/API-e2e/browser proof), fixed the new browser cleanup verifier
that misread psql's DML tag, all gates green, baseline clean. No exit
condition fires; proceed to Round 74.
