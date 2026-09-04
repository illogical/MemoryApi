# AGENTS.md

Guidance for AI coding agents working in this repo. Read this before making changes.

## What this project is

MemoryApi is a TypeScript/Node backend that gives AI assistants long-term semantic memory. Memories are stored as vector embeddings in Qdrant, with SQLite for revisions/audit history and an optional Neo4j graph for relationships. On ingestion, an LLM summarizes, classifies, and tags each memory; on retrieval, a post-search aggregator clusters and condenses results into narratives or bullet lists sized for another LLM's context window (the MCP use case).

Read [README.md](README.md) first — it has the architecture, core services, data-environment tables, and provider setup. Don't duplicate that content here; this file is about how to work in the repo.

## Read these before touching related code

| If you are working on… | Read first |
|---|---|
| **Anything that writes or resets data** | [docs/AI_AGENTS.md](docs/AI_AGENTS.md) — non-negotiable environment rules |
| Ingestion prompts, classification, tagging, summarization | [docs/plans/2026-09-03-ingestion-prompt-refinement.md](docs/plans/2026-09-03-ingestion-prompt-refinement.md) |
| Prompt quality problems, seed corpus questions | [docs/evaluation/prompt-refinement-findings.md](docs/evaluation/prompt-refinement-findings.md) |
| Ingestion pipeline behavior end to end | [docs/ingestion/clean-slate-ingestion-plan.md](docs/ingestion/clean-slate-ingestion-plan.md) |
| LLM retry/validation/fallback logic | [docs/llm-response-validation-and-retry.md](docs/llm-response-validation-and-retry.md) |
| Search quality, reranking, merging | [docs/rag-improvement/](docs/rag-improvement/) — start at `00-OVERVIEW.md`, roadmap in `08-IMPROVEMENT-ROADMAP.md` |
| Post-search aggregation | [docs/graph post-search aggregation/](docs/graph%20post-search%20aggregation/) and [docs/rag-improvement/aggregation-refinement-plan.md](docs/rag-improvement/aggregation-refinement-plan.md) |
| Multi-source result quality | [docs/plans/multi-source-result-quality-plan.md](docs/plans/multi-source-result-quality-plan.md) |
| Running under HomeBase (`src/host/`) | [docs/plans/homebase-integration-plan.md](docs/plans/homebase-integration-plan.md), [docs/plans/homebase-model-provider-fix.md](docs/plans/homebase-model-provider-fix.md) |
| Data isolation between environments | [docs/data-isolation-implementation-spec.md](docs/data-isolation-implementation-spec.md) |
| Writing tests | [docs/unit-test-plan.md](docs/unit-test-plan.md) |

`docs/plans/` holds forward-looking design; `docs/evaluation/` holds review findings and (when created) the annotation guide. Both are markdown — keep planning artifacts as markdown files in the repo rather than any other format.

## The rule that matters most

**[docs/AI_AGENTS.md](docs/AI_AGENTS.md) governs every script, test, eval, and seed operation.** Three data environments (`production`, `development`, `test`) point at separate SQLite files, Qdrant collections, and Neo4j instances. Tests and evals run with `MEMORY_DATA_ENV=test`. Production writes need an explicit `MEMORY_ALLOW_PRODUCTION_WRITES=true` opt-in, and reset/destroy scripts refuse production unconditionally.

Call the guards at the top of any script that writes or destroys data — `assertNotProduction()` for anything that could wipe data, `assertCanWriteMemory()` for normal writes. Never hardcode a collection name; always use `config.QDRANT_COLLECTION_NAME`.

Only memories with `Status = 'stored'` appear in search results. New memories from the review UI start as `draft`.

## Code layout

- `src/app/` — entry points. `index.ts` (Express server), `memoryAPI.ts` and `reviewAPI.ts` (routers), `memoryMcpServer.ts` (MCP server).
- `src/services/` — all business logic. `memoryRAGSystem.ts` is the orchestrator; `memoryTextProcessor.ts` owns the three ingestion LLM calls; `promptTemplateService.ts` renders prompts; `modelClients.ts` abstracts LM Studio / Ollama / LMApi; `memoryPostSearchAggregator.ts` handles retrieval-side condensation; `vectorService.ts`, `sqlService.ts`, `graphService.ts` are the three stores.
- `src/prompts/` — prompt templates as `.txt`/`.md`, rendered by `promptTemplateService`. Changing one changes production behavior; see the ingestion plan before editing.
- `src/samples/` — `allCategories.json` and `allTags.json` are the **runtime vocabulary source of truth** (8 categories, 61 tags in 4 described groups). `seedMemories.json` is curated production seed data; `sampleMemories.json` is dev/test only.
- `src/models/` — typed domain objects and enums (`memoryCategory.ts`, `memoryStatus.ts`).
- `src/scripts/` — CLI entry points for seeding, resetting, evaluating, and migrating. All of them must call an environment guard.
- `src/host/` — the HomeBase adapter. Under HomeBase, `SQLITE_DB_PATH`, `PROMPT_TEMPLATE_BASE_PATH`, and `LLM_HOST` are injected rather than read from `.env`; standalone mode is unaffected. Don't break either mode.
- `src/__tests__/`, `src/host/__tests__/` — Jest (ESM, ts-jest).

Configuration flows through `src/services/configService.ts`. Read it before adding a setting; it derives storage targets from `MEMORY_DATA_ENV` and validates required values at construction.

## The LMEval relationship

[LMEval](https://github.com/illogical/LMEval) (local checkout: `C:\LocalDev\Projects\LMEval`) is a separate app for systematic prompt and model evaluation. It is how ingestion prompt quality gets measured and how the best local model for each task gets chosen. Both projects front-run this work with paired plans:

- MemoryApi: [docs/plans/2026-09-03-ingestion-prompt-refinement.md](docs/plans/2026-09-03-ingestion-prompt-refinement.md)
- LMEval: `docs/plans/2026-09-03-professional-memory-evaluations.md`
- Cross-project review: LMEval `docs/plans/2026-09-04-ingestion-eval-alignment-review.md`

**The boundary is strict and both directions matter:**

- MemoryApi owns the taxonomy, the annotation guide, and the benchmark datasets. It exports versioned, hash-stamped snapshots to LMEval for evaluation.
- LMEval owns measurement. It returns advisory promotion records and per-task model recommendations.
- **Neither project writes into the other's repository or calls it at runtime.** Snapshots and promotion records move by human review and commit. A good LMEval result never auto-updates a prompt here.
- A recommendation is not adopted until it is reproduced locally with MemoryApi's own evaluator under `MEMORY_DATA_ENV=test`, and end-to-end ingestion latency has been measured.

Two parity requirements exist because of this relationship. If you touch either, check the other project:

1. **Message shape.** LMEval sends structured `[system, user]` chat messages. `LMApiClient` must do the same rather than flattening messages into one prompt string, or evaluation results describe a call this project doesn't make.
2. **Inference parameters.** Temperature and token ceilings per task are part of the evaluated configuration, not incidental constants. Keep them in one place and include them in exported snapshots.

## Working with prompts

The three ingestion prompts (`categorization.txt`, `tagging.txt`, `memory_summary.txt`) are production behavior. Before editing:

- `allTags.json` and `allCategories.json` are the vocabulary. A tag or category used in a prompt example that isn't in those files is a bug — this has happened (`Archive`, `Personal`), see the findings doc.
- Prompt few-shot examples must not appear verbatim in any evaluation dataset. Several currently do.
- Classification and tagging outputs are validated and retried, with a `Note` fallback for classification and unknown-tag filtering for tagging. That protects stored data but hides poor raw prompt adherence — when evaluating, score the raw first response separately from the recovered pipeline result.
- `tag_suggestion.md` and `aggregation_summary.txt` solve different problems (open-vocabulary suggestion, post-retrieval condensation) and are out of scope for the ingestion prompt work.

## Running things

```bash
npm run dev            # tsx watch, standalone API
npm run api            # one-shot standalone API
npm run mcp            # MCP server
npm test               # Jest, forced to MEMORY_DATA_ENV=test
npm run build          # tsc
npm run build:host     # esbuild bundle for HomeBase
npm run typecheck:host # host tsconfig

npm run databases:up   # Qdrant + Neo4j via docker compose
npm run seed:dev       # seed development
npm run refresh:test   # reset + reseed test
npm run verify:data-isolation

npm run eval:category  # existing single-metric evaluators
npm run eval:tagging
```

Every eval and test script is pinned to `MEMORY_DATA_ENV=test` through its package script. Keep it that way when adding one.

## Things to be careful about

- Don't modify `seedMemories.json` for testing. It is curated production seed data, and it doubles as the closest thing to ground truth this project has.
- Don't add `sampleMemories.json` content to production seed.
- Don't instantiate `VectorService` without `config.QDRANT_COLLECTION_NAME`, or `GraphService` without `config.NEO4J_URI` and `config.NEO4J_DATABASE`.
- Neo4j Community can't create per-environment databases — the default is one instance per environment on ports 7687/7688/7689.
- Neo4j is optional; the API degrades gracefully when it's unavailable. Don't make graph features hard dependencies of core retrieval.
- Changing a prompt or the tag/category vocabulary should invalidate rendered-prompt caches. They're currently keyed only by input.
- When changing anything under `src/services/`, check whether it needs to work identically standalone and under HomeBase.
