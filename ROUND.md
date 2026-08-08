# Round 85 — mode-suffixed browser E2E artifacts (2026-08-09)

Human direction (DIRECTION.md item 1): none — DIRECTION.md is empty. This
round executed Round 84's first focus item: archive both enabled and
API-only browser E2E evidence per round instead of last-run-only.

## What changed this round

- **Mode-stamped browser E2E artifacts** — reports now land in
  `e2e/report-<enabled|api-only>.json` and screenshots in
  `e2e/screenshots/<mode>/`, so a round that runs both modes can commit both
  sets of evidence. `e2e/report.json` remains as a "latest run" mirror, and
  each report carries a top-level `mode` field.
- **Env overrides still win verbatim** — an explicit `E2E_REPORT` or
  `E2E_SHOT_DIR` bypasses the suffixing, so automated callers that pin paths
  keep working.
- **Docs** — `e2e/README.md` documents the new defaults (mode subdir +
  always-written `report-<mode>.json`) and the exit-code section points at
  the mode report; `README.md`'s browser-E2E artifact sentence describes the
  per-mode layout; the script header comment shows the artifact mapping.
- **Both modes re-run and archived** — enabled run (`schedulerChip:
  "enabled"`) and `E2E_API_ONLY=1` run (`schedulerChip: "disabled"`) both
  passed with the Round 83 job-row badge + group-filter flow
  (`groupFilterProven: true`), zero console/network/HTTP errors, 64
  screenshots each, and files committed side by side.

## Test status

- Backend unit: **182 passed / 14 suites** (`npm test -- --runInBand`).
- Backend API E2E: **123 passed / 12 suites** in API-only mode (Jest
  keep-alive warning remains, exit code 0); backend restored to enabled mode
  afterwards (`/api/cron/scheduler` reports `enabled: true`).
- Browser E2E: **all checks passed in both modes** — `e2e/report-enabled.json`
  (chip `enabled`) and `e2e/report-api-only.json` (chip `disabled`) are both
  committed; per-mode screenshots generated (gitignored); no backend or
  frontend code changed this round, so type checks are carried green from
  Round 84/83 (no source edits).
- Guards: REST docs OK — routes 70 / rows 69; test-count guard OK — unit 14
  suites / API E2E 12 suites.

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — old flat screenshots from pre-Round-85 runs still sit in
  `e2e/screenshots/` on disk (gitignored runtime artifacts; the new runs all
  write into mode subdirs). A one-time clean of the stale flat files would
  tidy the workspace.
- **Low** — `e2e/report.json` is the latest-run mirror only; the per-round
  historical archive lives in git history via the committed
  `report-<mode>.json` files.
- Load-all is deliberately capped (200 runs, 500 transition events,
  5 pages); a history deeper than that shows "First N runs/transitions"
  (bounded UI memory).

## Next round focus

- **Wire the guards + checks into one verify command** — a repo-root `verify`
  script (or npm script) that runs the REST docs guard, the test-count
  guard, backend unit tests, and frontend type checks in one command, so a
  round's verification step is reproducible and single-shot.
- **Browse for other friction** — sweep the current journeys for remaining
  rough edges (stale client caches, filter/refresh interplay, error states,
  leftover flat screenshots), fix what is cheap and ticket what is not.
- **E2E speed/tidy pass** — the full browser journey takes ~75 s per mode +
  two full runs per round; consider a `--quick` mode or splitting journeys so
  unchanged areas can be skipped.

## Loop state

Loop state: running — Round 85 archived both E2E modes side by side
(`report-<mode>.json` + `screenshots/<mode>/`) with all suites green and the
backend left in enabled mode. No exit condition fires; proceed to Round 86.
