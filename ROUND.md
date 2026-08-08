# ROUND 76 — 2026-08-08 (autonomous iteration round 76)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 75's top focus item: per-group transition history depth.

## What changed this round

- **Overview transition-window depth (`?limit=`)** — `GET /api/cron/overview`
  now accepts an optional `limit=` that widens/narrows the transition event
  window (clamped 1–100, default 10; non-numeric/0 fall back to the default,
  negatives clamp to 1), so a selected lease group can show far more than its
  newest 10 events. Controlled in the cron panel by a **newest
  10/25/50/100** depth selector on the Transitions row that re-fetches the
  overview immediately (the Round 74 stale-response seq guard and Round 73
  group filter both keep working, and the 5 s refresh follows the chosen
  depth).
- **Unit + API coverage** — `CronService` unit test proves `take` follows the
  requested limit with the floor/ceiling/defaulting behavior; API e2e seeds a
  13-event synthetic group and verifies `?limit=10` → 10 rows, `?limit=50` →
  13, omitted/500 → default/clamp, per-group totals unchanged.
- **Browser E2E proof** — the cron journey now seeds **13** synthetic second-
  group events (staggered one second apart) and proves the default window
  reads "newest 10 of 13", then drives the depth selector to 50 and asserts
  the same selected group shows "newest 13 of 13", before restoring All and
  proving the widened depth survives (All view shows more than the old 10-
  event window). Result flags `eventWindowClarity` + `eventWindowDepth`, step
  `overview-event-depth`, screenshot `cron-overview-event-depth.png`.
- **Cleanup hardened** — cron cleanup now removes every `browser-e2e-event-%`
  fixture row and proves zero remain (the old exact-id delete would have
  missed the 13 suffixed rows; the count check also tolerates interrupt
  leftovers instead of assuming exactly 13).
- **Docs** — README cron prose, the `/api/cron/overview` REST table row, and
  the browser-journey paragraph now describe `?limit=` (1–100, default 10)
  and the depth selector; docs drift guard stays green.

## Test status

- Backend unit: **167 passed / 14 suites** (`tsc --noEmit` + `eslint .`
  clean); the new overview-limit test brings the cron spec to 27 tests.
- Backend API E2E: **119 passed / 11 suites** (+1 for the `?limit=` window
  e2e; known Jest keep-alive warning unchanged, exit code 0).
- Frontend `npx tsc --noEmit` + `npx eslint app/cron` clean; `next build`
  clean; **both Docker images rebuilt** (frontend carries the depth selector,
  backend carries `?limit=` — the first E2E failures were the live backend
  still running the pre-Round-76 image, which ignored `?limit`).
- Docs drift guard OK — routes 69 / docs rows 68.
- Browser E2E: **all checks passed** (cron flow proves the 13-event depth
  window and selector; zero console/network/HTTP errors; report + screenshots
  refreshed).
- Baseline afterwards: 0 cron jobs / 0 cron_runs / 0 synthetic events;
  6 authentic `default`-group `acquired` events remain (one more than Round
  75's 5 — the backend rebuild's scheduler failover logged another authentic
  `default` takeover; demo history only).

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- Startup acquisition in `onModuleInit` is deliberately not recorded as an
  event — only transitions observed inside `tick()` write audit rows.
- Load-all is deliberately capped at 200 runs; a history deeper than that
  shows "First 200 runs" (bounded UI memory).
- The first two browser-E2E attempts failed against a stale backend image
  (it ignored `?limit=`) and exposed that the deployed stack must be rebuilt
  together before E2E; the round's workflow now includes rebuilding both
  containers before the browser proof. A transient cleanup miscount
  (14 vs 13 fixture rows during debugging) was absorbed by the hardened
  zero-remain cleanup invariant.

## Next round focus

- **Memory-coast the overview window depth** — the Round 76 `?limit=`/
  selector is applied per fetch but a selected group's deeper window could
  also drive a "load all for this group" pass like run histories (or a
  group-search/timeline view) when clusters have long failover histories.
- **`MAX_RUN_MESSAGE` circular reference hygiene** — revisit the backend
  message-length constant usage across run creation/update paths and the
  history list rendering (never truncate mid-surrogate; assert in e2e).
- **Docker/ops docs** — document the container rebuild requirement (frontend
  + backend must be rebuilt together before E2E after API/UI contract
  changes) so a future round doesn't hit the stale-image trap again.

## Loop state

Loop state: running — Round 76 delivered the per-group transition history
depth (`?limit=` + newest 10/25/50/100 selector) with unit, API e2e, full
browser proof, and docs; all gates green (backend 167 unit / 119 API e2e,
frontend build/lint, docs guard, browser journey) and the baseline ended
clean. No exit condition fires; proceed to Round 77.
