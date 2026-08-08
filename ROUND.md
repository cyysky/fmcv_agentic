# Round 88 — E2E journey selection for fast regression runs (2026-08-09)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 87's first focus item (E2E speed pass): the full browser
journey can now be narrowed to the flows a change actually touches.

## What changed this round

- **`E2E_JOURNEYS` flow selection in the browser E2E** — a comma-separated
  env var (`routes`, `nav`, `agent`, `mobile`, `sessions`, `files`, `html`,
  `buckets`, `cron`, `skills`, `settings`; default `all`) gates both the
  execution and the validation of every flow. Skipped flows stay `null` in
  the report instead of failing the gate, and a `journeys` field records what
  ran. Proven live with `E2E_JOURNEYS=routes,cron` (green, ~45 s, only
  routes + cron in the report) and with the full default run (all flows
  green, ~110 s).
- **Docs** — `e2e/README.md` gains the `E2E_JOURNEYS` env row;
  `README.md`'s Testing shell block shows the quick-run invocation.
- Quick runs still exercise the Round 83 badge + group-filter flow and the
  mode chip; screenshots/report remain mode-suffixed.

## Test status

- Browser E2E (enabled mode): **full default run green** — all routes +
  all 10 journeys, zero console/network/HTTP errors; `report-enabled.json`
  updated (chip `enabled`, `groupFilterProven: true`, journeys `["all"]`).
- Browser E2E quick subset (`E2E_JOURNEYS=routes,cron`): **green** —
  report recorded exactly `["routes","cron"]` with skills/settings omitted,
  cron chip + group filter still proven.
- No backend/frontend runtime code changed this round; `node --check` clean
  on the edited script; guards carried green from Round 87 (no doc-count or
  REST changes to their inputs).

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — `e2e/report.json` is the latest-run mirror only; the per-round
  historical archive lives in git history via the committed
  `report-<mode>.json` files (by design).
- **Low** — `E2E_JOURNEYS` is a flat list, not per-mode shorthands; users
  must spell out the flows they care about (a `cron-only` / `ui-only`
  preset could come later).
- Load-all is deliberately capped (200 runs, 500 transition events,
  5 pages); a history deeper than that shows "First N runs/transitions"
  (bounded UI memory).

## Next round focus

- **Agent/journal friction sweep** — visit the agent journey with a
  connection-less default provider and with a pinned saved connection, log
  anything rough (empty states, confusing notices, stale fetch after save),
  fix what is cheap.
- **Bundle/frontend hygiene** — inspect `next build` size output for
  large/duplicated client bundles and ticket real wins.
- **Journey presets** — add `E2E_JOURNEYS=cron-only|ui-only|core` shorthands
  so quick runs are one word instead of a flow list.

## Loop state

Loop state: running — Round 88 made the browser E2E selectable per flow
(default unchanged: all), proved both quick and full runs green, and left
the backend in enabled mode. No exit condition fires; proceed to Round 89.
