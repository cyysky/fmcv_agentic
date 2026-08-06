# ROUND 2 — 2026-08-06 (autonomous iteration round 2)

## What changed this round

- **agent session persistence** — chats (`/api/agent/sessions/*`) now persist to a
  new `agent_sessions` Postgres table. Create, every completed `converse` loop, and
  delete are mirrored to the DB (best-effort; failures logged and swallowed so the
  in-memory flow never breaks). `OnModuleInit` reloads persisted sessions into the
  session map, so history survives backend restarts.
- **tests for persistence** — unit 40 → 41 (create upsert, fresh service recovers
  via `onModuleInit`, delete removes the row); API E2E 44 → 45 (a real converse
  turn stores its user message in the DB row and delete drops it).
- **E2E artifact story** — the browser journey now asks the agent to write
  `round2.md` into its OWN agent folder via `write_own_file` instead of into the
  channel project, so channel delete fully prunes the channel workspace. The
  harness runs a best-effort `projectPrune` docker check and hard-fails on any
  leftover `browser-e2e-*` project folder.
- **workspace hygiene** — removed the last Round-1 leftover
  (`browser-e2e-msgw1h1r` project folder); a browser run now leaves zero channel
  project residue.
- **live proof** — rebuilt the backend container, created a session, ran a real
  LLM converse, restarted the container, and re-read the session: history intact.
  Live delete then removed the DB row (verified via psql).

## Test status

- Unit: **41 passed / 7 suites** (was 40).
- API E2E: **45 passed / 4 suites** (was 44).
- Frontend: `tsc --noEmit` clean, `eslint` clean (0 errors).
- Backend: `npm run build` clean.
- Browser E2E (real Chrome over CDP): all route checks + channel journey pass
  (`answer` terminal), zero console/network errors, cleanup `deleted`,
  `projectPrune.ok: true`.

## Known issues / open tickets

1. **No deterministic LLM stub** — API/channel E2E agent turns still call the live
   gateway (`http://60.51.17.97:9999/v1`); a stub mode would make the suites
   hermetic and runnable offline.
2. **Sessions not surfaced in the UI** — `/api/agent/sessions*` is solid, but the
   `/agent` UI is channels-only; persisted chats have no frontend entry point yet.
3. **No auth** — the API is open (no API key / login). Fine for local dev; known
   gap before any deployment.
4. **Fire-and-forget session writes** — the very last turn of a conversation can be
   lost if the process hard-crashes mid-loop (matches the `channel_runs` pattern;
   acceptable and noted in tests).
5. **E2E harness env-dependency** — `projectPrune` needs `docker` + the
   `fmcv-backend` container (skipped cleanly when absent); CDP tab-close
   occasionally logs a non-fatal `Target is closing` warning; the journey leaves
   `round2.md` in the coder agent folder (overwritten every run, by design).

## Next round focus (ordered by value)

1. Deterministic LLM stub mode (env var) so API/channel E2E runs without the
   external model gateway.
2. Surface persisted sessions in the frontend agent UI (sidebar list, open /
   continue a chat via `POST /api/agent/sessions/:id/converse`).
3. API hardening: a request token / restricted unauthenticated mutations before
   any deployment.
