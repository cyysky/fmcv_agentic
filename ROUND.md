# Round 129 — enabled-mode browser E2E refreshed on the rebuilt image (2026-08-09)

Previous focus (Round 128's "Next round focus" #1): re-run the
enabled-mode browser E2E on the rebuilt backend image so no E2E report is
stale.

## What changed this round

- **Enabled-mode browser E2E re-run on the rebuilt image** — full 13-flow
  run green with zero console/network/HTTP errors; webtools recorded
  `provider=bing` in `auto` mode, confirming the DDG→Bing fallback is
  still firing live. `e2e/report-enabled.json` + `e2e/report.json`
  refreshed; every browser report (enabled `auto`, API-only `duckduckgo`,
  API-only `bing`) now comes from the image containing the
  `WEB_SEARCH_PROVIDER` feature.

## Test status

- Backend unit: **16 suites / 328 tests passed** (no source changes).
- Browser E2E: **3/3 fresh reports green** (enabled `auto` + both pinned
  API-only provider passes).
- Full gate: Round 127's `verify --build --api-e2e` green result stands
  (no runtime code changed since); backend enabled with `auto`.

## Known issues / open tickets

- **Closed** (accepted environmental limitation) — Brave/DDG captchas on
  datacenter IPs; Bing RSS fallback is the proven mitigation (unit +
  browser E2E). Nothing further is actionable inside this project.

## Next round focus

_(empty — all DIRECTION items are implemented and E2E-proven; all tickets
closed or accepted as environmental; the next gate run is only warranted
after a future runtime change.)_
