# FMCC Agentic — NestJS Base Agent (Codex Implementation Brief)

## Objective

Build a **self-contained NestJS base agent** (the "FMCC Base Agent") inside the
existing `fmcv_agentic` backend, modeled on the reference agents, and configure
two models — `qwen3.6-35b` and `ds4-flash` — served by the user's VRS provider,
mirroring their `~/.codex/config.toml`. The base agent must be a runnable,
tool-capable LLM agent loop exposed over HTTP.

## Repo layout (work already present)

```
/home/node1/fmcv_agentic/
├── backend/                 # NestJS 11 app (backend/package.json)
│   └── src/
│       ├── main.ts          # global prefix "api", port 5555, ValidationPipe(whitelist)
│       ├── app.module.ts    # root module (imports ConnectionsModule, PrismaModule)
│       ├── app.controller.ts / app.service.ts
│       ├── connections/     # example CRUD module (controller+service+module + dto/)
│       ├── prisma/
│       └── agent/           # <-- PARTIAL: base agent already scaffolded (see below)
├── frontend/
├── reference/
│   ├── pi/                  # reference agent: packages/agent, packages/ai/src/model-catalog.ts
│   ├── jcode/               # reference agent: crates/jcode-base/src/provider/models.rs
│   └── hermes-agent/        # reference agent: agent/ source
├── docker-compose.yml
└── README.md
```

There is already a **partial** implementation in `backend/src/agent/`:

- `agent.models.ts` — `ModelSpec` catalog with `qwen3.6-35b` + `ds4-flash` (DONE)
- `base-agent.service.ts` — `BaseAgentService` agent loop (DONE; loop, tools, sessions)
- `agent.dto.ts` — validation DTOs (DONE)
- `agent.controller.ts` — `@Controller('agent')` HTTP surface (DONE)
- `agent.module.ts` — `AgentModule` (DONE)
- `app.module.ts` — imports `AgentModule` (DONE)
- `backend/package.json` — `@nestjs/config` dependency (DONE, installed)

Codex's job is to **review, complete, and verify** this partial work so it
compiles and is fully wired, fixing anything that is missing or broken, and to
ensure the model configuration matches the reference `config.toml` exactly.

## Model configuration source of truth

`/home/node1/.codex/config.toml` (the user's Codex config — COPY the model
values, do NOT modify this file):

```toml
model = "ds4-flash"
model_provider = "vrs"
model_context_window = 131000

[model_providers.vrs]
name = "VRS"
base_url = "http://60.51.17.97:9999/v1"
wire_api = "responses"
```

The base agent must expose **both** `qwen3.6-35b` and `ds4-flash` as model
options served by the VRS endpoint. `ds4-flash` is the default (matches
`model = "ds4-flash"`). Context window = 131000 for both. Wire API used by the
base agent is **OpenAI-compatible `/chat/completions`** on the VRS base URL.

Provider wiring in the service must be read from environment variables with the
VRS defaults:
- `AGENT_BASE_URL` default `http://60.51.17.97:9999/v1`
- `AGENT_API_KEY` (from env; do NOT hardcode the token — leave default empty)
- `AGENT_DEFAULT_MODEL` default `ds4-flash`

Note: the config.toml contains a real bearer token (`experimental_bearer_token`).
Use it only to understand the provider; do NOT copy the token into source files
or commit it. The service should take the key from `AGENT_API_KEY` env.

## Required behavior (Base Agent)

1. **Agent loop** (model → tool calls → execute → repeat until plain-text
   answer or step budget) — mirror `reference/pi/packages/agent/src/agent.ts`
   and `agent-loop.ts`. Step budget default 10.
2. **Tool registry** — `registerTool(name, description, parameters, run)` with
   JSON-schema params; tools serialized to the OpenAI `tools` request field.
3. **Sessions** — in-memory session store (id, title, model, createdAt,
   messages). Create / list / get / delete / converse.
4. **Stateless turn** — optional prior message history.
5. **Model catalog** — both models exposed via a catalog endpoint; `resolveModel`
   falls back to the default on unknown id; fallback chain supported.
6. **No secrets** — no credentials committed.

## Required HTTP endpoints (under global `/api` prefix, controller `agent`)

- `POST /api/agent/turn` — stateless turn `{message, history?, model?, maxSteps?}`
- `POST /api/agent/sessions` — `{title?, model?}`
- `GET  /api/agent/sessions`
- `GET  /api/agent/sessions/:id`
- `POST /api/agent/sessions/:id/converse` — `{message, model?}`
- `DELETE /api/agent/sessions/:id`
- `GET  /api/agent/models` — model catalog (id, label, description, is_default)
- `GET  /api/agent/defaults` — defaultModel, baseUrl, contextWindow

## Acceptance criteria (verify with real commands)

1. `cd /home/node1/fmcv_agentic/backend && npm run build` → **exit 0, no TS errors**.
2. The app boots: start and hit `GET /api/agent/models` and
   `GET /api/agent/defaults` — both must list `qwen3.6-35b` and `ds4-flash`,
   with `ds4-flash` as default and VRS base URL.
3. `POST /api/agent/sessions` returns a session; `GET /api/agent/sessions`
   includes it.
4. A live model call path (turn/converse) is implemented and does not require a
   committed token (key from `AGENT_API_KEY` env).
5. No new files contain a hardcoded bearer token.
6. `git status` shows the base-agent work added but no unrelated refactors or
   dependency churn beyond installing `@nestjs/config`.

## Constraints

- Work ONLY inside `/home/node1/fmcv_agentic/backend/`. Do not modify
  `/home/node1/.codex/config.toml`, frontend/, docker-compose.yml, or README.md.
- Keep the existing partial files where reasonable; fix rather than rewrite.
- Do not commit the real bearer token anywhere.
- Run `npm run build` and confirm it passes. Starting the server for a live
  endpoint check is encouraged (it does not require hitting the LLM).
- Report: files changed, endpoints verified, build output, any deviations from
  the config.toml reference, and any risks.

## Output from Codex

A concise summary covering: files created/modified, the exact model config
applied (both models + provider + context window + default), endpoints verified
with their responses, `npm run build` result, and any known risks or deviations.
