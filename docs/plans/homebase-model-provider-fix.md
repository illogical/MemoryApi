# Fix: model-provider status shows "Not Active" under HomeBase

## Context

MemoryApi's hosted adapter (`src/host/adapter.ts`, per
`docs/plans/homebase-integration-plan.md`) was enabled in HomeBase and
verified live at `http://127.0.0.1:17110/memoryapi/` — vector, graph, and SQL
stores all report reachable. The one remaining gap: the dashboard's Model
Provider indicator shows a red "Not Active" dot.

## Root cause

The adapter's `initialize()` (`src/host/adapter.ts:61-71`) calls:

```ts
reconfigure({
    SQLITE_DB_PATH: join(options.dataPath, 'memory.db'),
    PROMPT_TEMPLATE_BASE_PATH: join(options.repositoryRoot, 'src', 'prompts'),
    LLM_HOST: `http://127.0.0.1:${homebasePort}/lmapi`,
});
```

`LLM_HOST` is already correct — it resolves to `http://127.0.0.1:17110/lmapi`
given this deployment's `HOMEBASE_PORT=17110`. That is **not** what needs to
change from "its prior URL" (`http://host.docker.internal:17100`, still
correct for MemoryApi's own standalone `.env`, untouched by this fix).

The actual gap: `LLM_PROVIDER`, `LLM_MODEL`, and `EMBEDDING_MODEL` are never
overridden by `reconfigure()` — they're read straight from `process.env` by
`Config`'s constructor (`src/services/configService.ts:70-138`). MemoryApi's
own `.env` sets `LLM_PROVIDER=lmapi`, but that file is never read inside
HomeBase's container: `dotenv.config()` resolves relative to the container's
own `cwd` (HomeBase's `/app`), not MemoryApi's checkout. So inside HomeBase,
`Config` falls back to its hardcoded default, `LLM_PROVIDER: string =
'ollama'` (`configService.ts:74`). `MemoryRAGSystem`'s constructor then builds
an **Ollama** client via `ModelClientFactory.createModelClient(config.LLM_PROVIDER,
config.LLM_HOST)` (`memoryRAGSystem.ts:47`), pointed at the *correct* loopback
URL but speaking the *wrong* protocol — Ollama's `/api/tags`-shaped requests
against LMApi's router. The request fails; `getModelProviderStatus()` catches
it and returns `active: false` (`memoryRAGSystem.ts:532-558`); `public/app.js:153-164`
renders that as "Not Active."

This is the same class of gap already hit once for `QDRANT_URL`/
`NEO4J_*_URI` earlier in this integration: those were added directly to
HomeBase's `.env.docker` (not MemoryApi's own `.env`), since `env_file:` in
`docker-compose.dev.yml` is what actually reaches the hosted container's
`process.env`.

## Fix

**This change is entirely on the HomeBase side** — no MemoryApi code or
config changes are needed. Add the same three model-config variables to
`HomeBase/.env.docker` (gitignored), matching the values already in
`MemoryApi/.env`:

```
LLM_PROVIDER=lmapi
LLM_MODEL=granite3.3
EMBEDDING_MODEL=nomic-embed-text:v1.5
```

Then recreate the HomeBase dev container so the new env values take effect:

```
docker compose --env-file .env.docker -f docker-compose.dev.yml up -d
```

(matches how the earlier `QDRANT_URL`/`NEO4J_*_URI` fix was applied).

## Verification

- `curl http://127.0.0.1:17110/memoryapi/api/status/model-provider` returns
  `"active": true` with `"provider": "lmapi"`.
- The HomeBase dashboard's Model Provider indicator turns green for
  MemoryApi's card.
- MemoryApi's own standalone `.env`/`npm run dev` is untouched and continues
  to work as before (no code changed).
