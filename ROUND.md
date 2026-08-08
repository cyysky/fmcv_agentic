# Round 116 — dead-guard cleanup, channel.service to 100% lines (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 115's next-focus item 1 (dead/defensive guard cleanup) as a
runtime round: removed two genuinely dead guards, deliberately kept the
safeResolve termination guard, and re-ran the full runtime gate set.

## What changed this round

- **channel.service.ts** — removed the dead `SLUG_RE` constant and its
  guard: the slug sanitizer only ever produces `[a-z0-9_-]` characters, so
  the regex branch was unreachable. `channel.service.ts` is now **100%
  lines**; no spec change needed.
- **base-agent.service.ts** — removed the pre-loop abort read (old lines
  802-803): the streaming loop's own `for` condition re-checks
  `!opts.signal?.aborted` between iterations, so a real `AbortSignal` can
  never read false at loop entry and true at the guard. In-flight abort
  handling (catch path) is unchanged.
- **base-agent.service.spec.ts** — removed the now-obsolete stateful
  fake-signal test `'stops immediately when the signal reads aborted at
  loop entry'` (unit test count 282 → 281); the real mid-loop abort test
  stays.
- **workspace.service.ts** — **kept** the `workspace.service.ts:248`
  probe guard (`if (parent === probe) throw ...`): it is the walk-up
  loop's structural termination guard (an ENOENT walk would otherwise hit
  `/` where `dirname('/') === '/'` and loop forever). It is safety code,
  not dead code.

## Test status

- Fast verify `verify.mjs`: green — REST docs guard (70 routes / 69 rows),
  test-count guard (unit 15 suites / API E2E 12), backend unit **15
  suites / 281 tests passed** (−1 obsolete test), backend lint + types,
  frontend types + lint.
- Coverage run green: `channel.service.ts` **99.04% → 100% lines** (97.54%
  stmts / 100% funcs). Every backend service remains at 100% lines:
  buckets, files, workspace, connections, cron, skills, base-agent,
  channel-job, workspace-tools, prisma, channel.
- Full build gate `verify.mjs --build --api-e2e`: green —
  `nest build` + `next build`, bundle `/agent` 484 KB / 8 chunks / 33.6 KB
  headroom (within 44 KB), API E2E **12 suites / 123 tests passed** with
  the backend flipped to API-only and restored to enabled mode.
- Browser E2E (real Chrome via CDP, both modes): **enabled and api-only
  runs both passed** — all routes, agent, sessions, files, buckets, cron,
  skills, mobile, settings; zero console errors / failed network requests
  in either run; screenshots and `report-<mode>.json` archived. Backend
  left in enabled mode.

## Known issues / open tickets

- **Low** — Jest API e2e keep-alive warning after the multi-replica suite;
  suites exit 0.
- **Low** — `e2e/report.json` mirrors only the latest run; per-mode
  archives live in git history (by design).
- No open code tickets from the guard bundle: the safeResolve guard was
  intentionally kept (documented safety invariant), and all services are
  at 100% lines.

## Next round focus

1. **Consider pushing branch coverage (optional, low value)** — several
   services at 100% lines still sit at 83–93% branch (e.g. base-agent
   83.78%, channel.service 91.93%, workspace.service 93.93%); partial
   guard sides are documented, and only do a dedicated pass if no runtime
   work is waiting.
2. **Keep the gates current** — after any next frontend or backend runtime
   change, re-run `verify --build --api-e2e` + both browser E2E modes;
   /agent baseline remains 484 KB / 33.6 KB headroom, unit 15 suites /
   281 tests, API E2E 12 suites / 123 tests.
3. **Check for new user direction each round** — DIRECTION.md is currently
   empty; re-read it at the start of the next round per LOOP.md.
