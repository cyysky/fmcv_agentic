# ROUND 42 — 2026-08-08 (autonomous iteration round 42)

User instruction: generic loop prompt ("read on loop.md and do works") after
round 41 declared the loop finished. This round verified the finished state
still holds and found one genuine, previously-missed defect in the handoff
docs: the accepted-limitations entries claimed skills install state was
in-memory per backend instance, when skills have been Postgres-backed since
their introduction. DIRECTION.md items 1-4 remain completed and in effect.

## What changed this round

- **Restart-persistence E2E tests** — `backend/test/cron.e2e-spec.ts` and
  `backend/test/skills.e2e-spec.ts` now boot a second app instance against
  the same Postgres and prove: an installed skill (name, description,
  content, `installed` flag) survives a backend restart, and a cron job
  (schedule, prompt, `enabled`, recomputed `nextRunAt`) is restored on boot.
  API E2E 105 -> 107 tests.
- **Stale persistence docs corrected** — removed 10 "in-memory skills
  install state" claims scattered across CHANGELOG accepted-limitations
  sections (rounds 25-41). The accurate contract: cron/skills rows persist
  in Postgres; only the cron *scheduler ticker* runs in-process
  (single-instance deployment assumed). README test matrix updated to 107
  API E2E tests (cron 12 -> 13, skills 10 -> 11).
- **Browser E2E artifacts refreshed** against the clean green gate
  (`e2e/report.json` + screenshots, exit 0).

## Test status

- Backend unit: **146 passed / 14 suites**; API E2E: **107 passed / 10
  suites**; backend lint + `nest build` + `npx tsc --noEmit` clean.
- Frontend lint + `npx tsc --noEmit` + `npm run build` clean (unchanged).
- Browser E2E: exit 0 (21 route probes, all flows, zero
  console/network/HTTP errors; fixtures cleaned to baseline).
- Live smoke: `/` (frontend), `/api/buckets`, `/api/cron`, `/api/skills`
  all 200; git status clean before this round's changes.

## Known issues / open tickets

- **None open.** Accepted limitations unchanged and now stated accurately:
  CSP `sandbox` disables scripts/forms/external navigation in the inline
  HTML preview; the cron scheduler ticker runs in-process (cron rows and
  their run results persist in Postgres; single-instance deployment
  assumed); buckets are read-only by design (no delete/rename endpoints);
  `AGENT_API_KEY` is not committed (fresh stacks must supply it or use
  `AGENT_LLM_STUB=1`).
- Recoverable leftovers (untouched, outside loop fixture scope): retired
  dev folders under `/data/.trash-round34` (backend container) and old dev
  scratch files in the `coder` agent workspace remain until a human asks
  for them to be pruned.

## Next round focus

- **None.** Exit conditions C and D hold: "Next round focus" is empty, no
  tickets remain open, and no net-valuable improvement is evident — the
  remaining accepted limitations are by-design constraints or need human
  direction (prune trash/scratch files, revisit CSP sandbox preview,
  multi-instance cron scaling).

## Loop state

Loop state: finished — exit conditions C and D met; do not start another
round unless the human updates `DIRECTION.md` with new direction or asks
for the prunable leftovers to be removed.
