# Round 115 — prisma service coverage to 100% (2026-08-09)

Human direction (DIRECTION.md): none — DIRECTION.md is empty. This round
executed Round 114's next-focus item 1: added `prisma.service.spec.ts`
(1 test) and lifted `prisma.service.ts` from 50% to **100% lines / 100%
stmts / 100% funcs / 100% branch**. This closes the service-coverage
sweep: every backend service is now at 100% lines.

## What changed this round

- **prisma.service.spec.ts** — constructs a real `PrismaService` (pg
  adapter wiring) and spies `$connect`/`$disconnect` to exercise the
  `onModuleInit` / `onModuleDestroy` lifecycle.
- **README** — unit suite count 14 → 15 with a prisma-service mention in
  the Testing section, satisfying the test-count drift guard.

## Test status

- Fast verify `verify.mjs`: green on the final tree — REST docs guard
  (70 routes / 69 rows), test-count guard (unit 15 suites / API E2E 12),
  backend unit **15 suites / 282 tests passed** (+1 this round), backend
  lint + types, frontend types + lint.
- Coverage run green: `prisma.service.ts` **50% → 100% lines** (100% stmts
  / 100% branch / 100% funcs). Every backend service is at 100% lines:
  buckets, files, workspace, connections, cron, skills, base-agent,
  channel-job, workspace-tools, prisma (channel.service stays 99.04% due
  to the dead `SLUG_RE` guard — cleanup ticket below; agent.models /
  agent.dto / controllers / tools harnesses never had service-style
  coverage targets).
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
  in a runtime round (now the only service-coverage ticket left).

## Next round focus

1. **Decide and execute the dead-guard cleanup bundle** — remove or keep
  `SLUG_RE`, the safeResolve probe guard, and the base-agent pre-loop
  abort guard together; this is a runtime change, so follow with
  `verify --build --api-e2e` + both browser modes (or skip explicitly if
  Docker/Chrome are unavailable) and update the coverage ticket.
2. **Consider pushing branch coverage** — several 100%-line services sit
  at 83–93% branch; partial-line guard sides are documented, but a
  dedicated branch-coverage pass could close the remaining guarded
  ternaries (low value, high effort — only if no runtime work is waiting).
3. **Keep the gates current** — re-run `verify --build --api-e2e` + both
  browser modes after any frontend change; /agent baseline stays 484 KB /
  33.6 KB headroom.
