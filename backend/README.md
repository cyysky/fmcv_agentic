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

## Test

```bash
npm test -- --runInBand    # unit tests (no external services)
# API E2E: needs PostgreSQL (docker compose up -d db). The live backend
# container must be stopped first — its scheduler fires jobs from the same
# shared Postgres even when the suite runs its own lease group, so it can
# steal e2e jobs and persist real-gateway (non-stub) answers:
docker compose stop backend
npm run test:e2e
docker compose start backend   # restart the live stack afterwards
```

E2E suites live in `test/`; `test/e2e-setup.ts` points `AGENT_WORKSPACE_ROOT`
at a temp directory before the app module loads, and `test/jest-e2e.json`
holds the config (30s timeout, `maxWorkers: 1`). The suites share one real
Postgres. Two interference sources require the live backend to be stopped
and serial execution:

- **Cross-stack scheduler races**: the cron scheduler's due-job scan is not
  scoped to a lease group, so any running deployment (e.g. the Docker
  backend) can claim the suite's jobs (`CRON_LEASE_GROUP` only isolates the
  lease, not the due-job scan). The container has no `AGENT_LLM_STUB`, so a
  stolen job runs against the real gateway and can persist a `done` row
  with a null/empty message — exactly the symptom that makes the
  multi-replica suite flaky.
- **Boot-time recovery sweep**: `onModuleInit` marks every cluster-wide
  `running` row `error`, so one suite's app boot can clobber another
  suite's in-flight job; serial execution keeps the suite deterministic.

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
