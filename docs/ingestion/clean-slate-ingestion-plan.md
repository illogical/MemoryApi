# Clean-Slate Ingestion — Implementation Plan

**Card:** MA-8  
**Date:** 2026-04-19  
**Phase:** Before retrieval upgrades — establish a trustworthy baseline first

---

## Why This Phase Exists

The project is still in the *refine ingestion and metadata* phase. Before adding richer retrieval, the reset/reload workflow must be deterministic and all three stores (Qdrant, Neo4j, SQLite) must start genuinely clean. Without that guarantee, every ingestion experiment is ambiguous.

Priority order for this phase:
1. Make clean reset + reload reliable across all stores
2. Verify seed ingestion from a real clean slate
3. Improve metadata captured at ingestion time
4. Enrich the graph beyond flat tags/categories
5. Establish eval-ready seed fixtures for future prompt evaluations

---

## Current State — Reset Gaps

| Store | Cleared by `resetVectorAndGraph.ts` | Cleared by `loadSeedMemories.ts` |
|-------|------|------|
| Qdrant | Yes | Yes |
| Neo4j | Yes | No |
| SQLite | **No** | **No** |

`initSqlDb.ts` only creates tables — it never purges data. Neither existing script provides a true full-system clean slate.

---

## Success Criteria

- `npm run reset:full` clears Qdrant + Neo4j + SQLite and reloads seeds in one command
- Post-ingestion report shows matching counts across all three stores
- New metadata fields (`sourceType`, `durability`, `dataset`, `ingestionBatchId`) are stored in all three stores
- Neo4j contains `Tool`, `Project`, `Topic` node types with typed relationships
- Seed memories with explicit entity values carry them through without LLM override
- Curated seed entries serve as ground truth for a future `evaluateEntityExtraction.ts` eval

---

## Implementation Order

### Step 1 — E2 + B1: Fix `getCategoryCounts()` and build verification report

**Rationale:** The verification report is only trustworthy if the underlying count functions are accurate. Fix the bug first, then build the report on top of real numbers.

**Files:**
- `src/services/vectorService.ts` — fix `getCategoryCounts()` to return actual per-category counts, not `1 if non-empty`
- `src/services/memoryReportService.ts` — add `generateVerificationReport()` method that queries all three stores and prints/returns a cross-store summary

**New `generateVerificationReport()` output structure:**
```typescript
interface IngestionVerificationReport {
  timestamp: string;
  qdrantCount: number;
  neo4jMemoryCount: number;
  neo4jRelationshipCount: number;
  sqliteMemoryCount: number;
  categoryDistribution: Record<string, number>;
  tagFrequency: Record<string, number>;
  storeCountsMatch: boolean;
  warnings: string[];
}
```

---

### Step 2 — A1: Create `resetAllAndLoadSeeds.ts` + `"reset:full"` npm script

**Rationale:** The core operational improvement. One script that is unambiguously a full reset.

**File to create:** `src/scripts/resetAllAndLoadSeeds.ts`

**Script sequence:**
1. Load config (reuse `configService`)
2. Purge Qdrant collection (`vectorService.deleteCollection()`)
3. Purge Neo4j graph data (`graphService.clearAllData()`)
4. Delete SQLite file at `data/memory.db`, then recreate via `initSqlDb` logic (or call `initSqlDb` as a module)
5. Re-initialize vector + graph schemas (`orchestrator.initialize()`)
6. Load inference model
7. Ingest `src/samples/seedMemories.json` via the existing pipeline
8. Call `memoryReportService.generateVerificationReport()` and print results

**`package.json` addition:**
```json
"reset:full": "npx tsx src/scripts/resetAllAndLoadSeeds.ts"
```

**Reuse from:** `resetVectorAndGraph.ts` (steps 2–7 pattern), `initSqlDb.ts` (table creation SQL)

---

### Step 3 — A2: Add warning logs to partial-reset scripts

**Files:**
- `src/scripts/resetVectorAndGraph.ts` — add console warning: `"WARNING: This script does not clear SQLite state. Use reset:full for a true clean slate."`
- `src/scripts/loadSeedMemories.ts` — add console warning: `"WARNING: This script does not clear Neo4j or SQLite state."`

---

### Step 4 — Schema: Update `initSqlDb.ts` with new metadata columns

**Rationale:** `initSqlDb.ts` is the schema source of truth. Update it before any service-layer changes so fresh installs and `resetAllAndLoadSeeds.ts` both get the correct schema.

**New columns for the `Memories` table:**
```sql
SourceType TEXT,          -- 'explicit-user-memory' | 'seed-import' | 'eval-fixture' | 'agent-captured'
Durability TEXT,          -- 'durable' | 'temporary' | 'historical' | 'working'
Dataset TEXT,             -- 'prod' | 'dev' | 'test'
IngestionBatchId TEXT,    -- e.g. '2026-04-19-reset-01'
UserReviewed TEXT         -- 'auto' | 'human-confirmed' | 'corrected'
```

**New index:**
```sql
CREATE INDEX IF NOT EXISTS idx_memories_sourcetype ON Memories(SourceType);
CREATE INDEX IF NOT EXISTS idx_memories_ingestionbatchid ON Memories(IngestionBatchId);
```

---

### Step 5 — C1: Extend `Memory` interface + storage paths + `ingestionContext` threading

#### 5a. New enums and types

**File: `src/models/memorySourceType.ts`** (create)
```typescript
export enum MemorySourceType {
  ExplicitUserMemory = 'explicit-user-memory',
  SeedImport = 'seed-import',
  EvalFixture = 'eval-fixture',
  AgentCaptured = 'agent-captured'
}
```

**File: `src/models/memoryDurability.ts`** (create)
```typescript
export enum MemoryDurability {
  Durable = 'durable',
  Temporary = 'temporary',
  Historical = 'historical',
  Working = 'working'
}
```

**File: `src/models/memoryDataset.ts`** (create)
```typescript
export enum MemoryDataset {
  Prod = 'prod',
  Dev = 'dev',
  Test = 'test'
}
```

#### 5b. Extend `Memory` interface

**File: `src/models/memory.ts`**
```typescript
import { MemorySourceType } from './memorySourceType';
import { MemoryDurability } from './memoryDurability';
import { MemoryDataset } from './memoryDataset';

export interface Memory {
  Content: string;
  LastUpdated: string;
  Category?: MemoryCategory;
  Description?: string;
  Tags?: string[];
  Status?: MemoryStatus;
  // New metadata fields
  SourceType?: MemorySourceType;
  Durability?: MemoryDurability;
  Dataset?: MemoryDataset;
  IngestionBatchId?: string;
  UserReviewed?: string;   // 'auto' | 'human-confirmed' | 'corrected'
  // Entity fields (set explicitly on seeds; LLM-inferred on live adds)
  Tools?: string[];
  Projects?: string[];
  Topics?: string[];
}
```

#### 5c. `ingestionContext` threading

The `ingestionBatchId` and `sourceType` are generated once per script run. Thread them as an optional parameter so there's no module-level global:

```typescript
// New type in src/models/ingestionContext.ts
export interface IngestionContext {
  batchId: string;
  sourceType: MemorySourceType;
  dataset: MemoryDataset;
}
```

**`MemoryRAGSystem.upsertMemory()`** — add optional parameter:
```typescript
async upsertMemory(memory: Memory, ingestionContext?: IngestionContext): Promise<string>
```

Before calling `orchestrator.addMemory()`, merge context into memory:
```typescript
if (ingestionContext) {
  memory.IngestionBatchId = ingestionContext.batchId;
  memory.SourceType = ingestionContext.sourceType;
  memory.Dataset = ingestionContext.dataset;
}
```

**`VectorService.upsertMemory()`** — extend payload to include new fields  
**`GraphService.upsertMemory()`** — store `sourceType`, `durability`, `dataset` as Memory node properties  
**`SqlService.addMemory()`** — INSERT new columns

---

### Step 6 — C2: Extend `SeedMemory` schema + update `seedMemories.json`

#### 6a. Extend `SeedMemory` interface

**File: `src/models/seedMemory.ts`**
```typescript
export interface SeedMemory {
  content: string;
  description?: string;
  category?: string;
  tags?: string[];
  // Explicit metadata (overrides inference; used as eval ground truth)
  sourceType?: string;
  durability?: string;
  dataset?: string;
  tools?: string[];
  projects?: string[];
  topics?: string[];
  // Eval fixture fields (Step 10)
  isRealUserMemory?: boolean;
  isEvalFixture?: boolean;
  expectedUseCase?: string;
  shouldBeDiscoverableBy?: string[];
}
```

#### 6b. `SeedMemoryLoader` — pass explicit values through

**File: `src/services/seedMemoryLoader.ts`**  
In `loadSeedMemoriesToMemoryObjects()`, if the seed entry has explicit `tools`, `projects`, `topics`, `durability`, `sourceType` — map them directly to the `Memory` object. Do **not** default to `MemorySourceType.SeedImport` for `sourceType` if the seed entry already declares one.

#### 6c. Update `src/samples/seedMemories.json`

For each existing seed entry, add hand-curated ground-truth values for:
- `sourceType` — most will be `"seed-import"` or `"explicit-user-memory"`
- `durability` — e.g., `"durable"` for preferences, `"historical"` for events
- `tools` — any software tools mentioned (e.g., `["VS Code", "FancyZones"]`)
- `projects` — any project references (e.g., `["MemoryApi"]`)
- `topics` — thematic topics (e.g., `["prompt-engineering", "productivity"]`)

These values are the **eval ground truth** for entity extraction.

---

### Step 7 — D2 + D1: Tag normalization + entity extraction

#### 7a. D2: Normalization helpers

**File: `src/utils/normalization.ts`** (create)
```typescript
export function normalizeTag(tag: string): string
// Rules: trim, lowercase, singular, remove articles

export function normalizeTags(tags: string[]): string[]
// Map + deduplicate

export function normalizeEntityName(name: string): string
// Title-case, trim, canonical synonyms (VS Code → VS Code, vscode → VS Code)
```

Apply `normalizeTags()` in:
- `MemoryTextProcessor.summarizeClassifyAndTagTextParallel()` — after LLM returns tags
- `SeedMemoryLoader.loadSeedMemoriesToMemoryObjects()` — before storing seed tags
- `GraphService.upsertMemory()` — before creating Tag nodes

#### 7b. D1: Entity extraction

**New prompt: `src/prompts/entity_extraction.txt`**
```
You are an entity extractor. Given a memory, extract the following:
- tools: software tools, apps, CLIs, or platforms mentioned
- projects: project names referenced
- topics: abstract topics or domains this memory relates to

Return ONLY valid JSON in this format:
{"tools":[],"projects":[],"topics":[]}

Memory: {{content}}
```

**`MemoryTextProcessor`** — add:
```typescript
async extractEntities(content: string): Promise<{ tools: string[]; projects: string[]; topics: string[] }>
```

Called from `summarizeClassifyAndTagTextParallel()` as a 5th parallel operation. Result is normalized via `normalizeEntityName()`.

**Seeded memories with explicit values skip LLM extraction** — in the ingestion path, if `Memory.Tools`, `Memory.Projects`, `Memory.Topics` are already set (from seed), do not call `extractEntities()`.

**`GraphService` — new node types and relationships:**
```cypher
MERGE (t:Tool {name: $name})
MERGE (m)-[:USES_TOOL]->(t)

MERGE (p:Project {name: $name})
MERGE (m)-[:RELATES_TO_PROJECT]->(p)

MERGE (tp:Topic {name: $name})
MERGE (m)-[:ABOUT_TOPIC]->(tp)
```

Add uniqueness constraints for `Tool.name`, `Project.name`, `Topic.name` in `graphService.initializeSchema()`.

---

### Step 8 — B2: Admin memory export

#### 8a. MCP tool

**File: `src/app/memoryMcpServer.ts`** — add tool `list_all_memories`:
- Calls `sqlService.getAllMemories()` (add this method to `SqlService`)
- Returns ID, Content, Category, SourceType, Durability, Dataset, Tags, IngestionBatchId per record
- Optional filter params: `sourceType`, `dataset`, `category`

#### 8b. HTTP endpoint

**File: `src/app/memoryAPI.ts`** — add `GET /admin/memories`:
- Same underlying `sqlService.getAllMemories()` call
- Supports query params: `?sourceType=seed-import&dataset=dev`
- Returns JSON array

**New `SqlService` method:**
```typescript
async getAllMemories(filters?: { sourceType?: string; dataset?: string; category?: string }): Promise<MemoryWithId[]>
```

---

### Step 9 — E1: Eval metadata + `evaluateEntityExtraction.ts`

#### 9a. `seedMemories.json` eval fields

For seed entries that will serve as eval fixtures, add:
```json
"isEvalFixture": true,
"expectedUseCase": "tool-recall",
"shouldBeDiscoverableBy": ["semantic", "graph"]
```

#### 9b. New eval script

**File: `src/scripts/evaluateEntityExtraction.ts`**

Pattern mirrors `evaluateTagging.ts`:
1. Load `seedMemories.json`
2. For each seed with explicit `tools`, `projects`, `topics` — run `extractEntities()` on the content
3. Compare LLM output vs. ground truth (exact match + fuzzy match after normalization)
4. Report precision/recall per entity type and per model

**`package.json` addition:**
```json
"eval:entities": "npx tsx src/scripts/evaluateEntityExtraction.ts --model=phi-4 --provider=lmstudio"
```

---

## Verification Checklist

After running `npm run reset:full`:

- [ ] Console output: Qdrant count = Neo4j memory-node count = SQLite memory count = seed file entry count
- [ ] No stale SQL rows from prior runs (wipe + reinit confirmed in log)
- [ ] Neo4j browser shows `Tool`, `Project`, `Topic` nodes with `USES_TOOL`, `RELATES_TO_PROJECT`, `ABOUT_TOPIC` relationships
- [ ] Seed entry with explicit `sourceType: "explicit-user-memory"` stores that value (not overwritten to `seed-import`)
- [ ] Seed entry with explicit `tools: ["VS Code"]` stores `Tools: ["VS Code"]` (no LLM extraction override)
- [ ] Category distribution in verification report matches actual Qdrant counts
- [ ] `npm run eval:entities` produces precision/recall output for at least one entity type

---

## File Summary

| File | Action |
|------|--------|
| `src/models/memory.ts` | Extend interface with new metadata + entity fields |
| `src/models/memorySourceType.ts` | Create |
| `src/models/memoryDurability.ts` | Create |
| `src/models/memoryDataset.ts` | Create |
| `src/models/ingestionContext.ts` | Create |
| `src/models/seedMemory.ts` | Extend with explicit metadata + eval fields |
| `src/scripts/initSqlDb.ts` | Add new columns + indexes |
| `src/scripts/resetAllAndLoadSeeds.ts` | Create (full 3-store reset + reload) |
| `src/scripts/resetVectorAndGraph.ts` | Add partial-reset warning |
| `src/scripts/loadSeedMemories.ts` | Add partial-reset warning |
| `src/scripts/evaluateEntityExtraction.ts` | Create |
| `src/services/vectorService.ts` | Fix `getCategoryCounts()`; extend payload |
| `src/services/graphService.ts` | Add Tool/Project/Topic node types + constraints |
| `src/services/sqlService.ts` | Add new columns to INSERT; add `getAllMemories()` |
| `src/services/memoryRAGSystem.ts` | Add `ingestionContext` param to `upsertMemory()` |
| `src/services/memoryTextProcessor.ts` | Add `extractEntities()` step |
| `src/services/memoryReportService.ts` | Add `generateVerificationReport()` |
| `src/services/seedMemoryLoader.ts` | Pass explicit entity values through to Memory |
| `src/utils/normalization.ts` | Create tag/entity normalization helpers |
| `src/prompts/entity_extraction.txt` | Create entity extraction prompt |
| `src/app/memoryMcpServer.ts` | Add `list_all_memories` MCP tool |
| `src/app/memoryAPI.ts` | Add `GET /admin/memories` endpoint |
| `src/samples/seedMemories.json` | Add curated ground-truth entity values |
| `package.json` | Add `reset:full`, `eval:entities` scripts |
