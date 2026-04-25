# AI Agent Guidelines for MemoryAPI

## Data Environment Rules

MemoryAPI has three data environments: `production`, `development`, and `test`.

**Before writing any new test, eval, script, or seed operation:**

1. Verify `MEMORY_DATA_ENV` is set to the correct environment. Tests and evals must use `test`.
2. Never point automated tests or evals at production SQLite, Qdrant, or Neo4j targets.
3. `sampleMemories.json` is NOT production seed data. It is for `development` and `test` only.
4. `seedMemories.json` is the production seed source. Do not modify it for test purposes.
5. Production writes require `MEMORY_ALLOW_PRODUCTION_WRITES=true`. Reset/destroy scripts always refuse production.

## Memory Status Rules

Only memories with `Status = 'stored'` appear in semantic search results.

| Status     | Meaning                              | In retrieval? |
|------------|--------------------------------------|---------------|
| `draft`    | Newly created, pending human review  | No            |
| `stored`   | Reviewed and active                  | **Yes**       |
| `archived` | Retired/stale                        | No            |
| `rejected` | Human-reviewed and excluded          | No            |

When writing seeds or fixtures:
- Use `stored` for ground-truth / production-quality data (`seedMemories.json`)
- Use `draft` for candidate or sample data (`sampleMemories.json`)

## Storage Targets by Environment

Default Neo4j isolation is Community Edition compatible: one Neo4j instance per environment, with database `neo4j` in each instance. Enterprise deployments may instead use one server with `memoryapi_prod`, `memoryapi_dev`, and `memoryapi_test` databases.

| Environment | SQLite | Qdrant Collection | Neo4j Target (Community default) |
|-------------|--------|-------------------|----------------------------------|
| `production`  | `data/prod/memory.db` | `memoryapi_prod_memories` | `bolt://localhost:7687` / `neo4j` |
| `development` | `data/dev/memory.db`  | `memoryapi_dev_memories`  | `bolt://localhost:7688` / `neo4j` |
| `test`        | `data/test/memory.db` | `memoryapi_test_memories` | `bolt://localhost:7689` / `neo4j` |

## Environment Guard Usage

Import and call guards at the top of any script that writes or destroys data:

```ts
import { assertCanWriteMemory, assertNotProduction } from '../services/memoryEnvironmentService';

// Use in seed scripts (allows production with explicit opt-in via MEMORY_ALLOW_PRODUCTION_WRITES=true):
assertCanWriteMemory('myScript');

// Use in reset/eval/test scripts (always blocks production, no opt-in possible):
assertNotProduction('myScript');
```

Use `assertNotProduction` for anything that could wipe or corrupt data. Use `assertCanWriteMemory` for normal write operations that production might occasionally need (e.g., seeding).

## Seeding Policy

| Environment | Sources | Inserted as |
|-------------|---------|-------------|
| `production`  | `seedMemories.json` only | `stored` |
| `development` | `seedMemories.json` + `sampleMemories.json` | seed=`stored`, sample=`draft` |
| `test`        | `seedMemories.json` + `sampleMemories.json` | seed=`stored`, sample=`draft` |

## Available npm Scripts

```bash
npm run seed:dev          # seed development environment
npm run seed:test         # seed test environment
npm run seed:prod         # seed production (requires MEMORY_ALLOW_PRODUCTION_WRITES=true)
npm run reset:dev         # wipe development environment
npm run reset:test        # wipe test environment
npm run refresh:dev       # reset + reseed development
npm run refresh:test      # reset + reseed test
npm run neo4j:community:up  # start separate Neo4j Community instances
npm run migrate:statuses  # migrate old New/Reviewed/Archived status values
npm run verify:data-isolation  # verify all three environments are isolated
```

## What NOT to Do

- Do not use `MEMORY_DATA_ENV=production` for any automated test, eval, or script that writes or resets data.
- Do not add `sampleMemories.json` entries to production seed.
- Do not hardcode collection names (e.g., `'memories'`) — always use `config.QDRANT_COLLECTION_NAME`.
- Do not instantiate `VectorService` without passing `config.QDRANT_COLLECTION_NAME` as the second argument.
- Do not instantiate `GraphService` without passing `config.NEO4J_URI` and `config.NEO4J_DATABASE`.
- Do not assume Neo4j Community Edition can create `memoryapi_dev` or `memoryapi_test` databases; use separate Community instances or switch to Enterprise mode.
