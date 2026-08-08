# Round 110 — workspace service coverage to 100% lines (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 109's next-focus item 1: lifted `workspace.service.ts` from
80.48% to 100% lines (98.88% stmts / 93.93% branch / 100% funcs).

## What changed this round

- **`removeProjectIfEmpty` coverage** — missing folders count as cleanly
  absent; non-empty folders are kept both when a file artifact exists and
  when rmdir reports ENOTEMPTY/EEXIST; invalid names are rejected up front;
  other rmdir failures (EACCES) are rethrown untouched.
- **`getWorkspaceInfo` coverage** — snapshots root/projectsDir, all public
  project folder paths, and every named agent's label, description, root
  and workDir.
- **`readTree`/content-list helpers** — an unreadable folder degrades to an
  empty tree; `listProjectContent` and `listAgentContent` return the real
  tree; unknown agents 404 via `assertAgentName`; recursion stops with `{}`
  at `maxDepth` 0.
- **`readDirNames` fallback** — an unreadable `projects/` dir lists as
  empty instead of failing.
- **Constructor default** — when `AGENT_WORKSPACE_ROOT` config is absent,
  the service falls back to `/data/workspaces` exactly as documented.

## Test status

- Fast verify `verify.mjs`: green on the final tree — REST docs guard
  (70 routes / 69 rows), test-count guard, backend unit **14 suites / 239
  tests passed** (+8 this round), backend lint + types, frontend types +
  lint.
- Coverage run green: `workspace.service.ts` **80.48% → 100% lines**
  (98.88% stmts / 93.93% branch / 100% funcs); the two remaining uncovered
  statements are the nullish-fallback side of the constructor default and
  the `unable to resolve path` guard, which is unreachable whenever a root
  realpath exists (the only path into it loops at the filesystem root).
  `buckets.service.ts`, `files.service.ts`, `channel-job.service.ts` and
  `workspace-tools.ts` stay at 100% lines; `channel.service.ts` stays
  99.04% (dead `SLUG_RE` guard).
- Full build gate not re-run (test-only change, no runtime code touched):
  Round 100's `verify --build --api-e2e` remains green — API E2E 12/123,
  bundle `/agent` 484 KB / 8 chunks, headroom 33.6 KB within 44 KB.
- Browser E2E: not re-run (no frontend runtime change); Round 100 enabled +
  api-only runs (21 route probes each, zero console/network errors) remain
  current.

## Known issues / open tickets

- **Low** — Jest API e2e keep-alive warning after the multi-replica suite;
  suites exit 0.
- **Low** — `e2e/report.json` mirrors only the latest run; per-mode
  archives live in git history (by design).
- **Open** — `channel.service.ts` line 67 (`SLUG_RE` guard) is dead by
  construction; decide in a runtime round whether to delete it or keep it
  as defense-in-depth.
- **Open** — the `unable to resolve path` safeResolve guard (line 248) is
  unreachable by construction; keep it as the loop-termination proof in
  code or delete it in the same runtime cleanup round as the `SLUG_RE`
  guard.
- **Open** — remaining service coverage: `base-agent.service.ts` 74.92%
  lines (larger surface, runtime-critical), `connections.service.ts`
  87.27%, `cron.service.ts` 93.27%, `skills.service.ts` 95.45%.

## Next round focus

1. **Cover `connections.service.ts`** — smallest practical next target at
  87.27% lines (uncovered: 63-74, 83, 87, 91, 96, 107-109, 338); extend
  `connections.service.spec.ts` and re-run fast verify + coverage.
2. **Decide the dead-guard cleanup bundle** — remove/keep `SLUG_RE` and the
  unreachable safeResolve probe guard together; needs the full build + API
  E2E + browser gates, best bundled with a real frontend/backend change.
3. **Keep the gates current** — re-run `verify --build --api-e2e` + both
  browser modes after any frontend change; /agent baseline stays 484 KB /
  33.6 KB headroom.
