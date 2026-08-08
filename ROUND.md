# Round 95 — API-only browser E2E refresh + lazy-chunk regression guard (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 94's remaining focus items: the stale API-only browser report
is refreshed, and the Round 93 lazy panel split now has a regression guard
that fails the E2E gate if the panel UI ever leaks back into the eager load.

## What changed this round

- **Lazy-chunk regression guard** — `e2e/browser-e2e.mjs` snapshots the
  eager `/agent` first-load script set (resource-timing based, so it holds
  even when the browser serves chunks from cache), then asserts opening the
  Channels tab fetches the deferred panel chunk (`1awykuxxz4tx1.js`,
  contains the "saved sessions yet" panel marker) and that no eager chunk
  carries the marker. Proven on both E2E modes: 14 eager / 1 lazy chunk,
  zero eager marker hits.
- **API-only browser E2E refreshed** — full all-journey run against
  `CRON_SCHEDULER_ENABLED=false`: 21 route probes + all 11 flows green with
  zero console/network/HTTP errors; `e2e/report-api-only.json` refreshed and
  the backend restored to enabled mode.
- **Full enabled-mode browser E2E re-run** — all-journey run against the
  restored stack green (`report-enabled.json` + `report.json` refreshed with
  the guard evidence).
- **Fresh full verify** — `node scripts/verify.mjs --build --api-e2e` green:
  REST docs + test-count guards, backend unit, backend/frontend lint + type
  checks, `nest build`, `next build`, bundle-size guard, and API E2E
  (backend flipped to API-only and restored).

## Test status

- Backend unit: **14 suites / 182 tests passed** (fresh via verify this round).
- Backend API E2E (real Postgres, multi-replica): **12 suites / 123 tests
  passed** (fresh this round; known Jest keep-alive warning only).
- Frontend: `tsc --noEmit`, ESLint, and `next build` green; bundle guard
  largest first-load **485 KB (`/agent`, 8 chunks)** within the 600 KB budget.
- Browser E2E (real Chrome over CDP): full all-journey runs green in both
  enabled and API-only modes — 21 route probes each, zero errors; lazy-chunk
  guard verified on both runs.

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — `e2e/report.json` is the latest-run mirror only; per-round
  archives live in git history via committed `report-<mode>.json` (by design).
- **Low** — the lazy panels connect through a wide controlled-prop surface
  (~25 sessions / ~45 channels props); a shared context/store could tighten
  that if prop drift becomes painful.

## Next round focus

1. **Tighten the agent-views prop surface** — replace the wide controlled
   props (~25 sessions / ~45 channels) with a shared context/store if a
   clean boundary can keep the lazy chunk split intact; re-verify bundle
   guard (485 KB `/agent` baseline) plus both browser E2E modes after.
2. **Keep the full E2E gate current** — re-run `verify --build --api-e2e` and
   full enabled/API-only browser E2E after any frontend change so the
   lazy-chunk guard stays proven on a fresh build.
3. **Optional** — if more `/agent` first-load budget is wanted, split the
   remaining eager app code (models/connections/workspace pickers) from the
   485 KB route, which is still ~115 KB under budget.
