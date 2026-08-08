# Round 105 — Channel lifecycle coverage to 99% lines (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 104's next-focus item 1: closed the channel lifecycle
coverage gap. `channel.service.ts` went from 82.85% to 99.04% lines; the
only remaining uncovered line is a defensive check that cannot fire by
construction (documented below).

## What changed this round

- **`list()` unit coverage** — ordered summaries carry `memberCount` and ISO
  `createdAt`; the test double's `channel.findMany` now honors
  `include._count` and `where.parentId`/`select` to mirror real queries.
- **`deletionCandidates()` unit coverage** — returns `[parent, sub...]` for
  a channel tree and `[id]` for a solo channel; unknown channel raises 404.
- **`remove()` unit coverage** — deletes the channel row, calls
  `workspaces.removeProjectIfEmpty(projectName)`, and raises 404 for a
  missing channel.
- **`prepareChannelTurn` 404 path** — unknown channel now covered
  (previously only the non-member/rejection paths were).
- **`runTurn()` delegation path** — a `BaseAgentService` double verifies the
  agent's mid-turn `channelPost` and final answer land in the feed, the
  model parameter is passed through, and the returned
  `{answer, steps, trace}` shape is exact.

## Test status

- Fast verify `verify.mjs`: green on the final tree — REST docs guard
  (70 routes / 69 rows), test-count guard, backend unit **14 suites / 192
  tests passed**, backend lint + types, frontend types + lint.
- Coverage run green: `channel.service.ts` **82.85% → 99.04% lines**
  (96.8% stmts / 90.62% branch / 100% funcs). Only line 67 remains
  uncovered — the `SLUG_RE` guard after slugify. Slugify output is built
  from `[a-z0-9_-]` only, making that throw unreachable (dead defense).
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
- **Open** — `workspace-tools.ts` is the next lowest service at 67.08%
  stmts (uncovered: 12, 35-41, 46-59, 64-70, 180, 186, 189).

## Next round focus

1. **Cover `workspace-tools.ts`** — extend `workspace-tools.spec.ts` in the
  same double style to lift it from 67.08% stmts toward the service bar,
  then re-run the fast verify + coverage.
2. **Decide the dead `SLUG_RE` guard** — a small runtime cleanup round
  (remove the unreachable branch) would need the full build + API E2E +
  browser gates; only worth doing bundled with a real frontend/backend
  change, otherwise keep as defense-in-depth.
3. **Keep the gates current** — re-run `verify --build --api-e2e` + both
  browser modes after any frontend change; /agent baseline stays 484 KB /
  33.6 KB headroom.
