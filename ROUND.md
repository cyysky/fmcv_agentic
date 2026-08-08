# Round 103 — CI idea closed (scope blocker) + README progress pointer (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
re-attempted the CI push exactly once per Round 102's plan, hit the same
PAT scope rejection, and closed the CI idea as pending human action rather
than retrying every round. It also fixed a stale README section so new
readers can find the real round history.

## What changed this round

- **CI push re-attempted and closed (needs human action)** — pushing the
  authored workflow branch was rejected again with the identical GitHub
  error (`refusing to allow a Personal Access Token ... without workflow
  scope`). The stored PAT cannot create/update `.github/workflows/*`; only a
  human with a `workflow`-scoped PAT can change that. Until DIRECTION.md
  says a scoped token is available, this idea is closed and will not
  consume future rounds. Work preserved locally on branch `ci-verify`
  (commit `30b789e`, including the README/ROUND snapshots of that attempt).
- **README Progress section un-staled** — the `## Progress (from git
  history)` timeline ended at Round 22 while the repo is at Round 102. Added
  a pointer that Rounds 23+ live in `ROUND.md` + git tags `round-N`, with a
  one-line summary of the Rounds 93–102 bundle/polling work, so the
  section can no longer mislead about the timeline.

## Test status

- Fast verify `verify.mjs`: green on the final tree — REST docs guard
  (70 routes / 69 rows), test-count guard, backend unit **14 suites / 182
  tests passed**, backend lint + types, frontend types + lint.
- Full build gate not re-run (no code change): Round 100's
  `verify --build --api-e2e` remains green — API E2E 12/123, bundle
  `/agent` 484 KB / 8 chunks, headroom 33.6 KB within 44 KB.
- Browser E2E: not re-run (no frontend runtime change); Round 100 enabled +
  api-only runs (21 route probes each, zero console/network errors) remain
  current.

## Known issues / open tickets

- **Low** — Jest API e2e keep-alive warning after the multi-replica suite;
  suites exit 0.
- **Low** — `e2e/report.json` mirrors only the latest run; per-mode
  archives live in git history (by design).
- **Closed this round** — the CI push attempt (blocked by PAT scope;
  reopens only if a human supplies a `workflow`-scoped PAT, preserved as
  local branch `ci-verify`).

## Next round focus

1. **Look for the next genuinely valuable improvement** — the round-102/103
   CI item is closed pending human action; do not re-attempt it. Prefer a
   user-visible or test-visible improvement (bug, friction, or new
   coverage) over more docs-only rounds.
2. **Keep the gates current** — re-run `verify --build --api-e2e` + both
   browser modes after any frontend change; /agent baseline stays 484 KB /
   33.6 KB headroom.
3. **Profile only when a feature threatens the 44 KB `/agent` headroom
   budget** — currently 33.6 KB used, no routine action needed.
