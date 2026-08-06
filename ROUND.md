# ROUND 1 — 2026-08-06 (autonomous iteration round 1)

## What changed this round

- **job history persistence** — streaming channel jobs now persist to a new
  `channel_runs` Postgres table (create + every terminal state); job polling
  and member-status read live memory first and fall back to the persisted
  history, so debug panes survive backend restarts.
- **restart recovery** — runs still `running` when the process died are marked
  `stopped` on boot with one explicit "Backend restarted; run interrupted."
  event instead of spinning forever or 404-ing.
- **channel delete race closed** — `DELETE /api/channels/:id` now reserves the
  channel tree (begin/end guard) before stopping jobs; new jobs for a channel
  mid-delete are rejected with 400 instead of slipping between stop and row
  removal.
- **browser E2E self-cleanup** — the CDP flow deletes the channel it creates
  after the journey and verifies the row is gone (repeat runs no longer litter
  the database).
- **browser E2E gate** — a real terminal `[error]` (agent tool-loop failed) is
  no longer a hard browser failure; must-reach-terminal, console/network
  errors, and HTTP>=400 still hard-fail the run.
- `.gitignore` — `vision_test.png` (generated vision snapshot) is ignored;
  removed the 11 leftover `browser-e2e-msg*` channels + folders from prior
  runs of the live workspace.

## Test status

- Unit: 40 passed / 7 suites (was 37) — added delete-guard, restart-recovery,
  and persistence-upsert tests.
- API E2E: 44 passed / 4 suites (was 43) — new test drives a real streaming
  job to terminal, asserts the DB row matches, and that channel delete
  cascade-prunes `channel_runs`.
- Frontend: `tsc --noEmit` clean, `eslint` clean (0 errors).
- Backend: `npm run build` clean.
- Browser E2E (real Chrome over CDP): all route checks + channel journey pass,
  zero console/network errors, cleanup reported `deleted`. Chrome itself was
  started fresh for this round (the user's CDP instance was not running);
  headless Chrome remains attached on 9222.

## Known issues / open tickets

1. **E2E-created artifact folders linger by design** — the journey agent writes
   `hello_round.md` into the channel project, so delete leaves the non-empty
   folder (`removeProjectIfEmpty` intentionally preserves artifacts). The
   channel row is gone; the folder remains. Decide whether to change the
   journey to write into the agent's own folder so delete fully prunes.
2. **In-memory sessions** — agent sessions are still process-only; a backend
   restart loses chat sessions (ticketed in earlier rounds, not yet fixed).
3. **Workflow gating** — channel runs invoke the real LLM; there is no dry-run /
   mock provider mode for repeatable agent behavior tests (only unit-level
   mocks).
4. **No auth** — the API is open (no API key / login). Fine for local dev, but
   it is a known gap before this is deployed anywhere.

## Next round focus (ordered by value)

1. Persist agent sessions (chats) to Postgres with the same restart-recovery
   pattern used for `channel_runs` in this round.
2. Make the workspace/artifact story explicit: decide whether E2E should write
   into the agent's own folder (so channel delete fully prunes) or keep the
   preserved-artifact behavior and surface it in the E2E report.
3. Add a deterministic LLM stub mode (env var) so channel/API E2E can run
   without the external model gateway.
