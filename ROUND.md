# Round 122 — CDP-first web tools finally reach the compiled backend (2026-08-09)

Previous focus (Round 121's "Next round focus"): make CDP reachable from
the compose backend, manually use-walk the agent web tools through the
/agent UI, and keep the gates current. The use-walk found a regression
that meant Round 121's web + skill tools were **never actually wired in
the compiled runtime** — now fixed and proven end-to-end.

## What changed this round

- **CDP reachable from the compose backend** (`b345981`) — new
  `scripts/cdp-relay.mjs` binds 0.0.0.0:9222 and forwards CDP HTTP +
  WebSocket traffic to host Chrome on 127.0.0.1:9223 with a `Host`
  rewrite; fixed the CDP client to read `result.value` from
  `Runtime.evaluate` (was `res.value`).
- **Fixed agent DI regression** (`0f753c8`) — `import type` on
  `SkillsService`/`WebService` erased Nest DI metadata (constructor
  params became `Function`), so `@Optional()` injected `undefined` and
  `fetch_url`/`web_search`/skill tools never registered at runtime.
  Runtime imports restore all 15 tools in the compiled container.
- **Webtools browser E2E journey** (`0f753c8`) — drives `fetch_url` +
  `web_search` through a real /agent channel UI and asserts both live
  tool traces show `via: "cdp"` plus the "Example Domain" title.
- **Docs** — README + e2e/README.md document the Chrome-9223 +
  relay setup, compose comment updated, CHANGELOG Round 122 entry.

## Test status

- Backend unit: **16 suites / 323 tests passed**; `tsc` clean.
- Full gate `node scripts/verify.mjs --build --api-e2e`: **green**
  (lint + builds, bundle guards, API E2E 12 suites / 123 tests, backend
  flipped to API-only and restored to enabled).
- Browser E2E: **2/2 modes green** after the backend rebuild
  (`CHROME_DEBUG_PORT=9223 node e2e/browser-e2e.mjs` + API-only run with
  `CRON_SCHEDULER_ENABLED=false`, then backend restored); zero
  console/network/HTTP errors; webtools journey green and reports
  refreshed.

## Known issues / open tickets

- **Low — DuckDuckGo bot-block.** `web_search` over CDP hits DDG's
  "select all squares containing a duck" challenge from this IP. The
  agent fell back to Bing RSS and returned real results, but DDG-first
  search is flaky. Options: switch default search to Bing RSS, add a
  search-provider queue, or note that DDG is rate-limited per IP.
- **Low — Jest keep-alive warning** after unit/API E2E runs; suites
  still exit 0.

## Next round focus

1. **Verify skill tools end-to-end** — now that DI is fixed, walk
   `list/create/read/update/delete_skill` through a live /agent channel
   (like the webtools journey) and add E2E coverage if it does not
   already exist.
2. **Search-provider robustness** — replace/augment the DDG-first
   `web_search` with a fallback queue (e.g. Bing RSS first or on DDG
   bot-block) so a search gets real results in one call.
3. **Keep the gates current** — re-run `verify --build --api-e2e` +
   both browser E2E modes after the next runtime change (baselines:
   unit 16 suites / 323, API E2E 12 / 123, /agent 484 KB /
   33.6 KB headroom).
