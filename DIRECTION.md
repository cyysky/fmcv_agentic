# Direction (human)

1. **Agents can access the internet** — enable agents to browse/search the web / fetch URLs during their runs (e.g. a web search or fetch tool), not just workspace tools.
2. **Agents can manage skills** — agents should be able to manage their skills: list, read, create, update, and delete reusable skill files from within the agent loop.
3. **Cronjobs must be native NestJS — NOT system cron** — the cron/scheduling feature must be implemented natively inside the NestJS backend (e.g. `@nestjs/schedule`), portable and self-contained. Do NOT use system crontab or any host-level cron; the whole system must remain portable (docker-compose deployable anywhere).
