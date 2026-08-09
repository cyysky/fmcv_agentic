# Round 126 — Jest keep-alive warning fixed at the root (2026-08-09)

Previous focus (Round 125's "Next round focus" #2): quiet the Jest
"did not exit one second after the test run" warning in the unit/API E2E
suites and keep the gates current.

## What changed this round

- **Root-caused and fixed the keep-alive warning** — the `cron-disabled`
  and `cron-multireplica` E2E specs cleaned up cron scheduler lease/event
  rows via `prisma.$executeRaw` *after* `app.close()` had already
  disconnected the shared Prisma pool. Those raw queries silently reopened
  a Postgres pool that nothing ever closed, leaving live sockets for a few
  seconds past the last test — precisely the window Jest's one-second exit
  grace trips on. Both afterAll hooks now `$disconnect()` after the raw
  cleanups (see the comments in
  `backend/test/cron-disabled.e2e-spec.ts` and
  `backend/test/cron-multireplica.e2e-spec.ts`).
- **Diagnosis trail** — bisected with `--runTestsByPath` pairs, per-file
  active-handle dumps (`process._getActiveHandles`), and a repro probe that
  showed 3 lingering `Socket`s after the post-close reopen. `undici`
  keep-alive override and `--detectOpenHandles`/`--forceExit` were tried
  and rejected; the suite now exits on its own, no flags needed.
- **Docs** — CHANGELOG Round 126; this handoff.

## Test status

- Backend unit: **16 suites / 325 tests passed**; lint + type checks clean.
- Full gate `node scripts/verify.mjs --build --api-e2e`: **green** — API
  E2E 12 suites / 123 tests with **no exit warning across repeated runs**,
  REST docs + test-count guards, `/agent` 484 KB / 33.6 KB headroom;
  backend flipped to API-only for E2E and restored to enabled.
- Browser E2E: **not re-run** — this round touched test infrastructure
  only, no runtime code; Round 125's 2/2 green browser runs stand.

## Known issues / open tickets

- **Low — deterministic web-search E2E fixture** — the webtools browser
  journey still asserts whichever live provider fires (`duckduckgo` or
  `bing`) instead of forcing one offline; unit tests cover both providers
  deterministically. Decision + build next round.
- **Low — Brave captcha** once on datacenter IPs; other engines may still
  bot-wall. Bing RSS fallback observed healthy.

## Next round focus

1. **Deterministic browser web-search fixture** — implement a
   `WEB_SEARCH_PROVIDER` env override (`auto` | `duckduckgo` | `bing`) in
   `WebService` and have the webtools journey run both forced providers
   (or at least one deterministic pass) so the E2E no longer depends on
   live DDG behavior; assert both tool-trace providers offline.
2. **Re-run both browser E2E modes** after that runtime change
   (`CHROME_DEBUG_PORT=9223 node e2e/browser-e2e.mjs` enabled +
   API-only), then refresh reports and re-run `verify --build --api-e2e`.
3. **Keep the gates current** — baselines: unit 16/325, API E2E 12/123,
   /agent 484 KB / 33.6 KB headroom.
