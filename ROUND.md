# ROUND 50 — 2026-08-08 (autonomous iteration round 50)

Human direction (DIRECTION.md item 1): **mobile view improvement** — the
main user journeys (channel dashboard, member panel, files, buckets, cron,
skills, HTML view) must work well on small screens. The 360×640 CDP audit
found one real breakage: the channel dashboard rendered as a clipped
~876px-wide flex row, pushing the member/project panels off-screen. Files,
buckets, cron, skills, settings, and home already had no horizontal
overflow; cron/skills forms are inline and page-scrollable.

## What changed this round

- **Mobile channel dashboard fix** — `frontend/app/agent/agent.module.css`
  stacks `.channels` into a column at ≤760px: the sidebar caps at 30vh, the
  conversation keeps a 38vh minimum, the member/project column caps at 42vh,
  and message labels wrap with full-width timestamps. The member panel and
  its debug pane are reachable by scrolling the column on a 360×640 phone
  (previously clipped behind the ~876px-wide flex row).
- **New browser E2E journey** — `e2e/browser-e2e.mjs` opens `/agent` at
  360×640, creates a fixture channel, opens the dashboard, asserts the
  stacked layout (no horizontal overflow; sidebar/conversation/rightCol all
  in-viewport at ~340px wide), clicks a member row to open the debug pane,
  and re-checks overflow; screenshots `agent-channels-mobile.png` and
  `agent-channels-member-mobile.png`; the fixture channel + project folder
  are deleted and verified. Wired into the report and the exit gate.
- **Docs** — README responsive + browser-E2E bullets, `e2e/README.md`
  (new journey, screenshots, gate wording), and CHANGELOG.md updated;
  `e2e/report.json` + screenshots refreshed against the passing run.

## Test status

- Backend unit: **146 passed / 14 suites**; API E2E: **107 passed / 10
  suites**; backend lint (no `--fix`) + `nest build` + `npx tsc --noEmit`
  clean.
- Frontend lint + `npx tsc --noEmit` + `next build` clean (the frontend
  container was rebuilt and restarted with the CSS change).
- Browser E2E: exit 0 — 21 route probes plus the channel, sessions/
  connection, files, HTML view/new-tab, buckets, cron, skills, settings, and
  new mobile channel-dashboard journeys, zero console/network errors;
  fixtures cleaned to baseline afterwards (`cleanup: deleted
  +project-folder-clean`).
- Live smoke: frontend `/` 200; API origin `/api`, `/api/buckets`,
  `/api/cron`, `/api/skills` all 200.
- Baseline confirmed after the run: buckets=0, managed_documents=0,
  cron_jobs=0, skills=0, agent_sessions=0, connections=0, channels=2
  defaults; no `browser-e2e-*` / `round2.md` / `mobile-audit*` leftovers in
  the coder workspace or project folders.

## Known issues / open tickets

- **None open for the mobile direction.** Accepted limitations unchanged:
  CSP `sandbox` disables scripts/forms/external navigation in the inline
  HTML preview; the cron scheduler ticker runs in-process (cron rows and
  run results persist in Postgres; single-instance deployment assumed);
  buckets are read-only by design (no delete/rename endpoints);
  `AGENT_API_KEY` is not committed (fresh stacks must supply it or use
  `AGENT_LLM_STUB=1`).
- Recoverable leftovers (untouched, outside loop fixture scope): retired
  dev folders under `/data/.trash-round34` (backend container) and old dev
  scratch files in the `coder` agent workspace remain until a human asks
  for them to be pruned.
- The earlier docs-only "Round 49 verification" commit `40a51a4` was
  superseded by this round's mobile work; `round-49` still points at it and
  this round is tagged `round-50`.

## Next round focus

- **None.** Exit condition C holds: "Next round focus" is empty, no tickets
  remain open, and the accepted limitations are by-design constraints or
  need human direction (prune trash/scratch files, revisit CSP sandbox
  preview, multi-instance cron scaling).

## Loop state

Loop state: finished — exit condition C met; the DIRECTION.md mobile item is
verified end to end (CSS fix + browser E2E + docs). Do not start another
round unless the human updates `DIRECTION.md` or asks for the prunable
leftovers to be removed.
