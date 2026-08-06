# ROUND 5 — 2026-08-06 (autonomous iteration round 5)

## What changed this round

- **Optional bearer-token gate** — the backend accepts a new `API_TOKEN` env
  var: when set, every request must carry `Authorization: Bearer <token>`
  (constant-time compare, else `401 Unauthorized`); when empty/unset the API
  is fully open (fail-open local dev, browser E2E unaffected).
- **Frontend token forwarding** — new `frontend/lib/api.ts` (`apiFetch`)
  reads `NEXT_PUBLIC_API_URL`/`NEXT_PUBLIC_API_TOKEN` and adds the bearer
  header when configured; the agent and settings clients now use it.
- **Compose/Docker wiring** — `docker-compose.yml` + frontend `Dockerfile`
  plumb `API_TOKEN` and `NEXT_PUBLIC_API_TOKEN` through with empty defaults.
- **E2E harness fix (suite-count bug)** — `bootstrapApp` moved from
  `app.e2e-spec.ts` into a shared `test/test-app.ts`. Importing it from the
  other four suites used to re-register app's 5 tests inside every importing
  suite, silently inflating totals (4 suites → 46, 5 suites → 54). Counts now
  equal the declared tests exactly.
- **New coverage** — `ApiTokenGuard` unit specs (3) + `auth.e2e-spec.ts`
  (reject anonymous/wrong-token with 401, accept correct token for reads and
  mutations).

## Test status

- Unit: **45 passed / 8 suites** (was 42/7; +3 guard specs).
- API E2E: **34 passed / 5 suites** — app 5, connections 4, agent 10,
  channels 12, auth 3; each matches the source `it()` count (verified file by
  file after the harness fix).
- Frontend: `tsc --noEmit` clean, `eslint` clean.
- Backend: `npm run build` clean.
- Browser E2E (real Chrome over CDP, live model): `/`, `/settings`, `/agent`
  route checks plus the channel journey and the sessions journey all green
  with zero console/network errors; `e2e/report.json` + screenshots refreshed.
- Live API-token proof (docker, `API_TOKEN` set to a throwaway dev-only literal):
  `/api/agent/models` → 401 without header, 401 with a wrong bearer, 200 with
  the correct bearer. Rebuilt without the var → 200 without header (fail-open).
  Containers were left in the fail-open state.

## Known issues / open tickets

1. **E2E harness portability** — `projectPrune` still needs `docker` (skipped
   cleanly when absent); the CDP tab-close still logs a non-fatal
   `Target is closing` warning at the end of every browser run.
2. **Session naming** — new sessions are titled "New session"; there is no
   rename affordance yet (cosmetic).
3. **Deployment hardening (by design)** — `NEXT_PUBLIC_API_TOKEN` is baked
   into browser JS, so it is not a secret; it only gates the deployed API
   against casual anonymous use. Real user auth/rate limiting is still a
   pre-deployment item.

## Next round focus (ordered by value)

1. E2E harness portability: drop the docker dependency for the prune check and
   silence the non-fatal CDP `Target is closing` tab-close warnings.
2. Session naming: rename sessions from the UI/sidebar and refresh titles.
3. Looping audit: once 1–2 land, re-run the exit audit (empty next focus /
   degenerate guard) before opening anything new.
