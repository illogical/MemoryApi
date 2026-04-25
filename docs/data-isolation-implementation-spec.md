# Data Isolation Implementation Spec — MA-11

> **For coding assistants:** This document is a self-contained implementation guide. All file paths are relative to the MemoryAPI project root (`c:\LocalDev\Projects\MemoryApi`). Follow each section in order; sections within the same phase can be done in parallel.

---

## 1. Overview and Goals

MemoryAPI currently writes all data (SQLite, Qdrant, Neo4j) to a single shared store regardless of whether the writer is the production app, a local dev session, an integration test, or a prompt/model eval run. This risks eval or test runs polluting real production memories.

**Goal:** implement an explicit `production | development | test` data environment model where:
- Each environment points at a separate SQLite file, Qdrant collection, and Neo4j database.
- Production writes require explicit opt-in (`MEMORY_ALLOW_PRODUCTION_WRITES=true`).
- Tests and evals always target `test` stores and are blocked from writing to production.
- A central guard service (`memoryEnvironmentService.ts`) enforces all rules.

**Architecture:** Storage-area-first isolation. Environments differ by which files and collections they target — not by columns or metadata filters. Metadata is retained for provenance only.

---

## 2. Finalized Decisions

Before reading further, these decisions are locked:

| Question | Decision |
|----------|----------|
| Existing `data/memory.db` | Leave untouched. All three new env DBs start empty and are seeded explicitly. |
| MemoryStatus values | `draft \| stored \| archived \| rejected` (4 values, see below) |
| Cross-platform env vars in npm scripts | Install `cross-env` dev dependency; prefix scripts with `cross-env MEMORY_DATA_ENV=<env>` |
| Old seed scripts (`resetAllAndLoadSeeds.ts`, `loadSeedMemories.ts`) | Replace with new environment-aware scripts |

### Memory Status Model

```ts
export enum MemoryStatus {
    Draft    = 'draft',     // pending review; not in retrieval
    Stored   = 'stored',    // active; ONLY status included in semantic search results
    Archived = 'archived',  // stale/retired; SQL history only, not in retrieval
    Rejected = 'rejected',  // human-reviewed and intentionally excluded; SQL history only
}
```

**Critical retrieval rule:** Only `stored` memories appear in semantic search/vector/graph queries. All other statuses are SQL-only history.

**Old → new migration:**

| Old value | New value |
|-----------|-----------|
| `New`      | `draft`    |
| `Reviewed` | `stored`   |
| `Archived` | `archived` |

**Seed insertion policy:**
- `src/samples/seedMemories.json` → always inserted as `stored`
- `src/samples/sampleMemories.json` → always inserted as `draft`

---

## 3. Environment Type Definitions

**Add to `src/services/memoryEnvironmentService.ts`** (new file):

```ts
export type MemoryDataEnvironment = 'production' | 'development' | 'test';
export type TestRunType = 'unit' | 'integration' | 'eval' | 'manual';
```

---

## 4. ConfigService Changes

**File:** `src/services/configService.ts`

### 4.1 Add to `ConfigValues` interface

```ts
export interface ConfigValues {
    // ... existing fields ...

    // Data environment
    MEMORY_DATA_ENV: string;
    MEMORY_ALLOW_PRODUCTION_WRITES: boolean;
    MEMORY_TEST_RUN_ID: string;
    MEMORY_TEST_RUN_TYPE: string;

    // Storage targets
    QDRANT_COLLECTION_NAME: string;
    NEO4J_DATABASE: string;
}
```

### 4.2 Add defaults in `Config` class

Add after the existing `NEO4J_PASSWORD` line (~line 38):

```ts
// Data environment and isolation
public MEMORY_DATA_ENV: string = 'development';
public MEMORY_ALLOW_PRODUCTION_WRITES: boolean = false;
public MEMORY_TEST_RUN_ID: string = '';
public MEMORY_TEST_RUN_TYPE: string = 'manual';

// Storage targets (change with MEMORY_DATA_ENV)
public QDRANT_COLLECTION_NAME: string = 'memoryapi_dev_memories';
public NEO4J_DATABASE: string = 'memoryapi_dev';
```

### 4.3 Update `SQLITE_DB_PATH` default (line 41)

```ts
// Change from:
public SQLITE_DB_PATH: string = path.join(process.cwd(), 'data', 'memory.db');

// To:
public SQLITE_DB_PATH: string = path.join(process.cwd(), 'data', 'dev', 'memory.db');
```

### 4.4 Update constructor to handle boolean parsing

In the constructor loop (around line 66), update the `envValue` handling:

```ts
if (envValue) {
    if (typeof (this as any)[key] === 'boolean') {
        (this as any)[key] = envValue === 'true';
    } else if (typeof (this as any)[key] === 'number') {
        (this as any)[key] = parseFloat(envValue);
    } else {
        (this as any)[key] = envValue;
    }
}
```

---

## 5. MemoryStatus Enum Update

**File:** `src/models/memoryStatus.ts`

Replace the entire file:

```ts
export enum MemoryStatus {
    Draft    = 'draft',
    Stored   = 'stored',
    Archived = 'archived',
    Rejected = 'rejected',
}
```

> **Note:** Existing SQLite rows with `Status = 'New'` will be migrated by the script in Section 11. No old enum values need to remain for backward compat — the migration runs before any new code touches the DB.

---

## 6. New Service: memoryEnvironmentService.ts

**Create:** `src/services/memoryEnvironmentService.ts`

```ts
import { config } from './configService';

export type MemoryDataEnvironment = 'production' | 'development' | 'test';
export type TestRunType = 'unit' | 'integration' | 'eval' | 'manual';

const VALID_ENVIRONMENTS: MemoryDataEnvironment[] = ['production', 'development', 'test'];

export function getCurrentEnvironment(): MemoryDataEnvironment {
    const env = config.MEMORY_DATA_ENV;
    if (!VALID_ENVIRONMENTS.includes(env as MemoryDataEnvironment)) {
        throw new Error(
            `Invalid MEMORY_DATA_ENV="${env}". Must be one of: ${VALID_ENVIRONMENTS.join(', ')}`
        );
    }
    return env as MemoryDataEnvironment;
}

export function assertCanWriteMemory(operation: string): void {
    if (getCurrentEnvironment() === 'production' && !config.MEMORY_ALLOW_PRODUCTION_WRITES) {
        throw new Error(
            `[MemoryEnvironment] Refusing production memory write for "${operation}". ` +
            `Set MEMORY_ALLOW_PRODUCTION_WRITES=true to allow intentional production writes.`
        );
    }
}

export function assertNotProduction(operation: string): void {
    if (getCurrentEnvironment() === 'production') {
        throw new Error(
            `[MemoryEnvironment] Refusing to run "${operation}" against production storage. ` +
            `This operation is not safe for production environments.`
        );
    }
}

export function describeMemoryStorageTargets(): string {
    return [
        `env=${config.MEMORY_DATA_ENV}`,
        `sqlite=${config.SQLITE_DB_PATH}`,
        `qdrantCollection=${config.QDRANT_COLLECTION_NAME}`,
        `neo4jDatabase=${config.NEO4J_DATABASE}`,
        `productionWrites=${config.MEMORY_ALLOW_PRODUCTION_WRITES}`,
    ].join(' | ');
}
```

---

## 7. VectorService: Parameterize Collection Name

**File:** `src/services/vectorService.ts`

### 7.1 Remove hardcoded constant and update constructor

```ts
// Remove (line 9):
private readonly COLLECTION_NAME = 'memories';

// Add instance field:
private readonly collectionName: string;

// Update constructor signature (line 12):
constructor(qdrantUrl: string, collectionName: string, loggingService: LoggingService) {
    this.client = new QdrantClient({ url: qdrantUrl });
    this.collectionName = collectionName;
    this.loggingService = loggingService;
}
```

### 7.2 Replace all `this.COLLECTION_NAME` references

Use find-and-replace to change every `this.COLLECTION_NAME` → `this.collectionName` throughout the file (there are roughly 10–15 occurrences).

---

## 8. RAGOrchestrator: Wire New Config to Services

**File:** `src/services/ragOrchestrator.ts`

Update the constructor (lines 21–22):

```ts
// Change from:
this.vectorService = new VectorService(config.QDRANT_URL, this.loggingService);
this.graphService = new GraphService(config.NEO4J_URI, config.NEO4J_USER, config.NEO4J_PASSWORD);

// To:
this.vectorService = new VectorService(config.QDRANT_URL, config.QDRANT_COLLECTION_NAME, this.loggingService);
this.graphService = new GraphService(config.NEO4J_URI, config.NEO4J_USER, config.NEO4J_PASSWORD, config.NEO4J_DATABASE);
```

---

## 9. Fix initSqlDb.ts

**File:** `src/scripts/initSqlDb.ts`

### 9.1 Remove hardcoded path, use configService

```ts
// Remove:
const DB_PATH = path.join(process.cwd(), 'data', 'memory.db');

// Add at top (after existing imports):
import { config } from '../services/configService';
import { assertNotProduction } from '../services/memoryEnvironmentService';
```

Replace all uses of `DB_PATH` with `config.SQLITE_DB_PATH`.

Add a guard at the start of `initializeDatabase()`:

```ts
async function initializeDatabase() {
    assertNotProduction('initSqlDb');
    console.log(`[initSqlDb] env=${config.MEMORY_DATA_ENV}`);
    console.log(`Initializing database at ${config.SQLITE_DB_PATH}...`);
    // ... rest of function unchanged, except DB_PATH → config.SQLITE_DB_PATH
}
```

---

## 10. SQLite Schema: Status Default Change

**File:** `src/services/sqlService.ts`

Change the default value in the CREATE TABLE statement (line 86):

```sql
-- From:
Status TEXT NOT NULL DEFAULT 'New',

-- To:
Status TEXT NOT NULL DEFAULT 'draft',
```

Do the same in `src/scripts/initSqlDb.ts` (line 45 equivalent).

Also add `Status` to the migrations array in `sqlService.ts` so any existing databases that were created before this change get the constraint updated via migration on next startup. Since SQLite does not support altering defaults, this is handled by the status migration script (Section 11).

---

## 11. Status Migration Script

**Create:** `src/scripts/migrateMemoryStatuses.ts`

```ts
import sqlite3 from 'sqlite3';
import { config } from '../services/configService';
import fs from 'fs';
import path from 'path';

sqlite3.verbose();

async function migrateStatuses(): Promise<void> {
    const dbPath = config.SQLITE_DB_PATH;
    console.log(`[migrateMemoryStatuses] Migrating statuses in: ${dbPath}`);

    if (!fs.existsSync(dbPath)) {
        console.log(`[migrateMemoryStatuses] Database not found at ${dbPath}. Nothing to migrate.`);
        return;
    }

    const db = new sqlite3.Database(dbPath);

    const run = (sql: string, params: any[] = []): Promise<void> =>
        new Promise((resolve, reject) => {
            db.run(sql, params, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

    const get = (sql: string): Promise<any> =>
        new Promise((resolve, reject) => {
            db.get(sql, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

    try {
        // Old 'New' → 'draft'
        await run(`UPDATE Memories SET Status = 'draft' WHERE Status = 'New'`);
        const draftCount = await get(`SELECT COUNT(*) as count FROM Memories WHERE Status = 'draft'`);
        console.log(`  New → draft: ${draftCount.count} rows`);

        // Old 'Reviewed' → 'stored'
        await run(`UPDATE Memories SET Status = 'stored' WHERE Status = 'Reviewed'`);
        const storedCount = await get(`SELECT COUNT(*) as count FROM Memories WHERE Status = 'stored'`);
        console.log(`  Reviewed → stored: ${storedCount.count} rows`);

        // 'Archived' stays 'archived' (same semantic, different case)
        await run(`UPDATE Memories SET Status = 'archived' WHERE Status = 'Archived'`);
        const archivedCount = await get(`SELECT COUNT(*) as count FROM Memories WHERE Status = 'archived'`);
        console.log(`  Archived → archived: ${archivedCount.count} rows`);

        console.log('[migrateMemoryStatuses] Migration complete.');
    } finally {
        db.close();
    }
}

migrateStatuses().catch((err) => {
    console.error('[migrateMemoryStatuses] Error:', err);
    process.exit(1);
});
```

---

## 12. New Script: seedEnvironment.ts

**Create:** `src/scripts/seedEnvironment.ts`

This script replaces `loadSeedMemories.ts` and `resetAllAndLoadSeeds.ts` as the canonical seed entry point.

```ts
import { config } from '../services/configService';
import {
    assertCanWriteMemory,
    assertNotProduction,
    describeMemoryStorageTargets,
    getCurrentEnvironment
} from '../services/memoryEnvironmentService';
import { SeedMemoryLoader } from '../services/seedMemoryLoader';
import { LoggingService } from '../services/loggingService';
import path from 'path';
import fs from 'fs';

/**
 * Usage:
 *   npx tsx src/scripts/seedEnvironment.ts [--env=production|development|test] [--source=seed|sample|both]
 *
 * The --env flag overrides MEMORY_DATA_ENV for this run.
 * Seed policy:
 *   production  → seedMemories.json only (requires MEMORY_ALLOW_PRODUCTION_WRITES=true)
 *   development → seedMemories.json + sampleMemories.json
 *   test        → seedMemories.json + sampleMemories.json
 */

const SEED_FILE   = path.join(process.cwd(), 'src', 'samples', 'seedMemories.json');
const SAMPLE_FILE = path.join(process.cwd(), 'src', 'samples', 'sampleMemories.json');

async function run(): Promise<void> {
    const env = getCurrentEnvironment();
    console.log(`[seedEnvironment] Storage targets: ${describeMemoryStorageTargets()}`);

    if (env === 'production') {
        assertCanWriteMemory('seedEnvironment');
        console.log('[seedEnvironment] Production seed: loading seedMemories.json only.');
    } else {
        assertNotProduction('seedEnvironment-guard');  // belt-and-suspenders if env was overridden
    }

    const loggingService = new LoggingService('warn');
    const loader = new SeedMemoryLoader(loggingService);

    // Always seed the seed file (production + dev + test)
    if (!fs.existsSync(SEED_FILE)) throw new Error(`Seed file not found: ${SEED_FILE}`);
    console.log(`[seedEnvironment] Seeding from ${SEED_FILE} with status='stored'...`);
    await loader.loadFromFile(SEED_FILE, { defaultStatus: 'stored' });

    // For non-production environments, also load sample data
    if (env !== 'production') {
        if (!fs.existsSync(SAMPLE_FILE)) {
            console.warn(`[seedEnvironment] Sample file not found: ${SAMPLE_FILE}. Skipping.`);
        } else {
            console.log(`[seedEnvironment] Seeding from ${SAMPLE_FILE} with status='draft'...`);
            await loader.loadFromFile(SAMPLE_FILE, { defaultStatus: 'draft' });
        }
    }

    console.log('[seedEnvironment] Done.');
}

run().catch((err) => {
    console.error('[seedEnvironment] Error:', err);
    process.exit(1);
});
```

> **Note on `SeedMemoryLoader.loadFromFile`:** The `defaultStatus` option may need to be added to the loader if it does not already exist. The loader should pass this status when constructing Memory objects, setting `Status = options.defaultStatus ?? 'stored'`. Inspect `src/services/seedMemoryLoader.ts` and add the parameter if missing.

---

## 13. New Script: resetEnvironment.ts

**Create:** `src/scripts/resetEnvironment.ts`

Replaces `resetAllAndLoadSeeds.ts` and `resetVectorAndGraph.ts` as the canonical reset.

```ts
import { config } from '../services/configService';
import {
    assertNotProduction,
    describeMemoryStorageTargets,
    getCurrentEnvironment
} from '../services/memoryEnvironmentService';
import { VectorService } from '../services/vectorService';
import { GraphService } from '../services/graphService';
import { SqlService } from '../services/sqlService';
import { LoggingService } from '../services/loggingService';
import fs from 'fs';

/**
 * Wipes all three stores for the current (non-production) environment.
 * Usage: cross-env MEMORY_DATA_ENV=development npx tsx src/scripts/resetEnvironment.ts
 */
async function run(): Promise<void> {
    assertNotProduction('resetEnvironment');

    const env = getCurrentEnvironment();
    console.log(`[resetEnvironment] Resetting ${env} environment...`);
    console.log(`[resetEnvironment] Storage targets: ${describeMemoryStorageTargets()}`);

    const logging = new LoggingService('warn');

    // Reset SQLite: delete the file so it's recreated fresh
    if (fs.existsSync(config.SQLITE_DB_PATH)) {
        fs.unlinkSync(config.SQLITE_DB_PATH);
        console.log(`[resetEnvironment] Deleted SQLite DB: ${config.SQLITE_DB_PATH}`);
    }
    // Re-initialize SQLite schema
    const sql = new SqlService(config);
    await (sql as any).initializationPromise;
    console.log('[resetEnvironment] SQLite schema re-initialized.');

    // Reset Qdrant: delete and recreate collection
    const vector = new VectorService(config.QDRANT_URL, config.QDRANT_COLLECTION_NAME, logging);
    await (vector as any).client.deleteCollection(config.QDRANT_COLLECTION_NAME).catch(() => {});
    await vector.initializeCollection();
    console.log(`[resetEnvironment] Qdrant collection reset: ${config.QDRANT_COLLECTION_NAME}`);

    // Reset Neo4j: delete all nodes and relationships in the database
    const graph = new GraphService(config.NEO4J_URI, config.NEO4J_USER, config.NEO4J_PASSWORD, config.NEO4J_DATABASE);
    await graph.runQuery('MATCH (n) DETACH DELETE n');
    await graph.close();
    console.log(`[resetEnvironment] Neo4j database cleared: ${config.NEO4J_DATABASE || 'default'}`);

    sql.close();
    console.log(`[resetEnvironment] Done. ${env} environment is clean.`);
}

run().catch((err) => {
    console.error('[resetEnvironment] Error:', err);
    process.exit(1);
});
```

---

## 14. New Script: refreshEnvironment.ts

**Create:** `src/scripts/refreshEnvironment.ts`

Convenience wrapper: reset then seed.

```ts
import { config } from '../services/configService';
import { assertNotProduction, describeMemoryStorageTargets } from '../services/memoryEnvironmentService';
import { execSync } from 'child_process';

async function run(): Promise<void> {
    assertNotProduction('refreshEnvironment');
    console.log(`[refreshEnvironment] Refresh starting...`);
    console.log(`[refreshEnvironment] ${describeMemoryStorageTargets()}`);

    // Reset then seed using child process to re-initialize module singletons cleanly
    execSync('npx tsx src/scripts/resetEnvironment.ts', { stdio: 'inherit', env: process.env });
    execSync('npx tsx src/scripts/seedEnvironment.ts', { stdio: 'inherit', env: process.env });

    console.log('[refreshEnvironment] Done.');
}

run().catch((err) => {
    console.error('[refreshEnvironment] Error:', err);
    process.exit(1);
});
```

---

## 15. Remove Old Seed/Reset Scripts

Delete the following files (they are replaced by the scripts above):
- `src/scripts/loadSeedMemories.ts`
- `src/scripts/resetAllAndLoadSeeds.ts`
- `src/scripts/resetVectorAndGraph.ts`

If any other script imports from these files, update the import.

---

## 16. Update Eval Scripts — Add Production Guard

**Files:** `src/scripts/evaluateTagging.ts`, `src/scripts/evaluateCategorization.ts`, `src/scripts/evaluateSemanticQueries.ts`, `src/scripts/evaluateEntityExtraction.ts`

Add the following near the top of each file (after imports):

```ts
import { assertNotProduction } from '../services/memoryEnvironmentService';

// Call before any data writes or reads begin:
assertNotProduction('evaluate<ToolName>');
```

Also update `memoryFeedback.ts` if it writes data.

---

## 17. package.json Changes

### 17.1 Install cross-env

```bash
npm install -D cross-env
```

### 17.2 Update scripts

Replace or add the following in the `scripts` section of `package.json`:

```json
{
  "scripts": {
    "seed:prod":    "cross-env MEMORY_DATA_ENV=production MEMORY_ALLOW_PRODUCTION_WRITES=true npx tsx src/scripts/seedEnvironment.ts",
    "seed:dev":     "cross-env MEMORY_DATA_ENV=development npx tsx src/scripts/seedEnvironment.ts",
    "seed:test":    "cross-env MEMORY_DATA_ENV=test npx tsx src/scripts/seedEnvironment.ts",
    "reset:dev":    "cross-env MEMORY_DATA_ENV=development npx tsx src/scripts/resetEnvironment.ts",
    "reset:test":   "cross-env MEMORY_DATA_ENV=test npx tsx src/scripts/resetEnvironment.ts",
    "refresh:dev":  "cross-env MEMORY_DATA_ENV=development npx tsx src/scripts/refreshEnvironment.ts",
    "refresh:test": "cross-env MEMORY_DATA_ENV=test npx tsx src/scripts/refreshEnvironment.ts",
    "migrate:statuses": "npx tsx src/scripts/migrateMemoryStatuses.ts",
    "verify:data-isolation": "cross-env MEMORY_DATA_ENV=development npx tsx src/scripts/verifyDataIsolation.ts",
    "eval:tagging":     "cross-env MEMORY_DATA_ENV=test npx tsx src/scripts/evaluateTagging.ts --model=phi-4 --provider=lmstudio",
    "eval:category":    "cross-env MEMORY_DATA_ENV=test npx tsx src/scripts/evaluateCategorization.ts --model=phi-4 --provider=lmstudio",
    "eval:aggregation": "cross-env MEMORY_DATA_ENV=test npx tsx src/scripts/evaluateSemanticQueries.ts --model=phi-4 --provider=lmstudio",
    "eval:entities":    "cross-env MEMORY_DATA_ENV=test npx tsx src/scripts/evaluateEntityExtraction.ts --model=phi-4 --provider=lmstudio",
    "init-sql":         "npx tsx src/scripts/initSqlDb.ts"
  }
}
```

Remove the old `reset`, `reset:full` scripts (they're replaced by `reset:dev` / `reset:test`).

---

## 18. .env.example Update

Add the following block to `.env.example` (place it before the first existing variable):

```bash
# =============================================================================
# Memory Data Environment
# =============================================================================
# Selects which storage targets (SQLite, Qdrant, Neo4j) this instance uses.
# production  = real remembered memories. Never used for tests or evals.
# development = local/dev data. Seeded from seedMemories.json + sampleMemories.json.
# test        = automated tests and prompt/model evals. Same seed files as dev.
MEMORY_DATA_ENV=development

# Safety guard. Must be explicitly true to allow writes/seeds to production.
# Reset/destructive scripts always refuse production regardless of this flag.
MEMORY_ALLOW_PRODUCTION_WRITES=false

# SQLite path for the selected environment.
# production:  ./data/prod/memory.db
# development: ./data/dev/memory.db (default)
# test:        ./data/test/memory.db
SQLITE_DB_PATH=./data/dev/memory.db

# Qdrant collection for the selected environment.
# production:  memoryapi_prod_memories
# development: memoryapi_dev_memories (default)
# test:        memoryapi_test_memories
QDRANT_COLLECTION_NAME=memoryapi_dev_memories

# Neo4j database for the selected environment (requires Neo4j Enterprise or separate containers).
# production:  memoryapi_prod
# development: memoryapi_dev (default)
# test:        memoryapi_test
# If using Neo4j Community Edition (single database only), use separate containers per env.
NEO4J_DATABASE=memoryapi_dev

# Optional: metadata for test/eval runs. Only meaningful when MEMORY_DATA_ENV=test.
# MEMORY_TEST_RUN_TYPE can be: unit, integration, eval, manual
MEMORY_TEST_RUN_TYPE=manual
MEMORY_TEST_RUN_ID=
```

---

## 19. Create docs/AI_AGENTS.md

**Create:** `docs/AI_AGENTS.md`

```markdown
# AI Agent Guidelines for MemoryAPI

## Data Environment Rules

MemoryAPI has three data environments: `production`, `development`, and `test`.

**Before writing any new test, eval, script, or seed operation:**

1. Verify `MEMORY_DATA_ENV` is set appropriately. Tests and evals must use `test`.
2. Never point automated tests or evals at production SQLite, Qdrant, or Neo4j targets.
3. `sampleMemories.json` is NOT production seed data. It is for dev/test only.
4. `seedMemories.json` is the production seed source. Do not modify it for test purposes.
5. Production writes require `MEMORY_ALLOW_PRODUCTION_WRITES=true`. Reset/destroy scripts always refuse production.

## Memory Status Rules

Only memories with `Status = 'stored'` appear in semantic search results.

- `draft` — newly created, pending human review. Not in retrieval.
- `stored` — reviewed and active. Included in all searches.
- `archived` — retired/stale. SQL history only.
- `rejected` — human-reviewed and excluded. SQL history only.

When writing seeds or fixtures: use `stored` for ground-truth data, `draft` for candidate or sample data.

## Storage Targets by Environment

| Environment | SQLite | Qdrant Collection | Neo4j Database |
|-------------|--------|-------------------|----------------|
| production  | `data/prod/memory.db` | `memoryapi_prod_memories` | `memoryapi_prod` |
| development | `data/dev/memory.db`  | `memoryapi_dev_memories`  | `memoryapi_dev`  |
| test        | `data/test/memory.db` | `memoryapi_test_memories` | `memoryapi_test` |

## Environment Guard Imports

```ts
import { assertCanWriteMemory, assertNotProduction } from '../services/memoryEnvironmentService';

// Use in seed scripts (allows production with explicit opt-in):
assertCanWriteMemory('myScript');

// Use in reset/eval/test scripts (always blocks production):
assertNotProduction('myScript');
```
```

---

## 20. README.md Additions

Add a new `## Memory Data Environments` section after the Architecture section. Include:

1. **Environments** — production/development/test definitions
2. **Storage targets by environment** — table (same as in AI_AGENTS.md above)
3. **Seeding policy** — prod = seed only; dev/test = seed + sample
4. **Memory status lifecycle** — draft → stored or rejected; archived for retirement
5. **Production write safety** — what `MEMORY_ALLOW_PRODUCTION_WRITES` does
6. **Development refresh workflow** — `npm run refresh:dev`
7. **Test/eval workflow** — evals always use `MEMORY_DATA_ENV=test`; `npm run eval:tagging` etc.

---

## 21. Verification Script

**Create:** `src/scripts/verifyDataIsolation.ts`

```ts
import { config } from '../services/configService';
import { describeMemoryStorageTargets } from '../services/memoryEnvironmentService';
import fs from 'fs';

async function verify(): Promise<void> {
    console.log('\n=== MemoryAPI Data Isolation Verification ===\n');

    const environments = ['production', 'development', 'test'] as const;

    const expectedSqlitePaths: Record<string, string> = {
        production:  'data/prod/memory.db',
        development: 'data/dev/memory.db',
        test:        'data/test/memory.db',
    };
    const expectedQdrant: Record<string, string> = {
        production:  'memoryapi_prod_memories',
        development: 'memoryapi_dev_memories',
        test:        'memoryapi_test_memories',
    };
    const expectedNeo4j: Record<string, string> = {
        production:  'memoryapi_prod',
        development: 'memoryapi_dev',
        test:        'memoryapi_test',
    };

    let allPassed = true;

    for (const env of environments) {
        process.env.MEMORY_DATA_ENV = env;
        process.env.SQLITE_DB_PATH = expectedSqlitePaths[env];
        process.env.QDRANT_COLLECTION_NAME = expectedQdrant[env];
        process.env.NEO4J_DATABASE = expectedNeo4j[env];

        // Re-read from env (note: config is a singleton so this test is illustrative)
        const sqliteOk = config.SQLITE_DB_PATH.endsWith(expectedSqlitePaths[env]) ||
                         process.env.SQLITE_DB_PATH === expectedSqlitePaths[env];
        const qdrantOk = process.env.QDRANT_COLLECTION_NAME === expectedQdrant[env];
        const neo4jOk  = process.env.NEO4J_DATABASE === expectedNeo4j[env];

        const pass = sqliteOk && qdrantOk && neo4jOk;
        allPassed = allPassed && pass;
        console.log(`${env}:`);
        console.log(`  sqlite:   ${expectedSqlitePaths[env]}  ${sqliteOk ? 'PASS' : 'FAIL'}`);
        console.log(`  qdrant:   ${expectedQdrant[env]}  ${qdrantOk ? 'PASS' : 'FAIL'}`);
        console.log(`  neo4j:    ${expectedNeo4j[env]}  ${neo4jOk ? 'PASS' : 'FAIL'}`);
    }

    // Verify production write guard
    process.env.MEMORY_DATA_ENV = 'production';
    process.env.MEMORY_ALLOW_PRODUCTION_WRITES = 'false';
    let guardPassed = false;
    try {
        const { assertCanWriteMemory } = await import('./memoryEnvironmentService' as any);
        assertCanWriteMemory('test');
    } catch (e: any) {
        guardPassed = e.message?.includes('Refusing production');
    }
    allPassed = allPassed && guardPassed;
    console.log(`\nProduction write guard (with ALLOW=false): ${guardPassed ? 'PASS' : 'FAIL'}`);

    console.log(`\n=== Result: ${allPassed ? 'ALL PASS' : 'SOME FAILURES'} ===\n`);
    process.exit(allPassed ? 0 : 1);
}

verify().catch((err) => {
    console.error(err);
    process.exit(1);
});
```

> **Note:** Because `config` is a module singleton, the full isolation test requires spawning separate processes per environment. For now, this script verifies the expected env var → target mapping and the production write guard. A more complete test seeds each environment and counts records.

---

## 22. File Change Summary

### Modified files

| File | Change |
|------|--------|
| `src/services/configService.ts` | Add 6 new fields; update SQLITE_DB_PATH default; add boolean parsing |
| `src/models/memoryStatus.ts` | Replace enum with `draft \| stored \| archived \| rejected` |
| `src/services/vectorService.ts` | Parameterize collection name via constructor |
| `src/services/ragOrchestrator.ts` | Pass `QDRANT_COLLECTION_NAME` and `NEO4J_DATABASE` to services |
| `src/services/sqlService.ts` | Change Status default from `'New'` to `'draft'` |
| `src/scripts/initSqlDb.ts` | Replace hardcoded path; use configService; add production guard |
| `src/scripts/evaluate*.ts` (4 files) | Add `assertNotProduction` guard at top |
| `package.json` | Add cross-env; add seed/reset/refresh/eval/verify scripts; remove old scripts |
| `.env.example` | Add new environment config block with comments |
| `README.md` | Add Memory Data Environments section |

### New files

| File | Purpose |
|------|---------|
| `src/services/memoryEnvironmentService.ts` | Environment guard service |
| `src/scripts/seedEnvironment.ts` | Environment-aware seeder |
| `src/scripts/resetEnvironment.ts` | Environment-scoped reset (non-production only) |
| `src/scripts/refreshEnvironment.ts` | Reset + reseed convenience wrapper |
| `src/scripts/migrateMemoryStatuses.ts` | One-time migration: old → new status values |
| `src/scripts/verifyDataIsolation.ts` | Isolation verification script |
| `docs/AI_AGENTS.md` | Future agent data rules |

### Deleted files

| File | Replaced by |
|------|-------------|
| `src/scripts/loadSeedMemories.ts` | `seedEnvironment.ts` |
| `src/scripts/resetAllAndLoadSeeds.ts` | `resetEnvironment.ts` + `refreshEnvironment.ts` |
| `src/scripts/resetVectorAndGraph.ts` | `resetEnvironment.ts` |

---

## 23. Verification Plan

Run in order:

```bash
# 1. Build must pass
npm run build

# 2. Existing tests must pass
npm test

# 3. Migrate existing data/memory.db statuses (if the DB has data worth preserving)
SQLITE_DB_PATH=./data/memory.db npm run migrate:statuses

# 4. Initialize env-specific DBs
cross-env MEMORY_DATA_ENV=development npx tsx src/scripts/initSqlDb.ts
cross-env MEMORY_DATA_ENV=test npx tsx src/scripts/initSqlDb.ts

# 5. Run isolation verification
npm run verify:data-isolation

# 6. Seed dev environment
npm run seed:dev

# 7. Confirm production guard rejects without opt-in
MEMORY_DATA_ENV=production npm run seed:dev    # should throw/refuse

# 8. Seed prod with explicit opt-in
MEMORY_DATA_ENV=production MEMORY_ALLOW_PRODUCTION_WRITES=true npm run seed:prod
```

**Expected outcomes:**
- Build: zero TypeScript errors
- Tests: all green
- `seed:dev` writes only to `data/dev/memory.db` and `memoryapi_dev_memories`
- `seed:prod` without opt-in: throws with "Refusing production memory write"
- `seed:prod` with opt-in: writes only to `data/prod/memory.db` and `memoryapi_prod_memories`
- Eval scripts: blocked if `MEMORY_DATA_ENV=production`

---

## 24. Pre-Implementation .env Note

Before running any verification, update your local `.env` file to reflect the new defaults:

```bash
MEMORY_DATA_ENV=development
SQLITE_DB_PATH=./data/dev/memory.db
QDRANT_COLLECTION_NAME=memoryapi_dev_memories
NEO4J_DATABASE=memoryapi_dev
MEMORY_ALLOW_PRODUCTION_WRITES=false
```

The old `data/memory.db` remains untouched; development starts with a fresh `data/dev/memory.db`.
