# ROUND 34 — 2026-08-08 (autonomous iteration round 34)

User instruction: **read on loop.md and do works**. `DIRECTION.md` items 1-4
(managed document buckets, cron jobs, agent skills, HTML view by link / new
tab) remain complete and verified on the live stack. Round 33 flagged the
aging dev leftovers as the only remaining continuation trigger, so this round
cleaned them up and fixed three real leaks that surfaced during the
verification + cleanup work.

## What changed this round

- **Session-reconciliation fix (backend)** — `BaseAgentService.listSessions()`
  and `deleteSession()` are now async and reconcile with persisted rows that
  exist in Postgres but not in the in-memory map: GET merges them in (DB
  failure degrades to the live list) and DELETE removes the row even when it
  was never loaded into memory, 404ing only when neither source has it.
  `sessionFromRow()` is shared with `onModuleInit()` so both paths map rows
  identically. Added unit test
  `'lists and deletes sessions persisted outside the live map'`.
- **E2E cleanup fixes (committed earlier this round: `793cf9b`, `1403644`)**
  — the channel journey's `round2.md` agent fixture is now deleted by cleanup
  (and asserted), and the `skill-aware e2e` sessions created by
  `skills.e2e-spec.ts` are deleted in a `finally` plus swept as a fixture
  prefix, so leaked rows can no longer resurrect invisible sessions.
- **Housekeeping** — stale dev project folders (`test-round`, `round-sandbox`,
  `round2-*`, `dbg-member-check`, `dm-coder`, `e2e-stream-test`, `myproject`)
  moved to a recoverable `/data/.trash-round34` inside the backend container;
  8 debug channels and 7 dev sessions deleted via the API; pre-cleanup DB
  backup kept at `logs/round34_precleanup_backup.sql` (gitignored).
- **Live-stack rebuild + smoke** — backend rebuilt with the fixes; an orphan
  session row inserted directly into Postgres appeared in
  `GET /api/agent/sessions` and `DELETE` returned 200 with the DB count back
  to 0. The rebuild also restored `AGENT_API_KEY` from the local session
  record (the key is deliberately not committed), un-401ing live LLM calls.
- **Docs + artifacts** — README unit count updated 145 → 146; browser E2E
  report + screenshots refreshed against the fixed stack.

## Test status

- Backend unit: **146 passed / 14 suites**.
- API E2E: **105 passed / 10 suites** (Postgres via compose).
- Backend `nest build` + `npx tsc --noEmit` + eslint clean; frontend
  `npm run lint` + `npx tsc --noEmit` + `npm run build` clean.
- Browser E2E **exit 0** — 21 route probes, all 9 journeys, zero
  console/network/HTTP errors; channel cleanup
  `deleted+agent-fixture-clean`, sessions cleanup deleted, `staleSweep`
  empty across channels/sessions/connections/project folders, and
  `projectPrune: ok` (only `fmcv` remains).
- Live DB/workspace fixture-clean after the run (sessions 0, connections 0,
  buckets 0, cron 0, skills 0; channels = `fmcv`/`fmcv-coder` only).

## Known issues / accepted limitations

- `/data/.trash-round34` (backend container) holds the retired dev folders
  until pruned; the pre-cleanup DB backup lives in gitignored `logs/`.
- Unchanged, by design: CSP `sandbox` disables scripts/forms/external
  navigation inside the inline HTML preview; scheduler runs in-process and
  skills install state is in-memory per backend instance (single-instance
  deployment assumed); buckets have no delete/rename endpoints.
- `AGENT_API_KEY` is not committed (by design); stacks started fresh must
  supply it (or use `AGENT_LLM_STUB=1`) or live LLM calls will 401.

## Next round focus

- **None.** Every remaining continuation trigger from Round 33 is now closed:
  the dev leftovers are in recoverable storage, both E2E leak paths are
  fixed with tests, and the full unit + API E2E + static + browser E2E gate
  is green on the rebuilt stack. Continue only if the human updates
  `DIRECTION.md`, reports new real-use friction, or asks for the trash to be
  pruned.
