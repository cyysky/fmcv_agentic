# Round 128 — both web-search provider pins proven in real Chrome (2026-08-09)

Previous focus (Round 127's "Next round focus" #1): run the pinned-DDG
browser pass to close the deterministic web-search fixture ticket, and keep
the gates current.

## What changed this round

- **Pinned-DDG browser pass failed first — and caught a real infra gap**:
  with `WEB_SEARCH_PROVIDER=duckduckgo` + `E2E_EXPECT_SEARCH_PROVIDER=
  duckduckgo`, the webtools journey reported `provider=bing` and failed the
  strict assertion. Root cause: `docker compose up -d --force-recreate
  backend` recycles the container but **not the image**; the running image
  predated the `WEB_SEARCH_PROVIDER` feature (Round 127), so the env var
  was set in the container yet ignored by the old build. Round 127's
  "pinned bing" pass had passed for the same reason (`auto` fallback also
  yields `bing`), not because the pin was proven.
- **Rebuilt the backend image and re-ran both pins** — `docker compose
  build backend`, then API-only browser E2E with `duckduckgo` and again
  with `bing`: both full 13-flow runs green with the strict assertion
  active, traces recording `provider=duckduckgo (expected duckduckgo)` and
  `provider=bing (expected bing)`; zero console/network/HTTP errors.
- **Docs** — e2e/README now warns that backend code changes require a
  `docker compose build backend` before browser E2E; this handoff +
  CHANGELOG. API-only report refreshed (final pass: pinned bing).

## Test status

- Backend unit: **16 suites / 328 tests passed** (unchanged this round —
  no source edits; image rebuild + E2E only). Lint/type clean at Round 127.
- Browser E2E: **API-only pinned passes 2/2 green** (duckduckgo + bing,
  full 13 flows each, strict assertion on).
- Full gate: Round 127's `verify --build --api-e2e` green result stands
  (no runtime code changed this round). Backend restored to enabled with
  `WEB_SEARCH_PROVIDER=auto`.

## Known issues / open tickets

- **Closed — deterministic web-search fixture**: both provider pins are now
  proven end-to-end in the browser (strict assertion), unit tests lock both
  paths offline, and the stale-image pitfall is documented in e2e/README.
- **Low — Brave captcha** once on datacenter IPs; other engines may still
  bot-wall. Bing RSS fallback observed healthy.

## Next round focus

1. **Re-run the enrolled-mode browser E2E on the rebuilt image** — the
   enabled (`auto`) run is the one browser report still from the
   pre-rebuild image; behavior is identical (auto DDG→Bing fallback), but a
   fresh run refreshes the enabled report and confirms the rebuilt image in
   the default mode (or declare the stale-image report acceptable and move
   on).
2. **Keep the gates current** — baselines: unit 16/328, API E2E 12/123,
   /agent 484 KB / 33.6 KB headroom; re-run `verify --build --api-e2e` and
   both browser E2E modes after the next runtime change.
