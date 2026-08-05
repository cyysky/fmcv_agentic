# FMCV Agentic

Full-stack app to **manage OpenAI-compatible model connections** in one place: Next.js frontend for the UI, NestJS backend with a REST API, and PostgreSQL for persistence (via Prisma ORM). Deployed with Docker Compose.

## Stack

| Layer      | Tech                                   | Port | Notes                                   |
|------------|----------------------------------------|------|-----------------------------------------|
| Frontend   | Next.js 16 (React 19, TypeScript)      | 3333 | App Router; `/settings` management UI   |
| Backend    | NestJS 11 (TypeScript)                 | 5555 | REST API under `/api`; global `ValidationPipe` |
| Database   | PostgreSQL 16 (Docker)                 | 5432 | Reachable from services + host tooling  |
| ORM        | Prisma ORM 7 (`@prisma/client`, `@prisma/adapter-pg`) | — | Driver-adapter based (Prisma v7)        |

## Features

- **Connections CRUD** — add, list, update, delete OpenAI-compatible API connections
  (display name, base URL, model, context length, concurrent connections).
- **Settings UI** (`http://localhost:3333/settings`) — full CRUD against the backend.
- **REST API** on the backend:
  - `POST   /api/connections` — create
  - `GET    /api/connections` — list
  - `GET    /api/connections/:id` — get one
  - `PATCH  /api/connections/:id` — update
  - `DELETE /api/connections/:id` — delete
- Input validation via `class-validator` (`whitelist` + `forbidNonWhitelisted`).

## Progress (from git history)

### `cf5b6e6` — Initial setup
- Next.js frontend + NestJS backend scaffolded, wired together with Docker Compose.
- Basic `GET /` hello world on both frontend and backend.

### `f96b49a` — Ignore cloned reference repos
- Added `reference/` to `.gitignore`.

### Current WIP (Connections feature + Prisma/Postgres migration)
- **Backend build** grew a NestJS `connections` module (module / service / controller / DTOs),
  a global ValidationPipe, and an `/api` prefix.
- **Persistence moved from JSON-file storage → PostgreSQL via Prisma**:
  - `Connection` Prisma model mapped to the `connections` table (`id` UUID, displayName,
    baseUrl, modelName, contextLength, concurrentConnections, createdAt, updatedAt).
  - Prisma driver adapter (`@prisma/adapter-pg`) wired into `PrismaService` (required by
    Prisma v7).
  - Migration `20260805015856_init` creates the `connections` table.
- **Frontend** — home page links to the new `/settings` management page; full CRUD UI.
- **Infra** — Docker Compose now defines a `db` (Postgres) service, wires
  `DATABASE_URL` into the backend, and passes `NEXT_PUBLIC_API_URL` to the frontend.

## Local development

```bash
# Prerequisites: Docker + Docker Compose
docker compose up --build
```

Then open:
- Frontend UI: http://localhost:3333 (Settings: http://localhost:3333/settings)
- Backend API: http://localhost:5555/api/connections

Stop everything with `docker compose down`.

### Database & migrations (Prisma)

```bash
cd backend
export DATABASE_URL="postgresql://fmcv:fmcv_dev_password@localhost:5432/fmcv?schema=public"

# After changing prisma/schema.prisma:
npx prisma migrate dev --name <migration_name>   # create + apply
npx prisma generate                              # regen the client
```

Migrations live in `backend/prisma/migrations/`. The Prisma config is at
`backend/prisma.config.ts` (reads `DATABASE_URL` from `backend/.env`).

> **Note on running inside Docker:** Postgres (`db`) is exposed on host port 5432 so local
> Prisma tooling can reach it; other services reach it over the compose network via the
> service name `db`.

## Project layout

```
backend/
  prisma/            # schema.prisma + migrations
  prisma.config.ts   # Prisma datasource config (DATABASE_URL)
  src/
    main.ts          # bootstrap: /api prefix, ValidationPipe, CORS
    app.module.ts    # wires ConnectionsModule + PrismaModule
    prisma/          # PrismaService (+ driver adapter)
    connections/     # module, service, controller, DTOs
frontend/
  app/
    page.tsx         # home → link to settings
    settings/        # connections management UI
docker-compose.yml   # frontend + backend + db services
```
