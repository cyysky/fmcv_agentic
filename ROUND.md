# Round 101 — 316 B edge chunk: investigated, not foldable (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 100's focus item #1 as a decision pass: whether the 316 B
`/agent` edge chunk can be folded into the page chunk. It cannot — without
losing the lazy split it exists to serve — so the round closes the question
with evidence and documents the answer.

## What changed this round

- **Identified the 316 B chunk** — `2cym9c2bsuhxj.js` is Turbopack's async
  module-edge for `/agent`'s two `next/dynamic` loadables. It registers the
  loader modules that fetch `agent-views.tsx` (~23 KB, sessions + channels
  panels, Round 93 lazy split) and `workspace-viewer.tsx` (~2.3 KB, Round 97
  lazy split) on demand; the page chunk's `loadableGenerated` modules point
  straight at it.
- **Proved it is a framework pattern, not agent-specific cruft** — `/cron`
  carries its own 987 B per-route edge chunk (an apiFetch boundary), and
  `/` has none because it has no async boundary. Tiny module-edge chunks are
  a normal Turbopack emission wherever routes lazy-load.
- **Decision: no fold.** Folding the edge means deleting or inlining the
  dynamic boundaries, which would add ~25.5 KB (23 KB panels + 2.3 KB
  workspace viewer) back to `/agent` first load — strictly worse than the
  ~316 B uncompressed (~100 B gzipped) + one cached HTTP request the edge
  costs. Next 16 default Turbopack exposes no chunk-merge knob, and
  switching the build pipeline to webpack `splitChunks` for a sub-KB saving
  is not justified. Same cost/benefit call as Round 99's picker-split no-go.
- **README updated** — the bundle-size guard notes now explain what the
  "tiny edge chunks" are (`/agent` = `next/dynamic` loader edge;
  `/cron` = apiFetch boundary), so future rounds don't re-investigate.

## Test status

- No runtime code changed this round; the full
  `verify --build --api-e2e` gate remains green from this session's Round
  100 run: **14/182 unit, 12/123 API E2E**, bundle `/agent` 484 KB /
  8 chunks within 600 KB, headroom 33.6 KB within 44 KB.
- Fast `verify.mjs` re-run this round on final code: green — REST docs
  guard (70 routes / 69 rows), test-count guard, backend unit 14/182,
  backend lint + types, frontend types + lint.
- Browser E2E: **not re-run this round** — no frontend runtime change
  (same explicit skip as Round 99); Round 100's enabled + api-only runs
  (21 route probes each, zero console/network errors) remain current
  runtime evidence.

## Known issues / open tickets

- **Low** — Jest API e2e keep-alive warning after the multi-replica suite;
  suites exit 0.
- **Low** — `e2e/report.json` mirrors only the latest run; per-mode
  archives live in git history (by design).
- **Closed this round** — the "fold the 316 B edge chunk" open question:
  not foldable without a ~25.5 KB first-load regression; kept as-is and
  documented in README.

## Next round focus

1. **Profiling is now a conditional, not routine, task** — only profile
   deeper when a future feature threatens the 44 KB `/agent` headroom
   budget (currently 33.6 KB used); no routine action needed.
2. **Keep the gates current** — re-run `verify --build --api-e2e` + both
   browser modes after any frontend change; keep `/agent` at the 484 KB /
   33.6 KB baseline.
3. **If user pain ever shows up on first load** — the ~460 KB shared
   Next/React framework floor dominates every route and is the only big
   lever left; profile that before touching per-route chunks.
