# Architecture Overview — Personal Memory RAG System

## Purpose of This Documentation Suite

This documentation suite serves two goals:

1. **Education** — Understand advanced RAG concepts including multi-database synergy, re-ranking, graph-based retrieval, and scaling strategies.
2. **Implementation Reference** — Provide a coding assistant with precise, actionable specs for each improvement, including which files and functions to modify.

Each document is self-contained but cross-references related docs where relevant.

---

## System Architecture

The Memory RAG system uses three databases that each serve a distinct purpose. A single memory is written to all three stores, and a search query draws from multiple stores before merging results for LLM summarization.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         MEMORY INGESTION                                │
│                                                                         │
│  User Input (Content)                                                   │
│       │                                                                 │
│       ▼                                                                 │
│  ┌─────────────────────────────────────────┐                            │
│  │  LLM Pipeline (memoryTextProcessor.ts)  │                            │
│  │  ┌───────────────┐ ┌────────────────┐   │                            │
│  │  │ Categorize    │ │ Generate Tags  │   │                            │
│  │  └───────────────┘ └────────────────┘   │                            │
│  │  ┌───────────────┐ ┌────────────────┐   │                            │
│  │  │ Summarize     │ │ Suggest Tags   │   │                            │
│  │  └───────────────┘ └────────────────┘   │                            │
│  └────────────────────┬────────────────────┘                            │
│                       │                                                 │
│                       ▼                                                 │
│  ┌─────────────────────────────────────────┐                            │
│  │  Generate Embedding (768-dim)           │                            │
│  │  Model: nomic-embed-text               │                            │
│  └────────────────────┬────────────────────┘                            │
│                       │                                                 │
│       ┌───────────────┼───────────────┐                                 │
│       ▼               ▼               ▼                                 │
│  ┌─────────┐   ┌───────────┐   ┌──────────┐                            │
│  │ Qdrant  │   │  Neo4j    │   │  SQLite  │                            │
│  │ (Vector)│   │  (Graph)  │   │  (SQL)   │                            │
│  └─────────┘   └───────────┘   └──────────┘                            │
│                                                                         │
│  Orchestrated by: ragOrchestrator.ts (parallel writes)                  │
└──────────────────────────────────────────────────────────────────────────┘
```

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         SEARCH & RETRIEVAL                              │
│                                                                         │
│  User Query                                                             │
│       │                                                                 │
│       ▼                                                                 │
│  ┌──────────────────────────────┐                                       │
│  │ Generate Query Embedding     │                                       │
│  └──────────────┬───────────────┘                                       │
│                 │                                                        │
│     ┌───────────┴───────────┐                                           │
│     ▼                       ▼                                           │
│  ┌──────────────┐   ┌──────────────────┐                                │
│  │ Vector Search│   │  Graph Search    │                                │
│  │ (Qdrant)     │   │  (Neo4j)         │                                │
│  │ Cosine sim.  │   │  1-hop traversal │                                │
│  │ Scores: 0-1  │   │  Scores: 1-20+  │                                │
│  └──────┬───────┘   └────────┬─────────┘                                │
│         │                    │                                          │
│         └────────┬───────────┘                                          │
│                  ▼                                                       │
│  ┌──────────────────────────────────────────┐                           │
│  │ Merge & Deduplicate                      │                           │
│  │ memoryPostSearchAggregator.ts            │                           │
│  │                                          │                           │
│  │ merged = (vector×0.5)+(normGraph×0.5)    │                           │
│  │ Filter: scoreThreshold ≥ 0.7            │                           │
│  │ Sort by mergedScore, return top limit    │                           │
│  └──────────────────┬───────────────────────┘                           │
│                     ▼                                                   │
│  ┌──────────────────────────────────────────┐                           │
│  │ LLM Aggregation (strategy-based)         │                           │
│  │ linear | cluster-category | cluster-tag  │                           │
│  │ | hybrid                                 │                           │
│  └──────────────────┬───────────────────────┘                           │
│                     ▼                                                   │
│  ┌──────────────────────────────────────────┐                           │
│  │ Log to SearchHistory (SQLite)            │                           │
│  │ Vector results, Graph results, Prompt,   │                           │
│  │ Summary, Duration, Model name            │                           │
│  └──────────────────┬───────────────────────┘                           │
│                     ▼                                                   │
│  Return: topMemories + aggregateNarrative/Bullets + clusterSummaries    │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## What Each Database Stores

### Qdrant (Vector Database)

| What | Details |
|------|---------|
| **Purpose** | Semantic similarity search — find memories conceptually related to a query |
| **Collection** | `memories` |
| **Vector** | 768-dimensional embedding (nomic-embed-text), cosine distance |
| **Payload** | Content, Description, Tags, Category, LastUpdated |
| **Indexes** | Keyword indexes on `Category` and `Tags` payload fields |
| **Score range** | 0–1 (cosine similarity) |
| **Source file** | `src/services/vectorService.ts` |

### Neo4j (Graph Database)

| What | Details |
|------|---------|
| **Purpose** | Relationship-based discovery — find memories connected through shared structure |
| **Node types** | `Memory`, `Tag`, `Category` |
| **Relationships** | `TAGGED_WITH` (Memory→Tag), `IN_CATEGORY` (Memory→Category) |
| **Memory properties** | id, content, description, lastUpdated, embedding[] |
| **Indexes** | Unique constraints on Memory.id, Tag.name, Category.name; vector index (768-dim cosine); fulltext index on content+description; lastUpdated index |
| **Score range** | 1–20+ (based on shared tags×2 + shared category×1) |
| **Source file** | `src/services/graphService.ts` |

### SQLite (Relational Database)

| What | Details |
|------|---------|
| **Purpose** | Source of truth for metadata, audit trail, cross-DB tracking |
| **Key tables** | `Memories`, `MemoryDatabaseRelations`, `TagSuggestions`, `SearchHistory` |
| **Memories** | Content, Description, Tags, Category, Status (New/Reviewed/Archived), Deleted flag, Created, LastUpdated |
| **MemoryDatabaseRelations** | Maps MemoryId ↔ GraphId (Neo4j) + VectorId (Qdrant) |
| **SearchHistory** | Query, VectorResults JSON, GraphResults JSON, MergePrompt, MergeSummary, model, duration |
| **Source file** | `src/services/sqlService.ts` |

---

## Key File Map

| File | Role |
|------|------|
| `src/services/memoryRAGSystem.ts` | Main pipeline — orchestrates embedding, dual search, aggregation, reporting |
| `src/services/ragOrchestrator.ts` | Dual-write and dual-search across Vector + Graph + SQL |
| `src/services/memoryPostSearchAggregator.ts` | Merges vector/graph results, runs LLM aggregation strategies |
| `src/services/vectorService.ts` | Qdrant client — upsert, search, delete, category/tag queries |
| `src/services/graphService.ts` | Neo4j client — upsert, vector search, related memories, tag/category traversal |
| `src/services/sqlService.ts` | SQLite — metadata CRUD, search history, tag suggestions, cross-DB tracking |
| `src/services/memoryTextProcessor.ts` | LLM-based categorization, tagging, summarization |
| `src/services/modelClients.ts` | Embedding and inference client abstraction (LMApi, Ollama, LMStudio) |
| `src/services/configService.ts` | Environment-based configuration |
| `src/prompts/aggregation_summary.txt` | Post-search aggregation prompt template |
| `src/prompts/categorization.txt` | Category classification prompt |
| `src/prompts/tagging.txt` | Tag assignment prompt |
| `src/prompts/tag_suggestion.md` | Novel tag generation prompt |
| `src/prompts/memory_summary.txt` | Memory summarization prompt |
| `src/app/memoryMcpServer.ts` | MCP server — exposes `search_memories` and `add_memory` tools |
| `src/app/memoryAPI.ts` | REST API endpoints for memory CRUD and search |

---

## Current Constants & Defaults

| Constant | Value | Location |
|----------|-------|----------|
| `MAX_MEMORIES_FOR_SUMMARY` | 10 | `memoryRAGSystem.ts` |
| `MAX_CLUSTERS` | 5 | `memoryRAGSystem.ts` |
| `MAX_MEMORIES_PER_CLUSTER` | 5 | `memoryRAGSystem.ts` |
| Default `scoreThreshold` | 0.7 | `memoryPostSearchAggregator.ts` |
| Default search `limit` | 5 | `vectorService.ts` (overridden to `limit × 2` in `memoryRAGSystem.ts`) |
| Vector dimensions | 768 | `vectorService.ts`, `graphService.ts` |
| Embedding model | nomic-embed-text | `configService.ts` |
| Merge weighting | 50-50 (vector × 0.5 + graph × 0.5) | `memoryPostSearchAggregator.ts` |
| Graph scoring | shared tags × 2, shared category × 1 | `graphService.ts` (Cypher query) |

---

## Consumers

| Consumer | Interface | What It Returns |
|----------|-----------|-----------------|
| **MCP Tool** (`search_memories`) | `memoryMcpServer.ts` | JSON with topMemories, aggregateNarrative/Bullets, clusterSummaries |
| **REST API** (`/api/memories/search-and-summarize`) | `memoryAPI.ts` | Same structured result as MCP |
| **REST API** (`/api/memories/search`) | `memoryAPI.ts` | Vector search results only (no aggregation) |
| **Review UI** | `public/index.html` + `app.js` | Queue management for memory curation before commit |

---

## Documentation Index

| Document | Topic |
|----------|-------|
| [01-MULTI-DB-ARCHITECTURE.md](01-MULTI-DB-ARCHITECTURE.md) | Why vector + graph + SQL work together, when each excels |
| [02-GRAPH-DB-IMPROVEMENTS.md](02-GRAPH-DB-IMPROVEMENTS.md) | Deeper Neo4j: entity extraction, multi-hop, fulltext integration |
| [03-RERANKING-AND-MERGING.md](03-RERANKING-AND-MERGING.md) | Re-ranking strategies, RRF, LLM re-ranking, scaling result merging |
| [04-QUERY-ANALYSIS.md](04-QUERY-ANALYSIS.md) | Query classification and adaptive retrieval strategies |
| [05-DATABASE-SYNC.md](05-DATABASE-SYNC.md) | Keeping three databases consistent, failure recovery |
| [06-EMBEDDING-MODEL-GUIDE.md](06-EMBEDDING-MODEL-GUIDE.md) | Embedding model tradeoffs, when to change, re-embedding strategy |
| [07-SCALING-STRATEGIES.md](07-SCALING-STRATEGIES.md) | What changes at 1K, 10K, 100K memories |
| [08-IMPROVEMENT-ROADMAP.md](08-IMPROVEMENT-ROADMAP.md) | Prioritized improvements (P0–P3) with implementation specs |
| [09-STALE-MEMORY-MANAGEMENT.md](09-STALE-MEMORY-MANAGEMENT.md) | Future: freshness, archival, contradiction detection |
