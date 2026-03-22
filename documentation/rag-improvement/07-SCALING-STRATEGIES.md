# Scaling Strategies

> **Related docs**: [03-RERANKING-AND-MERGING.md](03-RERANKING-AND-MERGING.md) · [06-EMBEDDING-MODEL-GUIDE.md](06-EMBEDDING-MODEL-GUIDE.md) · [08-IMPROVEMENT-ROADMAP.md](08-IMPROVEMENT-ROADMAP.md)

## Current Capacity Constraints

| Constraint | Current Value | Location |
|-----------|---------------|----------|
| MAX_MEMORIES_FOR_SUMMARY | 10 | `memoryRAGSystem.ts` |
| MAX_CLUSTERS | 5 | `memoryRAGSystem.ts` |
| MAX_MEMORIES_PER_CLUSTER | 5 | `memoryRAGSystem.ts` |
| Default search limit | 5 (doubled to 10 by `limit × 2` in `searchAndSummarizeForMcp`) | `vectorService.ts` / `memoryRAGSystem.ts` |
| Score threshold | 0.7 | `memoryPostSearchAggregator.ts` |
| Vector dimensions | 768 | `vectorService.ts`, `graphService.ts` |
| Qdrant distance metric | Cosine | `vectorService.ts` |

These values were chosen for a small knowledge base (< 100 memories). As the collection grows, they need to adapt.

---

## What Changes at Each Scale

### 100 Memories (Current)

**Status**: Current approach works fine.

**Characteristics**:
- Vector search returns 5–15 candidates with clear score separation
- Graph has sparse connections (few shared tags between memories)
- Score threshold of 0.7 filters out ~40% of results (fine at this scale)
- LLM can summarize 10 memories in a single context window
- Search latency: < 2 seconds total

**No changes needed** — focus on pipeline quality improvements (merge algorithm, query analysis) rather than scaling.

### 1,000 Memories

**What changes**:
- Vector search returns denser results — more memories compete for top positions
- Score separation decreases (many memories at 0.65–0.80 range)
- Graph connections become richer (more shared tags, more traversal paths available)
- 10 memories for summary may miss important context
- Some categories have 50+ memories — cluster aggregation becomes valuable

**Recommended adjustments**:

| Setting | Change | Rationale |
|---------|--------|-----------|
| Score threshold | Lower to 0.4–0.5 | Denser scores mean 0.7 filters too aggressively |
| Search limit | Increase to 15–20 (before merge) | More candidates for better ranking |
| MAX_MEMORIES_FOR_SUMMARY | Increase to 15 | Need broader context |
| Use RRF instead of score averaging | Yes | Score normalization breaks down with denser distributions |
| Category pre-filtering | Consider for code/preference queries | Reduces search space by 70–80% |

**New capability to add**: **Category pre-filtering** — use Qdrant's payload filter or graph's IN_CATEGORY relationship to narrow the search space before vector similarity:

```
// Instead of:
searchMemoriesWithEmbedding(embedding, undefined, 20)  // all categories

// Use:
searchMemoriesWithEmbedding(embedding, 'Code Snippet', 20)  // specific category
```

This is already supported by `vectorService.searchMemoriesWithEmbedding(queryEmbedding, category, limit)` — the `category` parameter is just rarely used.

### 10,000 Memories

**What changes**:
- Vector search latency increases (Qdrant with 10K × 768-dim is still fast, < 100ms)
- Neo4j graph traversal becomes more expensive (many paths to explore)
- Score distributions become very dense — top 50 results are all 0.60–0.85
- A broad query ("What do I know about programming?") might match 500+ memories
- LLM context window cannot hold all relevant memories
- Cluster aggregation with 5 clusters of 5 memories only covers 25 out of potentially hundreds of relevant results

**Recommended adjustments**:

| Setting | Change | Rationale |
|---------|--------|-----------|
| Two-stage retrieval | Required | Broad recall (100 candidates) → re-rank (top 20) → summarize (top 10) |
| Graph traversal depth | Limit to 1-hop only | 2-hop at 10K nodes is expensive |
| Pre-filtering | Aggressive | Use SQL metadata (category, date range) to narrow before vector search |
| MAX_MEMORIES_FOR_SUMMARY | Keep at 15–20 after re-ranking | Re-ranking ensures only the best make the cut |
| Embedding indexing | Enable scalar quantization in Qdrant | Reduces memory usage by 4×, minor quality tradeoff |
| Aggregation strategy | Default to cluster-category for broad queries | Linear can't handle 20 memories effectively |

**Two-stage retrieval pattern**:

```
Stage 1: Recall (high limit, low threshold)
  ├── Vector: top 50 by embedding similarity
  ├── Graph: top 30 by traversal score
  └── Fulltext: top 20 by keyword match
  → RRF merge → 80 unique candidates

Stage 2: Precision (re-rank, strict limit)
  → LLM re-rank or cross-encoder → top 15
  → Summarize

Time budget: ~5s total (Stage 1: 1s, Stage 2: 3s, Summarize: 1s)
```

**New capability to add**: **SQL pre-filtering pipeline**

Before running vector/graph search, query SQLite to narrow the candidate pool:

```
Pre-filter examples:
  - "Recent notes" → SQL WHERE Created > date_sub(now, 30 days) → get IDs → filter Qdrant search to these IDs
  - "My code snippets" → SQL WHERE Category = 'Code Snippet' → use as Qdrant payload filter
  - "Active projects" → SQL WHERE Status != 'Archived' → exclude stale memories
```

This is possible because Qdrant supports filtering by point ID, and the IDs are tracked in SQLite's `MemoryDatabaseRelations` table.

### 100,000+ Memories

**What changes**:
- Qdrant search is still fast (HNSW index handles millions of vectors), but storage and memory usage matter
- Neo4j graph becomes very dense — traversal without limits is expensive
- Embedding storage: 100K × 768 dims × 4 bytes = ~300 MB per database (Qdrant + Neo4j)
- Full re-embedding for model upgrades takes hours
- Aggregation must be highly selective — cannot process even 50 memories per query

**Recommended adjustments** (long-term planning):

| Setting | Change | Rationale |
|---------|--------|-----------|
| Scalar quantization | Enable in Qdrant | Reduces storage by 4×, search speed by 2× |
| Matryoshka embeddings | Consider for two-stage search | Fast approximate search on 256-dim, precise on 768-dim |
| Graph community detection | Implement | Pre-computed clusters enable sub-graph search instead of full traversal |
| Memory archival | Required (see [09-STALE-MEMORY-MANAGEMENT.md](09-STALE-MEMORY-MANAGEMENT.md)) | Reduce active search space |
| Sharded collections | Consider | Split by category or date range into separate Qdrant collections |
| Batch re-ranking | Required | Cannot LLM-rank 100 candidates — batch into groups of 10=20 |

**This scale is far off** — don't implement these now. The architecture supports growth to this level with incremental changes.

---

## Context Window Management

The LLM that performs aggregation has a finite context window. As more memories are retrieved, more compete for space in the prompt. The current approach packs memories into the prompt as text — each memory's Content + Description + Tags.

### How Much Fits?

Estimated tokens per memory:

| Memory Component | Tokens (est.) | Notes |
|-----------------|------:|-------|
| Content | 50–200 | Short text to a few paragraphs |
| Description | 20–50 | LLM-generated summary |
| Tags | 5–15 | Comma-separated list |
| Formatting overhead | 10–20 | Labels, separators |
| **Total per memory** | **85–285** | |

For a 16K-token context window (LMApi maxTokens=16000):
- System prompt: ~800 tokens (aggregation_summary.txt)
- Reserved for output: ~2,000 tokens
- Available for memories: ~13,000 tokens
- **Maximum memories**: 13,000 / 200 = **~65 memories at average length**

For most queries, 10–20 memories is well within limits. The constraint only matters at scale.

### Strategies for Large Result Sets

**Strategy 1: Truncate memory content**

Include only the Description (summary) instead of full Content for lower-ranked memories:

```
Top 5 memories:  Full Content + Description + Tags
Next 10 memories: Description + Tags only
Remaining:       Tags + one-line Content preview
```

This fits more memories in the same context window while preserving detail for the most relevant ones.

**Strategy 2: Progressive summarization** (see [03-RERANKING-AND-MERGING.md](03-RERANKING-AND-MERGING.md))

Summarize in groups, then synthesize:

```
Group 1 (Preferences): memories 1–5 → summary_1
Group 2 (Code):        memories 6–12 → summary_2
Group 3 (Projects):    memories 13–18 → summary_3
Synthesis:             summary_1 + summary_2 + summary_3 → final response
```

This uses more LLM calls but handles arbitrary result counts.

**Strategy 3: Relevance-weighted context allocation**

Allocate more context window space to higher-scoring memories:

```
Score 0.8+:  Full content (up to 300 tokens each)
Score 0.5–0.8: Description only (up to 80 tokens each)
Score 0.3–0.5: One-line summary (up to 30 tokens each)
```

This naturally scales — as more memories compete, lower-scored ones are compressed.

---

## Dynamic Limits Based on Result Count

Instead of fixed constants, adapt limits based on what the retrieval pipeline returns:

### Adaptive MAX_MEMORIES_FOR_SUMMARY

```
mergedResultCount → effectiveSummaryLimit:
  1–5:      Use all results (no truncation)
  6–15:     Use mergedResultCount (accommodate all)
  16–30:    Use 15 (with truncation for lower-ranked)
  31+:      Use 20 (with progressive summarization)
```

### Adaptive MAX_CLUSTERS

```
mergedResultCount → effectiveMaxClusters:
  1–10:     No clustering (use linear)
  11–20:    3 clusters
  21–50:    5 clusters
  51+:      7 clusters (with progressive summarization)
```

### Implementation

Add a helper in `memoryRAGSystem.ts` or `memoryPostSearchAggregator.ts`:

```
function resolveEffectiveLimits(resultCount: number): {
    summaryLimit: number;
    maxClusters: number;
    maxPerCluster: number;
    strategy: string;
} {
    if (resultCount <= 5) return { summaryLimit: resultCount, maxClusters: 0, maxPerCluster: 0, strategy: 'linear' };
    if (resultCount <= 15) return { summaryLimit: resultCount, maxClusters: 3, maxPerCluster: 5, strategy: 'linear' };
    if (resultCount <= 30) return { summaryLimit: 15, maxClusters: 5, maxPerCluster: 5, strategy: 'cluster-category' };
    return { summaryLimit: 20, maxClusters: 7, maxPerCluster: 5, strategy: 'hybrid' };
}
```

---

## Monitoring with SearchHistory

The `SearchHistory` table already captures the data needed to detect scaling issues:

### Signals to Monitor

| Signal | SQL Query | What It Tells You |
|--------|----------|-------------------|
| Average result count | `SELECT AVG(ResultCount) FROM SearchHistory` | Are queries returning enough results? |
| Result count trend | `SELECT date(Created), AVG(ResultCount) FROM SearchHistory GROUP BY date(Created)` | Is result count growing with the collection? |
| Average search duration | `SELECT AVG(Duration) FROM SearchHistory` | Is search getting slower? |
| Graph contribution | `SELECT AVG(json_array_length(GraphResults)) FROM SearchHistory` | Is graph search adding unique results? |
| Threshold filter rate | Compare VectorResults count + GraphResults count vs. ResultCount | How many candidates are being filtered out? |

### When to Act

| Signal | Current | Warning | Action Needed |
|--------|---------|---------|--------------|
| Average result count | 5–10 | < 3 or > 30 | Adjust threshold or limits |
| Search duration | < 2s | > 5s | Optimize queries, add pre-filtering |
| Graph unique contribution | > 20% | < 5% | Graph isn't helping — check structure |
| Threshold filter rate | 30–50% | > 80% | Threshold too aggressive; lower it |

---

## Summary: What to Do When

| Memory Count | Key Actions |
|-------------|-------------|
| **< 100** (now) | Focus on merge quality, not scaling. Implement RRF, lower threshold, add query analysis. |
| **100–500** | Monitor SearchHistory signals. Consider fulltext search integration. |
| **500–1,000** | Lower threshold further. Increase search limits. Add category pre-filtering for typed queries. |
| **1,000–5,000** | Implement two-stage retrieval. Add LLM re-ranking. Use progressive summarization. |
| **5,000–10,000** | Enable Qdrant scalar quantization. Limit graph traversal depth. SQL pre-filtering required. |
| **10,000+** | Consider embedding model with Matryoshka support, graph community detection, memory archival. |
