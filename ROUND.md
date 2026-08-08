# Round 114 — base-agent service coverage to 100% lines (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 113's next-focus item 1: lifted `base-agent.service.ts`
from 74.92% to **100% lines** (97.68% stmts / 84.03% branch / 98% funcs)
by extending `base-agent.service.spec.ts` with 23 new tests.

## What changed this round

- **Sessions resilience** — a failed persisted read falls back to the live
  map, a failed delete lookup still 404s, a failed row removal still
  reports `deleted`, a failed upsert keeps the in-memory session, and a
  failed startup reload is logged and swallowed.
- **API key resolution** — env key short-circuit, DB row key (mode-
  insensitive baseUrl match), DB-lookup failure → empty + warn, and no-key
  row → empty are all covered directly.
- **runTurn context** — caller `history` lands as preceding user messages;
  an installed-skills registry failure is logged and the turn proceeds
  without the registry block.
- **runChannelTurn** — full stub-mode turn (channel/self/base tool set,
  thread block, prompt assembly, registry save/restore), plus the empty-
  thread variant.
- **Streaming failure handling** — consecutive tool-error rounds stop with
  the `[stopped] Repeated tool errors…` answer; primary-model failure falls
  back to ds4-flash; default-model failure with no fallback propagates; the
  pre-loop abort guard honors a stop that lands before the first call.
- **Real LLM transport** — mocked `fetch` covers a successful completion
  with a DB-resolved key (tools in body, auth header), connection
  baseUrl/key/default-parameters merging (model/messages/tools protected),
  wire `tool_calls` mapping (id/name/arguments normalization), reasoning-
  model temperature removal, and non-200 upstream rejection without auth.
- **executeTool + catalog** — invalid JSON args and thrown tool runs map
  to JSON errors; `getCatalog()` / `getDefaults()` are asserted.

## Test status

- Fast verify `verify.mjs`: green on the final tree — REST docs guard
  (70 routes / 69 rows), test-count guard, backend unit **14 suites / 281
  tests passed** (+23 this round; `base-agent.service.spec.ts` alone
  46/46), backend lint + types, frontend types + lint.
- Coverage run green: `base-agent.service.ts` **74.92% → 100% lines**
  (97.68% stmts / 84.03% branch / 98% funcs). Remaining uncovered
  statements are 8 partial-line guard sides on already-covered lines
  (`continue`/`return null` sides, the unknown-tool early return, and the
  default-parameter skip), matching the other 100%-line services. The
  pre-loop abort guard (802-803) is unreachable with a real `AbortSignal`
  (the for-condition catches aborts between iterations); it is exercised
  with a stateful signal mock and noted below.
- `buckets.service.ts`, `files.service.ts`, `workspace.service.ts`,
  `connections.service.ts`, `cron.service.ts`, `skills.service.ts`,
  `channel-job.service.ts` and `workspace-tools.ts` stay at 100% lines;
  `channel.service.ts` stays 99.04% (dead `SLUG_RE` guard).
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
- **Open** — dead/defensive guards to bundle into one cleanup decision:
  `channel.service.ts` line 67 (`SLUG_RE` guard), the unreachable
  safeResolve probe guard (`workspace.service.ts` line 248), and the
  base-agent pre-loop abort read (802-803) that a real `AbortSignal`
  cannot hit between two synchronous reads. Decide keep-vs-delete together
  in a runtime round.
- **Open** — `prisma.service.ts` is the last non-100% service at 50% lines
  (trivial constructor-only file).

## Next round focus

1. **Cover `prisma.service.ts`** — trivial constructor-only file at 50%;
  extend `prisma.service.spec.ts`, re-run fast verify + coverage. This
  closes the service-coverage sweep: every service at 100% lines.
2. **Decide the dead-guard cleanup bundle** — remove or keep `SLUG_RE`,
  the safeResolve probe guard, and the base-agent pre-loop abort guard
  together; needs the full build + API E2E + browser gates, best bundled
  with a real frontend/backend change.
3. **Keep the gates current** — re-run `verify --build --api-e2e` + both
  browser modes after any frontend change; /agent baseline stays 484 KB /
  33.6 KB headroom.
