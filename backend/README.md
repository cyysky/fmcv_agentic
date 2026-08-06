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
npm run test:e2e           # API E2E: needs PostgreSQL (docker compose up -d db)
```

E2E suites live in `test/`; `test/e2e-setup.ts` points `AGENT_WORKSPACE_ROOT`
at a temp directory before the app module loads, and `test/jest-e2e.json`
holds the config (30s timeout).

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
