# ROUND 3 — 2026-08-06 (autonomous iteration round 3)

## What changed this round

- **deterministic LLM stub mode** — new `AGENT_LLM_STUB=1` env switch
  short-circuits `callModel` with a stable `[stub] <last user message>` answer
  (no network, no API key). Agent turns and channel jobs terminate in zero tool
  steps, deterministically.
- **hermetic API E2E suite** — `e2e-setup.ts` now defaults `AGENT_LLM_STUB=1`,
  so all 4 API suites run without the live gateway (suite time dropped from
  ~9s to ~2.8s); the browser E2E keeps exercising the real model (compose does
  not set the stub var).
- **coverage** — new unit test covers stub `runTurn` + `converse` deterministic
  answers; new API E2E asserts a converse returns a `[stub]` answer with zero
  steps.
- **README** — new "Agent environment" section documents `AGENT_BASE_URL`,
  `AGENT_DEFAULT_MODEL`, `AGENT_API_KEY`, and `AGENT_LLM_STUB`.

## Test status

- Unit: **42 passed / 7 suites** (was 41).
- API E2E: **46 passed / 4 suites** (was 45), now gateway-independent.
- Frontend: `tsc --noEmit` clean, `eslint` clean (0 errors).
- Backend: `npm run build` clean.
- Browser E2E (real Chrome over CDP, live model): all route checks + channel
  journey pass (`answer`), zero console/network errors, cleanup `deleted`,
  `projectPrune.ok: true`.

## Known issues / open tickets

1. **Sessions not surfaced in the UI** — `/api/agent/sessions*` works, but the
   `/agent` UI is channels-only; persisted chats have no frontend entry point.
2. **No auth** — the API is open (no API key / login). Fine for local dev;
   known gap before any deployment.
3. **Fire-and-forget session writes** — the very last turn can be lost if the
   process hard-crashes mid-loop (matches the `channel_runs` pattern;
   acceptable and noted in tests).
4. **E2E harness env-dependency** — `projectPrune` needs `docker` + the
   `fmcv-backend` container (skipped cleanly when absent); CDP tab-close
   occasionally logs a non-fatal `Target is closing` warning; the journey
   leaves `round2.md` in the coder agent folder (overwritten every run).

## Next round focus (ordered by value)

1. Surface persisted sessions in the frontend agent UI: session sidebar fed by
   `GET /api/agent/sessions`, open/continue via
   `POST /api/agent/sessions/:id/converse`, delete; verify across a backend
   restart.
2. API hardening: a request token / restricted unauthenticated mutations
   before any deployment.
3. E2E harness portability: drop the docker dependency for the prune check and
   silence the non-fatal CDP tab-close warnings.
