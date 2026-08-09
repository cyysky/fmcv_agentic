# Round 123 — skill tools verified end-to-end; web search survives DDG bot-blocks (2026-08-09)

Previous focus (Round 122's "Next round focus"): verify the skill tools
through a live /agent channel, harden the search provider, and keep the
gates current. The skill walk surfaced and fixed a real `read_skill` bug;
both journeys are now committed browser E2E coverage.

## What changed this round

- **Fixed `read_skill` by id** (`7152a8e`) — the tool only accepted an
  installed-skill name, so the agent CRUD loop failed on
  "No installed skill named <id>". It now returns any authored skill by
  `id` (content included) or installed-skill instructions by `name`;
  verified live through the /agent channel.
- **`web_search` DDG → Bing RSS fallback** (`7152a8e`) — detects the DDG
  bot-challenge markers and retries the query on Bing's RSS endpoint,
  reporting `provider: "bing"`; proven live from inside the container
  (CDP-first, real headlines after the block).
- **Agent-skills browser E2E journey** (`7152a8e`) — drives
  list/create/read/update/delete_skill through a real /agent channel,
  asserts every tool row (with `readOk`), and verifies no leftover skill.
- **Docs** — e2e/README + README journey lists, CHANGELOG Round 123.

## Test status

- Backend unit: **16 suites / 325 tests passed**; `tsc` + prettier clean.
- Full gate `node scripts/verify.mjs --build --api-e2e`: **green**
  (lint + builds, bundle guards, API E2E 12 suites / 123 tests, backend
  flipped to API-only and restored to enabled).
- Browser E2E: **2/2 modes green** (enabled + API-only) with all journeys
  including the new agentskills + webtools; zero console/network/HTTP
  errors in both reports.

## Known issues / open tickets

- **Low — DDG bot-block is real from this IP.** No longer user-visible:
  the tool auto-falls back to Bing RSS. Watch for other bot walls (Brave
  served a captcha during the webtools walk; DDG/Bing/Brave rate-limit
  datacenter IPs).
- **Low — Jest keep-alive warning** after unit/API E2E runs; suites
  still exit 0.

## Next round focus

1. **Verify cron-agent tools through /agent** — the cron tool family
   (list/create/update/delete/run-now) still lacks a live channel-driven
   E2E journey like webtools/agentskills; add one (create a cron job via
   the agent, run-now, verify a `cronRun` row appears, delete it).
2. **Refresh stale docs/coverage after the DI fix** — Round 121's skill CRUD
   unit + API coverage was written against a registry that never loaded in
   the compiled backend; re-check the skill/API E2E docs match the now-real
   tool wiring.
3. **Keep the gates current** — re-run `verify --build --api-e2e` + both
   browser E2E modes after the next runtime change (baselines: unit 16
   suites / 325, API E2E 12 / 123, /agent 484 KB / 33.6 KB headroom).
