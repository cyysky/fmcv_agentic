# Round 86 — one-command fast verify + E2E artifact tidy (2026-08-09)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 85's first focus item (wire the guards + checks into one
verify command) and swept one piece of friction (stale flat screenshots).

## What changed this round

- **`scripts/verify.mjs` — one-command fast verify** — zero-dependency;
  runs in one pass: REST docs guard, test-count guard, backend unit tests,
  backend eslint + `tsc --noEmit`, frontend eslint + `tsc --noEmit`. Fails
  fast with the failing step's name and exits 0 only when everything is
  green. The API E2E, browser E2E, and `next build` stay explicit because
  they need docker mode flips / Chrome / longer runs (documented in the
  README Testing section).
- **README docs** — the Testing command block gains the
  `node scripts/verify.mjs` invocation and a bullet describing what the
  command covers and what stays explicit.
- **Stale flat screenshots removed** — 65 pre-Round-85 PNGs directly under
  `e2e/screenshots/` (gitignored runtime artifacts) deleted; only the
  per-mode `enabled/` and `api-only/` dirs remain, so the artifact layout is
  exactly what the docs describe.

## Test status

- `node scripts/verify.mjs` — **green end to end**: REST docs guard OK
  (routes 70 / rows 69), test-count guard OK (unit 14 / API E2E 12 suites),
  backend unit **182 passed / 14 suites**, backend lint + `tsc --noEmit`
  clean, frontend lint + `tsc --noEmit` clean (full run ~22 s).
- Backend API E2E: **123 passed / 12 suites** in API-only mode (Jest
  keep-alive warning remains, exit code 0); backend restored to enabled mode
  afterwards (`/api/cron/scheduler` reports `enabled: true`).
- Browser E2E: unchanged this round (no runtime code touched); both modes
  archived green in Round 85 (`report-enabled.json` chip `enabled`,
  `report-api-only.json` chip `disabled`).

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — `e2e/report.json` is the latest-run mirror only; the per-round
  historical archive lives in git history via the committed
  `report-<mode>.json` files (by design).
- Load-all is deliberately capped (200 runs, 500 transition events,
  5 pages); a history deeper than that shows "First N runs/transitions"
  (bounded UI memory).

## Next round focus

- **Browse for other friction** — sweep the current journeys for remaining
  rough edges (stale client caches, filter/refresh interplay, error states,
  E2E speed), fix what is cheap and ticket what is not.
- **E2E speed/tidy pass** — the full browser journey takes ~75 s per mode +
  two full runs per round; consider a `--quick` mode or journey splitting so
  unchanged areas can be skipped.
- **Verify-command extension** — fold `next build` into `verify.mjs` behind a
  flag (e.g. `--build`) for the rounds that touch frontend code, so the
  round's self-check stays one command there too.

## Loop state

Loop state: running — Round 86 added a single `verify.mjs` fast gate
(guards + unit + lint + types), removed stale flat screenshots, and left all
suites green with the backend in enabled mode. No exit condition fires;
proceed to Round 87.
