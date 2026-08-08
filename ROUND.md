# Round 99 — measured `/agent` headroom + permanent guard (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 98's focus item #1 as a measurement-only pass on the eager
`/agent` first load. The measurement settled the open question (no picker
split is justified) and became a permanent gate so the agent page cannot
creep inside the shared framework floor unnoticed.

## What changed this round

- **Measured the real `/agent` headroom** — `route-bundle-stats.json`
  (fresh `next build`): `/agent` 495,803 B (484 KB / 8 chunks) vs the
  shared baseline `/` 461,553 B (451 KB / 6 chunks) -> **34,250 B
  (33.4 KB) agent-specific delta**: one 33,934 B page chunk plus a 316 B
  utility chunk. Previous docs guessed "~20 KB above baseline"; the actual
  number is now documented and policed.
- **No picker split (by design)** — the remaining first-load code is the
  chat composer, trace viewer, and the models/connections header pickers.
  The pickers are inline `<select>`s (~2-3 KB of JSX combined), well under
  the >5 KB split threshold; a dynamic boundary would add a render flash
  and context plumbing to save ~2-3 KB. Deliberately left as-is.
- **New `/agent` headroom guard** — `scripts/verify-agent-headroom.mjs`:
  zero-dependency; reads `route-bundle-stats.json` after `next build`,
  computes `/agent` minus the smallest shared-baseline route, prints the
  per-chunk delta, and fails when the delta exceeds a budget (default
  45,000 B, override `FMCV_AGENT_HEADROOM_BUDGET_BYTES`). The absolute
  bundle-size guard alone can hide agent-page creep inside the ~460 KB
  framework floor, so this guard polices the per-route delta directly.
- **Wired into the gate + docs** — `verify.mjs --build` now runs the
  headroom guard right after the bundle-size guard; README verify docs
  updated with the measured baseline, the split rationale, and the
  corrected ~9-34 KB per-route app-chunk range.

## Test status

- Backend unit: **14 suites / 182 tests passed** (fresh via
  `verify --build --api-e2e` this round).
- Backend API E2E (real Postgres, multi-replica): **12 suites / 123 tests
  passed** (fresh this round; known Jest keep-alive warning only).
- Frontend: `tsc --noEmit`, ESLint, Nest + Next builds green; bundle-size
  guard `/agent` **484 KB / 8 chunks** within 600 KB; new headroom guard
  **33.4 KB** agent-specific delta within the 44 KB budget.
- Browser E2E: **not re-run this round** — no frontend runtime code
  changed (verify scripts, guards, and docs only), so the frontend
  container was not rebuilt. Round 98's full both-mode runs (21 route
  probes each, zero console/network errors, polling + lazy guards green)
  remain the current runtime evidence; re-run both modes with the next
  runtime change.

## Known issues / open tickets

- **Low** — Jest API e2e still prints the "did not exit" keep-alive warning
  after the multi-replica suite closes; suites pass with exit code 0.
- **Low** — `e2e/report.json` is the latest-run mirror only; per-mode
  archives live in git history via committed `report-<mode>.json` (by design).
- **Closed this round** — the "~20 KB headroom" guess in the docs (now
  measured 33.4 KB and enforced by a guard); the "13-50 KB" per-route
  app-chunk doc range (now the measured ~9-34 KB).

## Next round focus

1. **Optional** — refresh channels immediately on `visibilitychange` when
   the tab returns (today the first visible refresh waits for the next 8s
   tick); adopt only if the 0-8s staleness on return is user-visible in
   practice.
2. **Optional** — see whether the 316 B `/agent` edge chunk can be folded
   into the page chunk (Turbopack emitted it as a separate module edge;
   negligible, but a cheap clean-up if trivial).
3. **Keep the gates current** — re-run `verify --build --api-e2e` + both
   browser modes after any future frontend change; keep the baseline
   `/agent` 484 KB / 33.4 KB headroom.
