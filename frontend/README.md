# Frontend (Next.js App Router)

`frontend/` is the Next.js 16 (React 19, TypeScript) UI for FMCV Agentic.
Full project documentation lives in the repository root
[README.md](../README.md); this file covers the frontend only.

## Pages

| Route      | Component                    | Purpose                                             |
|------------|------------------------------|-----------------------------------------------------|
| `/`        | `app/page.tsx` (server)      | landing page with links                             |
| `/settings`| `app/settings/page.tsx`      | connection CRUD (server metadata + client panel)    |
| `/agent`   | `app/agent/page.tsx`         | chat, workspaces, channels (server metadata + panel)|

Per-page browser titles come from `metadata` exports in the server page
wrappers (`Settings - FMCV Agentic`, `Agent - FMCV Agentic`); the root layout
supplies the default `FMCV Agentic` and the `%s - FMCV Agentic` template.

## Run

```bash
npm install
npm run dev        # dev server on :3333 (or: docker compose up --build from repo root)
npm run build      # production build (type-check + lint included)
npm run lint       # eslint (must stay clean)
```

## Data access

The UI talks to the backend REST API at `NEXT_PUBLIC_API_URL` (inlined at
build time; Docker default `http://10.0.151.7:5555/api`).
