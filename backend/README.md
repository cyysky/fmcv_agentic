# Backend (NestJS + Prisma)

`backend/` is the NestJS 11 API for FMCV Agentic. Full project documentation
lives in the repository root [README.md](../README.md); this file covers
backend-only commands.

## Run

```bash
npm install
npm run build        # type-check + compile
npm run start:dev    # watch mode (or `docker compose up --build` from the repo root)
```

Environment knobs:

- `CRON_LEASE_GROUP` — scheduler lease group id (defaults to `default`); a
  group has exactly one active scheduler across replicas, and every cron job
  a backend creates is stamped with that group as its owner
  (`CronJob.schedulerGroup`). The boot recovery sweep, startup cache load,
  and due-job scan only touch the owner group, so deployments sharing one
  Postgres never claim or sweep each other's jobs. Manual `Run now` is
  intentionally group-agnostic and can fire any job from any node.
- `CRON_SCHEDULER_ENABLED` — set to `false` for API-only mode: no lease
  acquisition, no tick, no boot-time recovery sweep (CRUD and `Run now`
  still work). Any other value (or unset) enables the scheduler.

## Test

```bash
npm test -- --runInBand    # unit tests (no external services)
# API E2E: needs PostgreSQL (docker compose up -d db). Suites boot their
# own backend on an isolated CRON_LEASE_GROUP, and Round 80 job ownership
# means the live Docker backend (same Postgres, different group) can no
# longer steal their jobs. The main cron suite shares the `default` group
# with the container, so the still-recommended belt-and-braces setup puts
# the live stack in API-only mode (no stop required)...
CRON_SCHEDULER_ENABLED=false docker compose up -d --force-recreate backend
npm run test:e2e
docker compose up -d --force-recreate backend   # restore the scheduler
# ...or stop the container entirely (same isolation):
# docker compose stop backend
# npm run test:e2e
# docker compose start backend
```

E2E suites live in `test/`; `test/e2e-setup.ts` points `AGENT_WORKSPACE_ROOT`
at a temp directory before the app module loads, and `test/jest-e2e.json`
holds the config (30s timeout, `maxWorkers: 1`). The suites share one real
Postgres. Two interference sources require the live backend to be stopped
and serial execution:

- **Cross-stack scheduler races**: cron jobs are owned by the lease group
  that created them (Round 80), and the due-job scan + boot recovery sweep
  only touch the owner group, so a running deployment can no longer claim
  another group's jobs (`CRON_LEASE_GROUP` now isolates both the lease and
  job ownership). The Docker backend shares the `default` group with the
  main cron suite, though, and it has no `AGENT_LLM_STUB`, so API-only
  mode (`CRON_SCHEDULER_ENABLED=false`) remains the preferred E2E posture
  for the live stack.
- **Boot-time recovery sweep**: `onModuleInit` marks that group's `running`
  rows `error`, so one suite's app boot can't clobber another suite's
  in-flight job; suites isolate themselves with unique lease groups and the
  serial Jest config keeps the run deterministic.

## Layout

```
src/
  main.ts            # bootstrap: /api prefix, ValidationPipe, CORS
  app.module.ts      # AgentModule + ConnectionsModule + PrismaModule
  prisma/            # PrismaService (driver adapter)
  connections/       # connection CRUD
  agent/             # agent loop, workspaces, channels, streaming jobs
test/                # API E2E suites + helpers
prisma/              # schema.prisma (Connection, Channel, ChannelMember,
                     # ChannelMessage, ChannelRun) + migrations
```
