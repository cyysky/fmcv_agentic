# FMCV Agentic

Full-stack starter: **Next.js** frontend + **NestJS** backend, deployed with Docker Compose.

## Stack
| Layer      | Tech                              | Port |
|------------|-----------------------------------|------|
| Frontend   | Next.js 16 (React 19, TypeScript) | 3333 |
| Backend    | NestJS 11 (TypeScript)            | 5555 |

## Local development
```bash
# Frontend
cd frontend && npm install && npm run dev   # http://localhost:3333

# Backend (separate terminal)
cd backend && npm install && npm run start:dev   # http://localhost:5555
```

## Run with Docker
```bash
docker compose up --build
# Frontend: http://localhost:3333
# Backend:  http://localhost:5555
```

Stop with `docker compose down`.
