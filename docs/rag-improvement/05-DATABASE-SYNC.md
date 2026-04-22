# Database Synchronization

> **Related docs**: [01-MULTI-DB-ARCHITECTURE.md](01-MULTI-DB-ARCHITECTURE.md) · [00-OVERVIEW.md](00-OVERVIEW.md)

## Current Sync Approach

### Write Path (in `ragOrchestrator.ts`)

**Add Memory:**
```typescript
async addMemory(memory, embedding, id) {
    await Promise.all([
        this.vectorService.upsertMemory(memory, embedding, id),
        this.graphService.upsertMemory(memoryWithId, embedding)
    ]);
    // SQL write happens separately in memoryRAGSystem.ts
    // MemoryDatabaseRelations tracks cross-DB IDs
}
```

**Update Memory:**
```typescript
async updateMemory(id, updates, embedding?) {
    await Promise.all([
        this.vectorService.updateMemory(id, updates, embedding),
        this.graphService.upsertMemory(updatedMemory, embedding)
    ]);
}
```

**Delete Memory:**
```typescript
async deleteMemory(id) {
    await Promise.all([
        this.vectorService.deleteMemory(id),
        this.graphService.deleteMemory(id)
    ]);
    // SQL soft delete happens separately
}
```

### What Tracks Cross-DB State

The `MemoryDatabaseRelations` table in SQLite:

| Column | Purpose |
|--------|---------|
| MemoryId | SQLite primary key |
| GraphId | Neo4j Memory node ID |
| VectorId | Qdrant point ID |

This table maps a single memory across all three stores.

### Current Failure Handling

- Vector and graph writes run in parallel via `Promise.all`
- Graph search failures in `searchVectorAndGraphParallel()` are caught and return `[]` (graceful fallback)
- No retry logic
- No reconciliation
- No transactional guarantees across databases

---

## Failure Modes

### Scenario 1: Graph Write Fails, Vector Succeeds

**What happens**: Memory exists in Qdrant and SQLite but not in Neo4j. Graph search won't find it; graph traversal from other memories won't discover connections to it.

**Impact at current scale (< 100 memories)**: Low. The memory is still findable via vector search. Graph search contributes supplementary results.

**Impact at scale**: Moderate. If many memories are missing from the graph, graph-based discovery degrades progressively. The system doesn't know which memories are missing.

### Scenario 2: Vector Write Fails, Graph Succeeds

**What happens**: Memory exists in Neo4j and SQLite but not in Qdrant. Vector search won't find it. It might appear in graph traversal results, but its embedding-based similarity score is unavailable.

**Impact**: Higher than Scenario 1. Vector search is currently the primary retrieval method. Missing memories in Qdrant are missing from the core search path.

### Scenario 3: Both Write, SQL Tracking Fails

**What happens**: Memory exists in both Qdrant and Neo4j, but `MemoryDatabaseRelations` doesn't record the cross-DB IDs.

**Impact**: Reconciliation becomes impossible for this memory. Updates and deletes may not propagate correctly if they rely on cross-DB ID mapping.

### Scenario 4: Delete Partially Fails

**What happens**: Memory is soft-deleted in SQLite and removed from one store but not the other.

**Impact**: "Ghost" memory appears in search results from the store where deletion failed. User has deleted it, but it keeps surfacing.

---

## Recommendations by Stage

### Phase 1: Current State — Keep It Simple (Now)

The current best-effort approach is appropriate for < 100 memories. The risk of partial failures is low, and manual intervention (re-adding a memory) is easy.

**One simple addition**: Log partial failures explicitly instead of silently catching them.

```
In ragOrchestrator.ts addMemory():
  const results = await Promise.allSettled([
      this.vectorService.upsertMemory(...),
      this.graphService.upsertMemory(...)
  ]);
  
  results.forEach((result, i) => {
      if (result.status === 'rejected') {
          const store = ['vector', 'graph'][i];
          this.loggingService.error(`[addMemory] Failed to write to ${store}: ${result.reason}`);
          // Optionally: queue for retry (Phase 2)
      }
  });
```

`Promise.allSettled` (instead of `Promise.all`) ensures one failure doesn't prevent the other write from completing, and logs which store failed.

### Phase 2: Add a Reconciliation Script (When > 500 Memories)

A periodic reconciliation job that verifies consistency across databases:

```
Reconciliation algorithm:
  1. Load all memory IDs from SQLite (source of truth)
  2. For each memory:
     a. Check if it exists in Qdrant (by VectorId from MemoryDatabaseRelations)
     b. Check if it exists in Neo4j (by GraphId from MemoryDatabaseRelations)
  3. Report discrepancies:
     - In SQL but missing from Qdrant → needs re-upsert to vector
     - In SQL but missing from Neo4j → needs re-upsert to graph
     - Soft-deleted in SQL but still in Qdrant/Neo4j → needs cleanup
  4. Optionally: auto-repair by re-ingesting missing memories
```

**Implementation**:
- New file: `src/scripts/reconcileDatabase.ts`
- Uses existing services (vectorService, graphService, sqlService)
- Runs on-demand or on a schedule (e.g., daily cron)
- Generates a report via `memoryReportService.ts`

### Phase 3: Retry Queue (When Reliability Matters)

For critical deployments, add a retry mechanism for failed writes:

```
Failed write detected
    → Insert into RetryQueue table (SQL):
      | MemoryId | Store ('vector'|'graph') | Operation ('add'|'update'|'delete') | Attempts | LastAttempt |
    → Background worker processes queue:
      - Load memory data from SQL
      - Retry the write
      - On success: remove from queue
      - On failure: increment Attempts, backoff
      - After N failures: alert (log, notification)
```

**SQL schema addition:**
```sql
CREATE TABLE IF NOT EXISTS RetryQueue (
    Id INTEGER PRIMARY KEY AUTOINCREMENT,
    MemoryId TEXT NOT NULL,
    Store TEXT NOT NULL,          -- 'vector' or 'graph'
    Operation TEXT NOT NULL,      -- 'add', 'update', 'delete'
    Attempts INTEGER DEFAULT 0,
    LastAttempt TEXT,
    ErrorMessage TEXT,
    Created TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (MemoryId) REFERENCES Memories(MemoryId)
);
```

**This is a later optimization** — only implement when the risk of data loss justifies the complexity.

---

## SQL as Source of Truth — The Pattern

The key design principle is: **SQLite is always authoritative**.

```
                    ┌──────────┐
                    │  SQLite  │  ← Source of truth
                    │  (SQL)   │
                    └────┬─────┘
                         │
            Derive from SQL whenever inconsistent
                         │
              ┌──────────┴──────────┐
              ▼                     ▼
        ┌──────────┐          ┌──────────┐
        │  Qdrant  │          │  Neo4j   │
        │ (Vector) │          │ (Graph)  │
        └──────────┘          └──────────┘
```

**What this means in practice:**
- If Qdrant loses data (collection corruption, re-indexing), regenerate from SQL + re-embedding
- If Neo4j loses data (schema changes, migration), regenerate from SQL + re-embedding
- If SQLite loses data (file corruption) — this is the real disaster. Back up SQLite.
- Cross-DB IDs in `MemoryDatabaseRelations` enable targeted repairs without re-processing everything

**Backup recommendation**: SQLite's `data/memory.db` file is the single most important artifact. Regular file-level backups (or WAL-based incremental backups) protect against data loss.

---

## Sync Patterns for Different Operations

### Add Memory

```
1. Generate metadata (LLM: categorize, tag, summarize)
2. Generate embedding
3. SQL INSERT with Status='New' → get MemoryId
4. Parallel: Qdrant upsert + Neo4j upsert
5. SQL INSERT MemoryDatabaseRelations(memoryId, vectorId, graphId)
```

If step 4 partially fails: Memory is in SQL with no cross-DB record → reconciliation script will detect this.

### Update Memory

```
1. Load existing from SQL (source of truth)
2. Apply updates to SQL record
3. If content changed: regenerate embedding
4. Parallel: Qdrant update + Neo4j update (using cross-DB IDs from MemoryDatabaseRelations)
```

If step 4 partially fails: SQL has updated data but one store has stale data → reconciliation script detects version mismatch via `LastUpdated`.

### Delete Memory

```
1. SQL soft-delete (set Deleted=1)
2. Parallel: Qdrant delete + Neo4j delete (using cross-DB IDs)
3. Optionally: remove from MemoryDatabaseRelations
```

If step 2 partially fails: "Ghost" memory in one store → reconciliation script finds memories with `Deleted=1` in SQL but still present in vector/graph.

---

## Summary

| Aspect | Current | Recommended Now | Recommended Later |
|--------|---------|----------------|-------------------|
| **Write strategy** | `Promise.all` (one failure blocks) | `Promise.allSettled` (log failures) | + Retry queue |
| **Failure detection** | Silent catch | Explicit logging | + Monitoring alerts |
| **Consistency verification** | None | — | Reconciliation script |
| **Recovery** | Manual re-add | — | Auto-repair from SQL |
| **Backup** | None | SQLite file backup | + Point-in-time recovery |

**Key takeaway**: At < 100 memories, the current approach is fine with one small improvement (switch to `Promise.allSettled` with logging). Plan for reconciliation when the knowledge base grows past ~500 memories. The retry queue is a future optimization for high-reliability requirements.
