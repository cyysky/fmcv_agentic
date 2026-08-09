# Round 121 — agents get web tools, skill CRUD, native NestJS cron, dialog fix (2026-08-09)

Human direction (DIRECTION.md): five items — agent internet access, agent
skill management, native NestJS cronjobs (no system cron), CDP-9222-first
web browsing with fallback, and a fix for the blocked add-new-channel
dialog. All five are implemented, verified, and committed.

## What changed this round

- **Agent internet access** — `fetch_url` + `web_search` tools registered on
  the base agent (`07e1bd8` onwards; web service commit `9c40403`).
- **CDP-first browsing** — web tools try the local Chrome DevTools Protocol
  on port 9222 first (`WebSocket` + `/json/new` + `Runtime.evaluate`), then
  fall back to native Node `fetch` with markup stripping; caps on timeout /
  result size; compose exposes `WEB_CDP_HOST`/`WEB_CDP_PORT` defaults via
  `host.docker.internal:host-gateway`.
- **Agent skill management** — `list_skills`, `create_skill`,
  `update_skill`, `delete_skill` tools (plus existing `read_skill`) with the
  same slug-name/content validation as the skills API (`640c72c`).
- **Native NestJS cronjobs** — manual `setInterval` replaced with
  `@nestjs/schedule` `@Interval` (`ScheduleModule.forRoot()`), still
  lease-gated and atomic; agent cron tools (`list/create/update/delete/
  run-now`) registered from the loop (`07e1bd8`).
- **Bug fix: add-new-channel dialog blocked** — the modal overlay was
  rendered unconditionally in `agent-views.tsx`; it is now gated on
  `showNew`, threaded through `agent-client.tsx` state + context, and the
  browser E2E asserts the dialog is closed on tab open and opens on click
  (`e5f1fd7`).
- **Cron lease failover fix** (`f77a8d3`) — `CronService.onModuleDestroy()`
  now stops the native `@nestjs/schedule` tick interval via the
  `SchedulerRegistry` (two new unit tests + multireplica API E2E proof); a
  dead replica stops renewing its lease so the standby actually takes over.
- **Docs** — README/CHANGELOG round-121 features + teardown note
  (`5be2e0f` + this round's doc update); refreshed browser E2E reports.

## Test status

- Backend unit: **16 suites / 323 tests passed**.
- API E2E: **12 suites / 123 tests passed** (incl. cron lease-failover
  takeover; ran against the rebuilt backend image, flipped to API-only and
  restored to enabled).
- Full gate `node scripts/verify.mjs --build --api-e2e`: **green** (REST
  docs + test-count guards, backend lint + `tsc`, frontend lint + `tsc`,
  `nest build` + `next build`, bundle-size /agent 484 KB ≤ 586 KB,
  agent-headroom 33.6 KB ≤ 44 KB, API E2E).
- Browser E2E: **2/2 modes green** against the rebuilt stack
  (`e2e/browser-e2e.mjs` enabled + `E2E_API_ONLY=1` api-only with
  `CRON_SCHEDULER_ENABLED=false`, then backend restored to enabled); zero
  console/network/HTTP errors in both reports.

## Known issues / open tickets

- **Low — CDP only reachable when Chrome is reachable by the backend.**
  The host Chrome on `127.0.0.1:9222` is not reachable from inside the
  fmcv-backend container (port binds loopback only; `host-gateway` maps to
  the Docker bridge, not to the host loopback). WebService logs the CDP
  failure and the HTTP fallback succeeds (smoke-verified). Fix options:
  launch Chrome with `--remote-debugging-address=0.0.0.0`, or point
  `WEB_CDP_HOST` at an interface the backend can reach.
- **Low — Jest keep-alive warning** after unit/API E2E runs; suites still
  exit 0.

## Next round focus

1. **Make CDP reachable from the compose backend** — restart the local
   Chrome with `--remote-debugging-address=0.0.0.0` (or expose a second
   bind) and re-verify the web tools take the CDP-first path, not the
   fallback, from inside the container.
2. **Manual “use” walk of agent web tools** — drive `fetch_url` /
   `web_search` through the /agent UI end-to-end and log any friction.
3. **Keep the gates current** — re-run `verify --build --api-e2e` + both
   browser E2E modes after the next runtime change (baselines: unit 16
   suites / 323, API E2E 12 / 123, /agent 484 KB / 33.6 KB headroom).
