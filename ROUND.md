# Round 127 — deterministic web-search provider pin (2026-08-09)

Previous focus (Round 126's "Next round focus" #1): implement a
`WEB_SEARCH_PROVIDER` override so the webtools E2E journey no longer
depends on live DuckDuckGo bot-wall behavior, then re-run both browser E2E
modes and the full gate.

## What changed this round

- **`WEB_SEARCH_PROVIDER` override in `WebService`** — `auto` (default)
  keeps DDG-first with the Bing RSS fallback; `duckduckgo` or `bing` pins
  exactly one provider with no silent retry, so the tool-trace
  `provider` field is deterministic regardless of bot-wall behavior.
  Exposed on the backend service in `docker-compose.yml`
  (`WEB_SEARCH_PROVIDER=${WEB_SEARCH_PROVIDER:-auto}`).
- **3 new unit tests** (web.service.spec.ts, 325 -> 328) — forced `bing`
  never contacts DDG (one tab); forced `duckduckgo` keeps a bot-walled DDG
  outcome without retrying (one tab); an unknown value degrades to `auto`
  and still falls back DDG→Bing (two tabs). Both pinned paths are now
  deterministic offline.
- **Strict journey pin** — `E2E_EXPECT_SEARCH_PROVIDER=duckduckgo|bing`
  makes the webtools browser journey fail unless the trace recorded exactly
  that provider; documented in e2e/README with the backend pairing command.
- **Reports refreshed** — enabled + API-only browser E2E JSON reports
  committed.

## Test status

- Backend unit: **16 suites / 328 tests passed**; lint + type checks clean.
- Full gate `node scripts/verify.mjs --build --api-e2e`: **green** — API
  E2E 12 suites / 123 tests exit cleanly, REST docs + test-count guards,
  `/agent` 484 KB / 33.6 KB headroom, backend flipped to API-only for E2E
  and restored to enabled.
- Browser E2E **2/2 modes green** — enabled on `auto`: full 13 flows, zero
  console/network/HTTP errors, webtools recorded `provider=bing` (DDG
  bot-walled live, fallback fired); API-only with
  `WEB_SEARCH_PROVIDER=bing` + `E2E_EXPECT_SEARCH_PROVIDER=bing`: full 13
  flows, zero errors, webtools recorded `provider=bing (expected bing)`.

## Known issues / open tickets

- **Closed — deterministic web-search fixture** — provider choice is now
  pinable + strictly asserted in the browser journey; unit tests lock both
  pinned paths offline. A pinned-`duckduckgo` browser pass was not run
  (it would record live bot-wall text with `provider=duckduckgo`); it is
  optional because the assertion is identical and the DDG path is
  unit-locked (see next focus).
- **Low — Brave captcha** once on datacenter IPs; other engines may still
  bot-wall. Bing RSS fallback observed healthy.

## Next round focus

1. **Optional: pinned-DDG browser pass** — run the webtools journey once
   with `WEB_SEARCH_PROVIDER=duckduckgo` +
   `E2E_EXPECT_SEARCH_PROVIDER=duckduckgo` to prove the forced DDG path
   through real Chrome (live bot-wall text expected; the assertion is the
   provider pin), refresh the API-only report, or close the ticket as fully
   covered by the unit suite + forced-Bing browser pass.
2. **Keep the gates current** — baselines: unit 16/328, API E2E 12/123,
   /agent 484 KB / 33.6 KB headroom; re-run `verify --build --api-e2e` and
   both browser E2E modes after the next runtime change.
