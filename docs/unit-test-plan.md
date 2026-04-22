# Unit Test Plan — MemoryApi

## Overview

This document outlines the initial test suite for the MemoryApi project. The primary goal is **regression coverage** — a safety net that catches breakage as features and improvements are added. The plan is structured into three tiers:

1. **Prerequisite refactoring** — small structural changes to make the code testable without altering behavior
2. **Unit tests** — fast, isolated, no external services
3. **Integration tests** — real SQLite (in-memory), mocked LLM and vector/graph stores

End-to-end tests against live Qdrant/Neo4j/LLM are out of scope for this initial plan. They should be addressed in a separate integration-environment plan.

---

## Part 1 — Prerequisite Refactoring

These changes are required before the tests below can be written. None of them change observable behavior; they only improve seam points.

### 1.1 Install the test runner

```bash
npm install --save-dev jest @types/jest ts-jest
```

Add to `package.json`:

```json
{
  "scripts": {
    "test": "jest",
    "test:watch": "jest --watch",
    "test:coverage": "jest --coverage"
  },
  "jest": {
    "preset": "ts-jest/presets/default-esm",
    "testEnvironment": "node",
    "extensionsToTreatAsEsm": [".ts"],
    "moduleNameMapper": {
      "^(\\.{1,2}/.*)\\.js$": "$1"
    },
    "testMatch": ["**/__tests__/**/*.test.ts"],
    "collectCoverageFrom": ["src/**/*.ts", "!src/scripts/**", "!src/raycast/**"]
  }
}
```

### 1.2 ConfigService — accept injected config

**Current problem:** `ConfigService` reads `process.env` at module load time, so tests cannot override values without mutating the global environment.

**Change:** Make the constructor accept an optional partial config object that overrides defaults. The singleton instance continues to work unchanged; tests can construct a fresh instance with test values.

```typescript
// Before
class ConfigService {
  readonly LLM_HOST = process.env.LLM_HOST ?? 'http://localhost:11434';
}

// After
class ConfigService {
  readonly LLM_HOST: string;
  constructor(overrides: Partial<ConfigValues> = {}) {
    this.LLM_HOST = overrides.LLM_HOST ?? process.env.LLM_HOST ?? 'http://localhost:11434';
    // ... same pattern for all properties
  }
}
```

The default exported singleton (`new ConfigService()`) is unaffected.

### 1.3 SqlService — accept an injected database instance

**Current problem:** `SqlService` opens a real SQLite file in its constructor.

**Change:** Accept an optional `sqlite3.Database` in the constructor. When omitted, behavior is identical to today. In tests, pass an in-memory database.

```typescript
constructor(config: ConfigService, db?: sqlite3.Database) {
  this.db = db ?? new sqlite3.Database(config.SQLITE_DB_PATH);
}
```

### 1.4 Extract `mergeVectorAndGraphResults` into a pure function

**Current problem:** The merge/deduplication logic in `MemoryPostSearchAggregator` is buried inside a method that also calls the LLM and writes to SQL.

**Change:** Extract `mergeVectorAndGraphResults` (currently private) into a named, exported pure function in a new file `src/utils/resultMerge.ts`. The aggregator class calls this function internally. No behavior change.

```typescript
// src/utils/resultMerge.ts
export function mergeVectorAndGraphResults(
  vectorResults: ScoredMemory[],
  graphResults: ScoredMemory[],
  options: MergeOptions
): ScoredMemory[] { ... }
```

### 1.5 Extract LLM retry wrapper into a standalone utility

**Current problem:** `withLLMRetry` and `filterValidTags` are private methods inside `MemoryTextProcessor`.

**Change:** Move them to `src/utils/llmUtils.ts` as named exports. The class methods become thin wrappers that call them. No behavior change.

```typescript
// src/utils/llmUtils.ts
export async function withLLMRetry<T>(
  fn: () => Promise<T>,
  validate: (result: T) => boolean,
  maxAttempts: number
): Promise<T> { ... }

export function filterValidTags(
  rawTags: string[],
  allowedTags: string[]
): string[] { ... }
```

### 1.6 Inject dependencies into RAGOrchestrator and MemoryRAGSystem

**Current problem:** Both classes instantiate their dependencies internally (e.g., `new VectorService()`), making it impossible to swap in test doubles.

**Change:** Accept dependencies through the constructor. Existing call sites pass the real instances; tests pass mocks.

```typescript
// Before
class RAGOrchestrator {
  private vectorService = new VectorService(config);
  private graphService = new GraphService(config);
}

// After
class RAGOrchestrator {
  constructor(
    private vectorService: VectorService,
    private graphService: GraphService,
    private sqlService: SqlService,
    private reminderService: ReminderService,
    private logger: LoggingService
  ) {}
}
```

Apply the same pattern to `MemoryRAGSystem`, `MemoryTextProcessor`, `MemoryPostSearchAggregator`, and `ReviewMemoriesService`.

### 1.7 Make ModelClient an interface

Extract a `ModelClient` interface (if one does not already exist) so that unit tests can pass a simple stub without importing LM Studio or Ollama dependencies:

```typescript
// src/models/ModelClient.ts
export interface ModelClient {
  chat(messages: ChatMessage[]): Promise<string>;
  loadModel(modelId: string): Promise<void>;
}

export interface EmbeddingClient {
  embed(text: string): Promise<number[]>;
}
```

---

## Part 2 — Unit Tests

All unit tests live in `src/__tests__/unit/`. They run with no external services. Dependencies are mocked with Jest.

### 2.1 `normalization.ts` — Tag & entity normalization

**File:** `src/__tests__/unit/normalization.test.ts`
**Why first:** Pure functions, zero setup — the simplest possible regression net.

| Test case | Input | Expected output |
|---|---|---|
| Lowercase conversion | `"TypeScript"` | `"typescript"` |
| Trim whitespace | `" react "` | `"react"` |
| Plural stripping (regular) | `"snippets"` → normalizeTag | `"snippet"` |
| Irregular plural preserved | Entry from IRREGULAR_PLURALS lookup | Correct mapped form |
| Deduplicate duplicate tags | `["ai", "ai", "AI"]` | `["ai"]` |
| Entity synonym resolution | Known synonym entry | Canonical form |
| Entity title-casing | `"typescript"` (no synonym) | `"TypeScript"` (or as-is) |
| Empty array input | `[]` | `[]` |
| Mixed valid/invalid entities | Array with empty strings | Empties filtered out |

### 2.2 `ConfigService` — Configuration loading

**File:** `src/__tests__/unit/configService.test.ts`
**Requires:** Refactoring 1.2

| Test case | Setup | Assertion |
|---|---|---|
| Uses default values when env not set | No env vars | Default values match hardcoded constants |
| Override from env var | `process.env.PORT = '8080'` | `config.PORT === 8080` |
| Constructor override takes precedence over env | `{ PORT: 9090 }` + `process.env.PORT = '8080'` | `config.PORT === 9090` |
| Numeric env vars parsed correctly | `process.env.AGGREGATION_MAX_MEMORIES = '50'` | Returns number `50`, not string `"50"` |
| Missing optional vars do not throw | No Todoist key set | No exception; returns empty string or default |

### 2.3 `PromptTemplateService` — Template loading and rendering

**File:** `src/__tests__/unit/promptTemplateService.test.ts`

Mock `fs.readFileSync` to return predictable template strings.

| Test case | Description |
|---|---|
| `renderClassification` inserts category list | Verify `{{CATEGORIES}}` placeholder is replaced |
| `renderTagging` inserts tag list | Verify `{{TAGS}}` placeholder is replaced |
| `renderMemorySummary` inserts content | Verify `{{CONTENT}}` placeholder is replaced |
| Template is cached after first load | `readFileSync` called once per template per run |
| `getValidCategories()` returns all MemoryCategory values | No external dependency needed |
| `getValidTags()` returns non-empty array | Tags sourced from internal constant |
| Missing template file throws descriptive error | Mock `readFileSync` to throw ENOENT |

### 2.4 `resultMerge.ts` — Vector + graph result merging

**File:** `src/__tests__/unit/resultMerge.test.ts`
**Requires:** Refactoring 1.4

This is the most valuable pure-logic test in the aggregation pipeline.

| Test case | Description |
|---|---|
| Deduplication by memory ID | Same ID from vector and graph → one result |
| Score normalization — vector only | Entry missing from graph gets penalized/neutral graph score |
| Score normalization — graph only | Entry missing from vector gets penalized/neutral vector score |
| Ranking order | Higher combined score ranked first |
| Empty vector results | Returns graph results with normalized scores |
| Empty graph results | Returns vector results with normalized scores |
| Both empty | Returns empty array |
| Score threshold filtering | Results below configured threshold are excluded |
| Maximum result count respected | More than max returned by stores → capped at max |
| Exact score tie-breaking | Deterministic order for ties |

### 2.5 `llmUtils.ts` — Retry and tag filtering

**File:** `src/__tests__/unit/llmUtils.test.ts`
**Requires:** Refactoring 1.5

| Test case | Description |
|---|---|
| `withLLMRetry` — succeeds first attempt | Mock returns valid result; called once |
| `withLLMRetry` — fails then succeeds | First call invalid, second valid; called twice |
| `withLLMRetry` — exhausts attempts | All attempts invalid; throws after `maxAttempts` |
| `withLLMRetry` — propagates non-validation errors | Network error on attempt 1; re-thrown immediately |
| `filterValidTags` — removes unknown tags | Raw tags not in allowed list are dropped |
| `filterValidTags` — case-insensitive matching | `"TypeScript"` matched against `"typescript"` |
| `filterValidTags` — empty raw input | Returns `[]` |
| `filterValidTags` — all tags valid | All returned unchanged |

### 2.6 `LoggingService` — Log level filtering

**File:** `src/__tests__/unit/loggingService.test.ts`

Spy on `console.log` and `fs.createWriteStream` to avoid file I/O.

| Test case | Description |
|---|---|
| `log('debug', ...)` suppressed at INFO level | `console.log` not called |
| `log('info', ...)` emitted at INFO level | `console.log` called with message |
| `log('error', ...)` always emitted | Even at quiet log level |
| Message includes timestamp | Output string matches timestamp pattern |
| `close()` ends stream | No further writes after close |

### 2.7 `ReminderService` — Todoist integration

**File:** `src/__tests__/unit/reminderService.test.ts`

Mock global `fetch`.

| Test case | Description |
|---|---|
| Successful task creation | `fetch` called with correct Todoist endpoint and body |
| Bearer token included in headers | Authorization header matches `TODOIST_API_KEY` |
| Network error does not throw | `fetch` rejects; `createTask` resolves without error |
| Timeout after 5 seconds | `AbortController` signal triggers; no exception propagated |
| Missing API key — skips call | If key is empty string, `fetch` not called |

### 2.8 `ModelClientFactory` — Provider selection

**File:** `src/__tests__/unit/modelClients.test.ts`

| Test case | Description |
|---|---|
| `LLM_PROVIDER=ollama` returns `OllamaModelClient` | Factory returns correct concrete type |
| `LLM_PROVIDER=lmstudio` returns `LMStudioModelClient` | Factory returns correct concrete type |
| `LLM_PROVIDER=lmapi` returns `LMApiClient` | Factory returns correct concrete type |
| Unknown provider throws | Invalid provider name → descriptive error |

### 2.9 `MemoryTextProcessor` — Classification and tagging logic

**File:** `src/__tests__/unit/memoryTextProcessor.test.ts`
**Requires:** Refactoring 1.5, 1.6

Mock `ModelClient` to return controlled strings. Tests verify parsing/validation, not LLM accuracy.

| Test case | Description |
|---|---|
| Valid category string accepted on first attempt | Mock returns valid category; no retry |
| Invalid category triggers retry | First response garbage; second valid; retried once |
| Valid tag list accepted | Mock returns known tags; filtered list returned |
| Unknown tags stripped by `filterValidTags` | Mock includes unknown tags; they are removed |
| Entity extraction — tools parsed correctly | Mock returns JSON with tools array; mapped to entities |
| Entity extraction — malformed JSON retried | First response not JSON; second valid |
| All LLM calls are parallel in `summarizeClassifyAndTagTextParallel` | Verify `Promise.all` behavior via mock ordering |

### 2.10 `MemoryPostSearchAggregator` — Aggregation strategy selection

**File:** `src/__tests__/unit/memoryPostSearchAggregator.test.ts`
**Requires:** Refactoring 1.4, 1.6

Mock `ModelClient`, `SqlService`, and `RAGOrchestrator`. Test strategy routing, not LLM output.

| Test case | Description |
|---|---|
| Result count below threshold → linear strategy | `aggregateMemories` called with small set → uses linear |
| Result count above threshold → cluster strategy | Large set → uses cluster-category or hybrid |
| Zero results → returns empty response | No LLM call made |
| Memories serialized within char limit | Content truncated to `CONTENT_MAX_CHARS` |
| Search history recorded after aggregation | `sqlService.addSearchHistory` called once |
| LLM prompt includes all memory content | Verify rendered prompt contains expected text |

### 2.11 `RAGOrchestrator` — Parallel database coordination

**File:** `src/__tests__/unit/ragOrchestrator.test.ts`
**Requires:** Refactoring 1.6

Mock `VectorService`, `GraphService`, `SqlService`, `ReminderService`.

| Test case | Description |
|---|---|
| `addMemory` writes to vector and graph | Both service methods called with same memory |
| `addMemory` with Reminder category creates Todoist task | `reminderService.createTask` called |
| `addMemory` with non-Reminder category skips Todoist | `reminderService.createTask` not called |
| Vector write failure propagates | Mock vector throws; `addMemory` rejects |
| Graph write failure propagates | Mock graph throws; `addMemory` rejects |
| `deleteMemory` calls all three stores | vector, graph, and SQL delete all called |
| `getDatabaseStatus` aggregates counts | Returns combined count from all stores |
| `searchVectorAndGraphParallel` merges results | Both searches run; results returned as tuple |

### 2.12 `ReviewMemoriesService` — Queue management

**File:** `src/__tests__/unit/reviewMemoriesService.test.ts`
**Requires:** Refactoring 1.6

Mock `SqlService` and `MemoryRAGSystem`.

| Test case | Description |
|---|---|
| `addToQueue` generates metadata via RAGSystem | `memoryRAGSystem.processMetadata` (or equivalent) called |
| `addToQueue` persists to SQL | `sqlService.addMemory` called with status=Queued |
| `getQueue` returns pending items | Delegates to `sqlService.getMemoriesByStatus` |
| `updateQueueItem` merges changes | SQL update called with merged fields |
| `deleteFromQueue` removes item | SQL soft-delete called |
| `commitMemory` upserts to vector and graph | RAGOrchestrator.addMemory called after commit |
| `commitMemory` removes from queue | Queue entry deleted after successful commit |

---

## Part 3 — Integration Tests

Integration tests live in `src/__tests__/integration/`. They use a **real in-memory SQLite database** and mock the LLM and vector/graph stores. This catches SQL schema issues and data-flow bugs that unit tests miss.

### 3.1 Setup: shared test fixtures

Create `src/__tests__/integration/setup.ts`:

```typescript
import sqlite3 from 'sqlite3';
import { SqlService } from '../../services/sqlService.js';
import { ConfigService } from '../../services/configService.js';

export function createTestSqlService(): SqlService {
  const db = new sqlite3.Database(':memory:');
  const config = new ConfigService({ SQLITE_DB_PATH: ':memory:' });
  return new SqlService(config, db);
}

export const mockModelClient = {
  chat: jest.fn().mockResolvedValue(''),
  loadModel: jest.fn().mockResolvedValue(undefined),
};

export const mockVectorService = {
  upsertMemory: jest.fn().mockResolvedValue(undefined),
  searchMemoriesWithEmbedding: jest.fn().mockResolvedValue([]),
  deleteMemory: jest.fn().mockResolvedValue(undefined),
  getMemoryById: jest.fn().mockResolvedValue(null),
  getCategoryCounts: jest.fn().mockResolvedValue({}),
};

export const mockGraphService = {
  upsertMemory: jest.fn().mockResolvedValue(undefined),
  vectorSearch: jest.fn().mockResolvedValue([]),
  deleteMemory: jest.fn().mockResolvedValue(undefined),
  getMemoryCount: jest.fn().mockResolvedValue(0),
};
```

### 3.2 `SqlService` — Full SQL lifecycle

**File:** `src/__tests__/integration/sqlService.test.ts`

Uses real in-memory SQLite (no mocking needed for DB itself).

| Test case | Description |
|---|---|
| Schema initialization creates all tables | `validateMemoryPopulation` succeeds after init |
| `addMemory` + `getMemory` round-trip | Inserted memory retrievable by ID |
| `updateMemory` persists changes | Modified fields returned on next read |
| `softDeleteMemory` hides record | Record excluded from `getMemoriesByStatus(Active)` |
| `updateMemoryRelations` links IDs | `vectorId` and `graphId` stored and returned |
| `addTagSuggestion` + `getSuggestedTags` | Suggested tags visible after insert |
| `dismissTagSuggestion` removes from list | Tag excluded from subsequent `getSuggestedTags` |
| `addSearchHistory` persists query | Row count increments after call |
| `getMemoryCount` returns correct total | Matches number of inserted records |
| `getAllMemories` with category filter | Returns only matching category |
| Duplicate SQL ID handled gracefully | Re-inserting same ID does not crash |

### 3.3 `MemoryRAGSystem` — Ingestion pipeline (mocked LLM)

**File:** `src/__tests__/integration/memoryRAGSystem.test.ts`
**Requires:** Refactoring 1.6, plus mocked model and vector/graph services.

| Test case | Description |
|---|---|
| `addMemory` returns memory with ID | Valid memory object returned |
| `addMemory` stores to SQL metadata | `sqlService.getMemory` returns record |
| `addMemory` calls vector upsert | `mockVectorService.upsertMemory` called once |
| `addMemory` calls graph upsert | `mockGraphService.upsertMemory` called once |
| `addMemory` with Reminder calls Todoist | `mockReminderService.createTask` called |
| `deleteMemory` removes from all stores | All three delete methods called |
| `searchMemories` delegates to vector service | `mockVectorService.searchMemoriesWithEmbedding` called |
| `searchAndSummarizeForMcp` triggers aggregation | Aggregator mock called with merged results |
| `getDatabaseStatus` aggregates from all stores | Returns counts from all three mocks |

### 3.4 `ReviewMemoriesService` — Queue + commit flow

**File:** `src/__tests__/integration/reviewMemoriesService.test.ts`

Uses real in-memory SQLite; mocks `MemoryRAGSystem`.

| Test case | Description |
|---|---|
| Add → get queue round-trip | Item visible in queue after `addToQueue` |
| Edit queued item | Changes reflected in `getQueue` |
| Reject from queue | Item no longer returned by `getQueue` |
| Commit moves item to main stores | `MemoryRAGSystem.addMemory` called; queue item removed |
| Commit with invalid ID returns error | Graceful failure; queue unchanged |

---

## Part 4 — API Route Smoke Tests

Route tests verify HTTP contract without testing business logic. Use `supertest`.

```bash
npm install --save-dev supertest @types/supertest
```

**File:** `src/__tests__/api/memoryAPI.test.ts`

Mount the router with mocked `MemoryRAGSystem` and `SqlService`.

| Endpoint | Test case | Expected status |
|---|---|---|
| `POST /api/memories` | Valid memory body | 201 |
| `POST /api/memories` | Missing required `content` field | 400 |
| `POST /api/memories` | Invalid category value | 400 |
| `GET /api/memories/:id` | Known ID | 200 with memory JSON |
| `GET /api/memories/:id` | Unknown ID | 404 |
| `PUT /api/memories/:id` | Valid update body | 200 |
| `DELETE /api/memories/:id` | Valid ID | 200 |
| `POST /api/memories/search` | Query string provided | 200 with results array |
| `POST /api/memories/search-and-summarize` | Query string provided | 200 with summary |
| `GET /api/memories/stats` | No params | 200 with category counts |
| `GET /api/status` | No params | 200 |
| `POST /api/review/queue` | Valid memory | 201 |
| `POST /api/review/commit/:id` | Valid queued ID | 200 |

---

## Part 5 — Coverage Targets

| Area | Target | Notes |
|---|---|---|
| `src/utils/normalization.ts` | 100% | Pure functions, no excuse |
| `src/utils/resultMerge.ts` | 100% | Pure functions after extraction |
| `src/utils/llmUtils.ts` | 95%+ | Retry/filter logic |
| `src/services/configService.ts` | 90%+ | Env loading |
| `src/services/sqlService.ts` | 85%+ | Integration tests cover most paths |
| `src/services/promptTemplateService.ts` | 85%+ | Mock fs |
| `src/services/memoryTextProcessor.ts` | 75%+ | LLM paths mocked |
| `src/services/memoryPostSearchAggregator.ts` | 75%+ | Aggregation routing |
| `src/services/ragOrchestrator.ts` | 70%+ | Parallel coordination |
| `src/services/reviewMemoriesService.ts` | 70%+ | Queue lifecycle |
| `src/app/memoryAPI.ts` | 70%+ | Route contract via supertest |
| `src/services/loggingService.ts` | 60%+ | Spy on output streams |
| `src/services/reminderService.ts` | 80%+ | Mock fetch |

Overall initial target: **≥ 70% statement coverage across `src/`**

---

## Part 6 — Implementation Order

Implement in this order to maximize value and minimize blocking:

1. **Test runner setup** (Part 1.1) — unblocks everything
2. **Refactoring 1.2–1.5** — enables pure-logic tests without touching orchestration
3. **Unit tests 2.1–2.5** — pure logic; no mocks needed
4. **Unit tests 2.6–2.9** — service layer with simple mocks
5. **Refactoring 1.6–1.7** — enables integration-friendly DI
6. **Integration tests 3.1–3.2** — real SQLite, no LLM
7. **Unit tests 2.10–2.12** — orchestration layer
8. **Integration tests 3.3–3.4** — full pipeline with mocked LLM
9. **API route smoke tests** (Part 4)

Each step can be merged independently. Do not skip the refactoring steps — attempting to write tests against the current structure will result in fragile tests that couple to implementation details.

---

## Appendix — Mock Patterns

### Mocking `fetch` for external HTTP calls

```typescript
global.fetch = jest.fn().mockResolvedValue({
  ok: true,
  json: async () => ({ id: 'task-123' }),
});
```

### Mocking `fs.readFileSync` for prompt templates

```typescript
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  readFileSync: jest.fn().mockReturnValue('Hello {{NAME}}'),
}));
```

### In-memory SQLite for SQL integration tests

```typescript
const db = new sqlite3.Database(':memory:');
```

### Minimal `ModelClient` stub

```typescript
const stubClient: ModelClient = {
  chat: jest.fn().mockResolvedValue('PREFERENCE'),
  loadModel: jest.fn().mockResolvedValue(undefined),
};
```

### Resetting mocks between tests

Add to `jest` config in `package.json`:

```json
"clearMocks": true,
"resetMocks": true
```
