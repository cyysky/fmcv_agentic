# Round 125 — web-search fallback locked into E2E; agent-cron jobs proven in /cron UI (2026-08-09)

Previous focus (Round 124's "Next round focus"): make the DDG-blocked
web-search fallback assertable in the webtools journey (ideally with a
deterministic fixture), prove an agent-created cron job appears in the /cron
UI with run history, and keep the gates current.

## What changed this round

- **Webtools journey asserts the live search provider** (`ff1bfea`) — the
  expanded tool-trace body is scanned for `provider: "duckduckgo"` or
  `provider: "bing"` and the run fails if neither appears. First live run
  exercised the fallback for real: DDG bot-blocked the datacenter IP and the
  journey recorded `provider=bing` through the CDP path in both browser E2E
  modes.
- **Agent-cron journey proves /cron UI visibility** (`ff1bfea`) — the agent
  run now does a 7-step loop: list, create, update, run-now (quote result),
  delete the first job, then create + run-now a second job it leaves behind
  (annual schedule so it never fires on its own). The journey then drives
  `/cron` in real Chrome and asserts the agent-created row shows a terminal
  status (`Done`) with run history containing the nested "cron e2e ok"
  message, before deleting it via the API and confirming it is gone. Works
  in both enabled and API-only modes.
- **E2E stale sweep robustness** (`ff1bfea`) — an aborted run leaves a parent
  channel plus its `-coder` sub-channel; the sweep deletes sub-channels
  first (tolerating 404s) so the parent cascade can't 404 a stale snapshot
  row and break the run.
- **Docs** — CHANGELOG Round 125, README journey note, e2e/README journey
  descriptions; browser E2E reports refreshed (enabled + API-only).

## Test status

- Backend unit: **16 suites / 325 tests passed**; lint + type checks clean.
- Full gate `node scripts/verify.mjs --build --api-e2e`: **green** (REST
  docs + test-count guards, `nest build`, `next build`, bundle + headroom
  guards — /agent 484 KB / 33.6 KB headroom; API E2E 12 suites / 123 tests;
  backend flipped to API-only and restored to enabled).
- Browser E2E: **2/2 modes green** (complete enabled + API-only runs; every
  journey including the extended webtools + agentcron; zero console/network/
  HTTP errors; stale sweep clean in both).

## Known issues / open tickets

- **Low — deterministic web-search E2E fixture** — live DDG decides which
  provider the browser journey records (`bing` observed, fallback proven);
  unit tests already lock both providers deterministically via FakeWebSocket,
  but the browser journey is still hitting the live web. An offline
  fixture/override would make the E2E fully deterministic; not built this
  round because live tracking with provider assertion is the meaningful
  signal (see next focus).
- **Low — Jest keep-alive warning** after unit/API E2E runs; suites still
  exit 0.
- **Low — Brave captcha** once on datacenter IPs; other engines may still
  bot-wall. Bing RSS fallback observed healthy.

## Next round focus

1. **Deterministic browser web-search fixture (optional hardening)** —
   decide whether the webtools journey should force a provider via a
   `WEB_SEARCH_PROVIDER` env override (or a fake CDP target) so both
   `duckduckgo` and `bing` paths run offline, or declare live-provider
   tracking sufficient and close the ticket.
2. **Quiet the Jest keep-alive warning** — run unit/API E2E with
   `--detectOpenHandles` and stop the lingering async handle (likely a
   keep-alive agent/ws client in a spec), so suites exit cleanly.
3. **Keep the gates current** — re-run `verify --build --api-e2e` + both
   browser E2E modes after the next runtime change (baselines: unit 16/325,
   API E2E 12/123, /agent 484 KB / 33.6 KB headroom).
