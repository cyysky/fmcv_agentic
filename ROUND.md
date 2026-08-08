# Round 87 — API-E2E helper + verify flags (2026-08-09)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 86's focus items ("browse for friction" + "verify-command
extension"): the recurring API E2E mode-flip dance is now one command, and the
fast verify can cover builds.

## What changed this round

- **`scripts/api-e2e.mjs` — one-command API E2E with safe mode flip** —
  disables the backend scheduler (`CRON_SCHEDULER_ENABLED=false` +
  recreate), waits until `/api/cron/scheduler` reports `enabled:false`, runs
  `cd backend && npm run test:e2e`, restores the backend to enabled mode and
  waits for `enabled:true`. The restore runs even when the suite or a flip
  fails; exit 0 only when the whole pipeline is green. This removes the
  hand-remembered 3-step flip/run/restore dance from every round.
- **`verify.mjs` flags** — `--build` adds `nest build` + `next build`;
  `--api-e2e` adds the API E2E step (via the helper above), so a round that
  touches frontend or backend can self-check in one command.
- **Docs** — README Testing gains the api-e2e helper (shell block + bullet)
  and the verify flags; both proved live before commit.

## Test status

- `node scripts/api-e2e.mjs` — **green**: flip to API-only, API E2E
  123 passed / 12 suites, restore to enabled mode, exit 0.
- `node scripts/verify.mjs --build` — **green end to end**: both guards,
  backend unit **182 / 14**, backend lint + types, frontend lint + types,
  `nest build` + `next build` all pass.
- REST docs guard OK — routes 70 / rows 69; test-count guard OK — unit 14 /
  API E2E 12 suites.
- Browser E2E: unchanged this round (no runtime code touched); both modes
  archived green in Round 85.

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

- **E2E speed pass** — the full browser journey takes ~75 s per mode + two
  full runs per round; consider a `--quick`/journey-select flag so unchanged
  areas can be skipped while the touched journeys still run.
- **Base-agent/journal friction sweep** — visit the agent journey with a
  connection-less default provider and with a pinned saved connection, log
  anything rough (empty states, confusing notices, stale fetch after save),
  fix what is cheap.
- **Bundle/frontend hygiene** — `next build` output is clean; sweep for
  large/duplicated client bundles (e.g. via `next build` size output or
  `webpack-bundle-analyzer`-free inspection) and ticket real wins.

## Loop state

Loop state: running — Round 87 replaced the repeated manual API-E2E mode
flip with `scripts/api-e2e.mjs`, extended `verify.mjs` with `--build` /
`--api-e2e`, and left every suite green. No exit condition fires; proceed to
Round 88.
