# Metadata Cleanup: Removal of Provenance and Eval Fields

## Background

Seven metadata fields were added during early development to support an evaluation harness and multi-environment dataset management. As the project matured, they added maintenance burden without proportional value and were removed in a single cleanup pass.

## Fields Removed

### Persisted fields (stored in SQLite, Neo4j, and Qdrant)

| Field | Type | What it tracked | Why removed |
|---|---|---|---|
| `SourceType` | Enum (`explicit-user-memory`, `seed-import`, `eval-fixture`, `agent-captured`) | Origin/provenance of the memory | Filterable in admin API and MCP, but never meaningfully exercised — all seeds used `explicit-user-memory` or `seed-import` |
| `Durability` | Enum (`durable`, `temporary`, `historical`, `working`) | Intended lifecycle classification | Stored across all three databases but never queried or filtered anywhere in code |
| `Dataset` | Enum (`prod`, `dev`, `test`) | Environment namespace isolation | Filterable, but all seed entries were `dev` — no practical multi-environment usage |

### Eval-only fields (existed only in `seedMemories.json` and `SeedMemory` interface; never persisted)

| Field | Type | What it tracked | Why removed |
|---|---|---|---|
| `isRealUserMemory` | `boolean` | Distinguished real user memories from synthetic test data | All entries were `true`; never read by any service |
| `isEvalFixture` | `boolean` | Flagged seeds written for evaluation scenarios | Scaffolding for an eval framework that was never built |
| `expectedUseCase` | `string` | Documented the test intent for a fixture | Every occurrence was `"tool-recall"` — no variation |
| `shouldBeDiscoverableBy` | `string[]` | Expected retrieval methods for eval validation | Every occurrence was `["semantic", "graph"]` — no variation |

## What Was Lost

- The ability to filter memories by source origin or environment in `/admin/memories` and the `list_all_memories` MCP tool (those filter params were removed).
- The lifecycle intent metadata on individual memories.
- The scaffolding for a future evaluation harness.

## Files Changed

| File | Change |
|---|---|
| `src/samples/seedMemories.json` | Stripped all 7 fields from all 26 entries |
| `src/models/seedMemory.ts` | Removed all 7 field declarations |
| `src/models/memory.ts` | Removed `SourceType`, `Durability`, `Dataset` fields and enum imports |
| `src/models/memoryDurability.ts` | Deleted |
| `src/models/memoryDataset.ts` | Deleted |
| `src/models/memorySourceType.ts` | Deleted |
| `src/models/ingestionContext.ts` | Removed `sourceType` and `dataset`; interface now contains only `batchId` |
| `src/services/seedMemoryLoader.ts` | Removed field mappings from both load methods |
| `src/services/memoryRAGSystem.ts` | Removed 3 fields from `upsertMemory` ingestion context merge and `addMemory` metadata call |
| `src/services/sqlService.ts` | Removed columns from `CREATE TABLE`, migration add-column list, `INSERT`, `getAllMemories` SELECT/WHERE, and `idx_memories_sourcetype` index; added `DROP COLUMN` migration for existing databases |
| `src/services/graphService.ts` | Removed `sourceType`, `durability`, `dataset` params and SET clauses from `upsertMemory` |
| `src/services/vectorService.ts` | Removed `SourceType`, `Durability`, `Dataset` from Qdrant payload |
| `src/app/memoryAPI.ts` | Removed `sourceType` and `dataset` query params from `/admin/memories` |
| `src/app/memoryMcpServer.ts` | Removed `sourceType` and `dataset` from `list_all_memories` tool schema and description |
| `src/scripts/resetAllAndLoadSeeds.ts` | Removed `MemorySourceType`/`MemoryDataset` imports and enum assignments from ingestion context; updated `validateMemoryPopulation` call |

## Database Migration

Existing SQLite databases are migrated automatically on next startup. The `initializeSchema` method in `SqlService` now includes `ALTER TABLE Memories DROP COLUMN` statements for `SourceType`, `Durability`, and `Dataset`. These are wrapped in try/catch so they are safe to run against both old (with columns) and new (without) databases.
