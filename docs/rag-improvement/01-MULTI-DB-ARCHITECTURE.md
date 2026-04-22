# Multi-Database Architecture Principles

> **Related docs**: [00-OVERVIEW.md](00-OVERVIEW.md) · [05-DATABASE-SYNC.md](05-DATABASE-SYNC.md)

## The Core Idea: Each Database Answers a Different Question

A single database can only optimize for one access pattern. A vector database excels at "what is conceptually similar?" but cannot answer "what other memories share the same project context?" efficiently. A graph database excels at "what is connected to what?" but struggles with open-ended semantic similarity. A relational database excels at "what is the precise state of this record?" but cannot do either of the above well.

By using three databases together:

| Database | Question It Answers | Strength |
|----------|-------------------|----------|
| **Qdrant** (Vector) | "What memories are conceptually similar to this query?" | Fuzzy semantic matching — finds related ideas even when no keywords overlap |
| **Neo4j** (Graph) | "What memories are structurally related to this one?" | Explicit relationship traversal — finds memories connected through tags, categories, entities |
| **SQLite** (SQL) | "What is the precise metadata state of this memory?" | Source of truth for status, audit trail, cross-DB tracking, relational queries |

The power comes from **combining answers from different perspectives**. A query like "What tools do I use for my web projects?" benefits from:

1. **Vector**: Finds memories about web development tooling, even if they don't use the exact phrase "web projects"
2. **Graph**: Walks from a known "web-project" tag to all other memories sharing it, and from there to their tags, discovering related tooling memories the vector search might miss
3. **SQL**: Confirms which memories are current (not archived/deleted), provides timestamps for freshness ranking

---

## When Each Database Excels

### Vector Database (Qdrant) — Best for Conceptual Discovery

**Excels at:**
- Open-ended queries: "What do I know about deployment?" finds memories about CI/CD, Docker, hosting, even if they never use the word "deployment"
- Fuzzy matching: The query "favorite tech stack" will score highly against a memory about "I prefer working with TypeScript and React" — there are no shared keywords, but the embeddings are close
- Cold-start queries: When you don't know what's in the knowledge base, vector search explores the semantic space broadly

**Struggles with:**
- Exact lookups: "What memories are tagged with 'Reminder'?" requires a payload filter, not a vector search
- Structural queries: "What other memories share 3+ tags with this one?" is not expressible as a vector query
- Temporal reasoning: Vector similarity doesn't naturally incorporate "most recent" or "memories from last month"

**Key insight**: Vector scores are **relative**, not absolute. A score of 0.85 doesn't mean the memory is relevant — it means it's more similar than others in the collection. As the collection grows, score distributions shift.

### Graph Database (Neo4j) — Best for Relationship Discovery

**Excels at:**
- Structural queries: "Find all memories tagged with 'TypeScript' that are also in the 'Code Snippet' category" is a single graph traversal
- Transitive discovery: Memory A shares tags with Memory B, which shares tags with Memory C — this 2-hop path can surface C even when it has no direct connection to A
- Entity-centric queries: Once you have entity nodes (projects, tools, people), you can ask "What do I know about Project X?" by walking all relationships from that node
- Aggregation: "Which tags appear most often alongside 'API'?" is a native graph query

**Struggles with:**
- Open-ended semantic search: Without vector search, the graph can only find memories that share explicit structure (tags, categories). A memory about "deployment best practices" won't be found via graph traversal when searching for "DevOps" unless there's a connecting tag
- Discovery of new patterns: Graph traversal follows existing paths — it cannot discover that two memories are conceptually related if they have no shared structure

**Key insight**: Graph search quality is **directly proportional to graph richness**. With only Tag and Category nodes (current state), traversal is limited. Adding entity nodes (Projects, Tools, Topics) dramatically increases the paths available for discovery.

### Relational Database (SQLite) — Best for State Management

**Excels at:**
- Point lookups: "Get memory by ID" is O(1)
- Status filtering: "Show all memories with Status='New'" for the review queue
- Cross-database tracking: `MemoryDatabaseRelations` maps between SQLite IDs, Qdrant IDs, and Neo4j IDs
- Audit trails: `SearchHistory` logs every query with both vector and graph results, prompts, summaries, and timing
- Temporal queries: "Memories created in the last week" with SQL WHERE clauses
- Aggregation counts: Category distribution, tag frequency, memory counts

**Struggles with:**
- Semantic search: SQL LIKE '%deployment%' is not semantic search
- Relationship traversal: Requires explicit JOINs that must be known ahead of time
- Scale: SQLite is single-writer and becomes a bottleneck past ~100K concurrent reads (not a near-term concern)

**Key insight**: SQL is the **anchor** — it's the source of truth that the other databases are derived from. If there's ever a discrepancy, SQL data wins.

---

## The "Single Write, Triple Store" Pattern

When a memory is added, the system writes to all three databases in a single orchestrated operation:

```
addMemory(memory, embedding, id)
    ├── vectorService.upsertMemory(memory, embedding, id)     → Qdrant
    ├── graphService.upsertMemory(memoryWithId, embedding)     → Neo4j
    └── sqlService.addMemory(memory)                           → SQLite
        sqlService.addMemoryDatabaseRelation(id, graphId, vectorId)
```

This is implemented in `ragOrchestrator.ts` using `Promise.all` for parallel writes. The same pattern applies to updates and deletes.

**Why not a single database?** Because the write patterns are simple (insert/update/delete by ID), but the **read patterns are fundamentally different** across the three stores. Optimizing for all three read patterns in a single database means optimizing for none.

---

## How the Three Databases Combine During Search

The current pipeline (in `memoryRAGSystem.ts`) runs vector and graph searches in parallel, then merges:

```
Query → Embedding → ┬→ Qdrant (vector similarity)  → vectorResults
                     └→ Neo4j (graph traversal)      → graphResults
                                                          │
                    mergeVectorAndGraphResults() ◄────────┘
                              │
                    ┌─────────▼──────────┐
                    │ Dedup by memory ID │
                    │ Combine scores     │
                    │ Filter threshold   │
                    │ Sort & limit       │
                    └─────────┬──────────┘
                              │
                    LLM Aggregation (strategy-based)
                              │
                    Log to SearchHistory (SQLite)
```

SQL's role during search is **indirect** — it doesn't contribute search results, but it:
1. Logs every search for later analysis (`SearchHistory`)
2. Could pre-filter candidates (not yet implemented — see [07-SCALING-STRATEGIES.md](07-SCALING-STRATEGIES.md))
3. Tracks cross-DB IDs so merged results can be correlated

---

## Complementary Strengths — A Concrete Example

**Query**: "What TypeScript libraries do I use for API development?"

### Vector Results (Qdrant)

| Memory | Score | Why Found |
|--------|-------|-----------|
| "I prefer using Elysia for REST APIs with Bun" | 0.89 | Embedding is close to "TypeScript API development" |
| "My go-to HTTP client is ky for TypeScript" | 0.82 | Related to TypeScript libraries |
| "Notes from API design patterns book" | 0.76 | Related to API development, but not TypeScript-specific |
| "I prefer afternoon coding sessions" | 0.45 | Very weakly related — would be filtered at 0.7 threshold |

### Graph Results (Neo4j)

Starting from tag traversal with the query embedding's nearest memory:

| Memory | Score | Why Found |
|--------|-------|-----------|
| "I like using Zod for runtime type validation" | 6 | Shares tags: "TypeScript", "Programming", "Project" (3 tags × 2 = 6) |
| "I prefer using Elysia for REST APIs with Bun" | 4 | Shares tags: "TypeScript", "API" (2 tags × 2 = 4) |
| "Checklist: set up new TypeScript project" | 4 | Shares tags: "TypeScript", "Project" |
| "Docker setup for Bun runtime" | 2 | Shares category: "Code Snippet" + tag: "Project" |

### Merged Result

After deduplication and 50-50 scoring:

| Memory | Vector | Graph | Merged | Sources |
|--------|--------|-------|--------|---------|
| "Elysia for REST APIs" | 0.89 | 4/6=0.67 | 0.78 | Both |
| "ky HTTP client" | 0.82 | — | 0.82 | Vector only |
| "Zod for type validation" | — | 6/6=1.0 | 1.0 | Graph only |
| "API design patterns" | 0.76 | — | 0.76 | Vector only |
| "TypeScript project checklist" | — | 4/6=0.67 | 0.67 (filtered at 0.7) | Graph only |

**Key observations:**
- **Zod** was found only by graph (not semantically close to "API libraries" but structurally connected via shared tags) — this is a **graph-exclusive win**
- **Elysia** was boosted by appearing in both — deduplication prevented it from appearing twice
- **ky** was found only by vector (no direct tag overlap, but semantically relevant)
- **TypeScript checklist** was filtered out at the 0.7 threshold — a lower threshold (see [03-RERANKING-AND-MERGING.md](03-RERANKING-AND-MERGING.md)) might include it

---

## Anti-Patterns to Avoid

### 1. Treating One Database as the "Primary" Search

Don't default to vector-only search and treat graph as optional. Both provide complementary signals. If graph search fails (Neo4j down), gracefully fall back — but don't skip it by default.

### 2. Duplicating Data Unnecessarily

Each database should store only what it needs for its access pattern:
- Qdrant stores embeddings + payload for filtering
- Neo4j stores relationships and searchable properties
- SQLite stores the canonical record with status and cross-references

Don't store embeddings in SQLite or full content in Qdrant payload when it's not needed for search filtering.

### 3. Over-Relying on Graph Without Rich Structure

Graph search is only as good as the graph itself. With only Tag and Category nodes, you're limited to 1-hop traversal through these dimensions. Before investing in complex graph queries, invest in richer graph structure (see [02-GRAPH-DB-IMPROVEMENTS.md](02-GRAPH-DB-IMPROVEMENTS.md)).

### 4. Ignoring Score Distribution Differences

Vector scores (0–1 cosine similarity) and graph scores (1–20+ relationship count) are on completely different scales. Merging them requires normalization. The current approach normalizes graph scores by dividing by the maximum graph score — this works but has limitations (see [03-RERANKING-AND-MERGING.md](03-RERANKING-AND-MERGING.md)).

### 5. "Write and Forget" Without Reconciliation

With three databases, writes can partially fail. The current approach uses `Promise.all` with error catching, but doesn't retry or reconcile. At small scale this is acceptable, but plan for reconciliation as the system grows (see [05-DATABASE-SYNC.md](05-DATABASE-SYNC.md)).

---

## Why SQL Is Worth Keeping (Not Just Two Databases)

You might wonder: "If vector and graph do the searching, why bother with SQL?"

SQL serves roles that neither vector nor graph databases handle well:

1. **Source of Truth**: When vector and graph data diverge (and they will), SQL is the canonical record. Reconciliation jobs compare against SQL.

2. **Status Tracking**: The review queue workflow (New → Reviewed → Archived) is a relational concern. Trying to track status in Qdrant payload or Neo4j properties works but is clumsy and hard to query.

3. **Audit Trail**: `SearchHistory` captures every query with timing, model info, result counts, and the actual prompts/summaries. This data is essential for evaluating and improving the system. Neither Qdrant nor Neo4j are designed for append-only logging.

4. **Cross-DB Mapping**: `MemoryDatabaseRelations` enables reconciliation by mapping `MemoryId` ↔ `VectorId` ↔ `GraphId`. Without this, you can't verify that a memory exists in all three stores.

5. **Pre-filtering at Scale**: As the knowledge base grows, SQL can narrow candidates *before* expensive vector or graph searches. "Only search memories with Status='Reviewed' created in the last year" can cut the search space dramatically (see [07-SCALING-STRATEGIES.md](07-SCALING-STRATEGIES.md)).

6. **Tag Management**: `TagSuggestions` with deduplication and counts is a purely relational concern that doesn't fit vector or graph paradigms.

---

## Summary

| Principle | Explanation |
|-----------|-------------|
| **Each DB answers a different question** | Vector = semantic similarity, Graph = structural relationships, SQL = precise state |
| **Single write, triple store** | Write once, read from the best-fit DB for each query type |
| **SQL is the anchor** | Source of truth for metadata, status, and cross-DB reconciliation |
| **Graph quality ∝ graph richness** | Invest in richer graph structure (entities, multi-hop) for better graph search |
| **Merge results from both search modalities** | Combine vector + graph signals before LLM summarization |
| **Don't optimize for one access pattern** | The whole point is that each DB handles its access pattern efficiently |
