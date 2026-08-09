# Direction (human)

1. **Agents can access the internet** — enable agents to browse/search the web / fetch URLs during their runs (e.g. a web search or fetch tool), not just workspace tools.
2. **Agents can manage skills** — agents should be able to manage their skills: list, read, create, update, and delete reusable skill files from within the agent loop.
3. **Agents can manage NestJS cronjobs** — the cron/scheduling feature must be native NestJS (e.g. `@nestjs/schedule`), NOT system cron (no host crontab), so the whole system stays portable (docker-compose deployable anywhere). Agents manage the cronjobs through this native NestJS mechanism.
4. **Internet/browse strategy** — the system agent should try connecting to the **local CDP (Chrome DevTools Protocol) on port 9222 first**, then fall back to curl, python, or the native NestJS way to browse the internet.
