# Improvement Roadmap

> Prioritized list of improvements for a coding assistant to implement. Each item references its detailed specification in the corresponding documentation file.

## How to Read This

- **Priority tiers**: P0 (do first) → P3 (do later)
- **Complexity**: Low (< 1 hour), Medium (1–4 hours), High (4+ hours)
- **Files to modify**: Exact files in the codebase that need changes
- **Dependencies**: What must be done before this item

---

## P0 — Immediate (Fix Current Pipeline Gaps)

These address concrete problems with the current merge pipeline where the graph database's primary strengths (relationship traversal, fulltext search) are unused.

### P0-1: Replace Score Averaging with Reciprocal Rank Fusion

**Why**: The current `(vectorScore × 0.5) + (normalizedGraphScore × 0.5)` breaks when score distributions differ between databases. Memories that appear in both vector and graph results don't get sufficient boost. RRF is score-distribution-agnostic and explicitly rewards cross-source agreement.

**Complexity**: Low

**Files to modify**:
- `src/services/memoryPostSearchAggregator.ts` — Replace `mergeVectorAndGraphResults()` body

**Specification**: [03-RERANKING-AND-MERGING.md § Reciprocal Rank Fusion](03-RERANKING-AND-MERGING.md)

**What to implement**:
1. Assign rank positions (1-indexed) to each result within their source list (vector, graph)
2. For each unique memory: `rrfScore = Σ 1 / (k + rank_in_source)` where `k = 60`
3. Memories appearing in both lists get both terms summed
4. Sort by rrfScore descending
5. No threshold filter needed — RRF scores are naturally bounded

**Dependencies**: None

---

### P0-2: Use Graph Traversal Instead of Graph Vector Search in Merge Pipeline

**Why**: `ragOrchestrator.searchVectorAndGraphParallel()` calls `graphService.getMemoriesByKeywordAndSimilarity(queryVector, limit)` which just runs `vectorSearch()` on Neo4j's vector index — the same cosine similarity as Qdrant. This means both search sources are doing the same thing. The graph's actual value is its relationships (tags, categories).

**Complexity**: Medium

**Files to modify**:
- `src/services/ragOrchestrator.ts` — Change graph search call
- `src/services/graphService.ts` — May need new method or adapt `getRelatedMemories()`

**Specification**: [02-GRAPH-DB-IMPROVEMENTS.md § Improvement 1](02-GRAPH-DB-IMPROVEMENTS.md)

**What to implement**:
1. Run vector search on Qdrant first → get top results
2. For each top result, use `getRelatedMemories(memory.Title)` to find graph-connected memories
3. Alternatively: run Qdrant first, extract top tags from results, then run graph traversal `MATCH (m:Memory)-[:TAGGED_WITH]->(t:Tag) WHERE t.name IN $topTags` to find structurally related memories
4. The graph results should be memories that Qdrant didn't surface — that's where the value is

**Dependencies**: None, but benefits from P0-1 (RRF handles the merge better than score averaging)

---

### P0-3: Lower Score Threshold from 0.7 to 0.5

**Why**: The 0.7 threshold filters out memories that are relevant but not exact matches. For exploratory queries ("What do I know about React?"), this eliminates memories about React components, hooks, patterns, etc. that score 0.55–0.69.

**Complexity**: Low

**Files to modify**:
- `src/services/memoryPostSearchAggregator.ts` — Change `SCORE_THRESHOLD` constant (or wherever 0.7 is defined)

**Specification**: [03-RERANKING-AND-MERGING.md § Threshold Analysis](03-RERANKING-AND-MERGING.md)

**What to implement**:
1. Change threshold from 0.7 to 0.5
2. If using RRF (P0-1), the threshold may not be needed at all — RRF naturally handles low-confidence results
3. Add a log line for filtered-out memories so you can monitor what's being dropped

**Dependencies**: None (ideally implement alongside P0-1)

---

### P0-4: Add Fulltext Search to Graph Pipeline

**Why**: Neo4j has a fulltext index on `content` and `description` fields that is already created but never queried during the search pipeline. Fulltext search catches keyword matches that embedding similarity misses (exact names, technical terms, acronyms).

**Complexity**: Low

**Files to modify**:
- `src/services/graphService.ts` — Add a method `fulltextSearch(query: string, limit: number)`

**Specification**: [02-GRAPH-DB-IMPROVEMENTS.md § Improvement 2](02-GRAPH-DB-IMPROVEMENTS.md)

**What to implement**:
1. Add method using existing fulltext index:
   ```
   CALL db.index.fulltext.queryNodes('memoryFulltextIndex', $query) YIELD node, score
   RETURN node { .*, score: score } LIMIT $limit
   ```
2. Integrate into `ragOrchestrator.searchVectorAndGraphParallel()` as a third signal alongside vector and graph
3. Feed fulltext results into RRF merge (P0-1) as a third source

**Dependencies**: Fulltext index already exists (created in `initializeSchema()`). Benefits from P0-1 for three-way merge.

---

## P1 — High Value (Query Intelligence & Adaptive Behavior)

These make the pipeline smarter about different query types and adapt its behavior dynamically.

### P1-1: Query Type Classification

**Why**: "What's my OpenAI API key?" and "What do I know about TypeScript?" need completely different retrieval strategies. Currently both get the same pipeline: vector + graph merge → LLM summarize.

**Complexity**: Medium

**Files to modify**:
- `src/services/memoryRAGSystem.ts` — Add classification step before search
- `src/prompts/` — New prompt file for classifier
- `src/services/memoryPostSearchAggregator.ts` — Accept query type for strategy selection

**Specification**: [04-QUERY-ANALYSIS.md § Full specification](04-QUERY-ANALYSIS.md)

**What to implement**:
1. Before search, classify query into: fact_retrieval, exploration, code, relational, temporal
2. Route each type to a tuned strategy:
   - fact_retrieval: vector-only, low limit (5), linear aggregation
   - exploration: vector + graph + fulltext, high limit (20), cluster aggregation
   - code: vector with category filter ('Code Snippet'), linear
   - relational: graph-heavy (traversal-focused), cluster-tag aggregation
   - temporal: SQL pre-filter by date, then vector search
3. Use LLM classification with structured output (temperature 0.1)

**Dependencies**: P0-1 (RRF), P0-2 (graph traversal), P0-4 (fulltext)

---

### P1-2: Adaptive Source Weighting

**Why**: When vector and graph return very different results, one source is more useful than the other for that query. Currently both are weighted equally.

**Complexity**: Medium

**Files to modify**:
- `src/services/memoryPostSearchAggregator.ts` — Modify merge function to accept source weights

**Specification**: [03-RERANKING-AND-MERGING.md § Dynamic Weighting](03-RERANKING-AND-MERGING.md)

**What to implement**:
1. Calculate overlap ratio: `overlap = |vectorIDs ∩ graphIDs| / |vectorIDs ∪ graphIDs|`
2. High overlap (> 0.5): Sources agree — trust vector scores more (k=60 for vector, k=80 for graph in RRF)
3. Low overlap (< 0.2): Sources disagree — boost graph results (k=60 for both, but increase graph result limit)
4. Can also be driven by query type (P1-1): fact → vector-heavy, relational → graph-heavy

**Dependencies**: P0-1 (RRF), P1-1 (query type) optional but valuable

---

### P1-3: Two-Stage Retrieval

**Why**: At 1,000+ memories, a single search pass may not surface the best results. A two-stage approach: broad recall → precise re-ranking produces better results.

**Complexity**: High

**Files to modify**:
- `src/services/ragOrchestrator.ts` — Restructure search pipeline
- `src/services/memoryRAGSystem.ts` — Adjust searchAndSummarizeForMcp to use two stages

**Specification**: [03-RERANKING-AND-MERGING.md § LLM-as-Filter](03-RERANKING-AND-MERGING.md) · [07-SCALING-STRATEGIES.md § Two-Stage Retrieval](07-SCALING-STRATEGIES.md)

**What to implement**:
1. Stage 1 (Recall): Run vector (50 candidates) + graph (30) + fulltext (20) → RRF merge → 80 unique candidates
2. Stage 2 (Precision): LLM re-ranks top 30 by relevance to original query → select top 15
3. Stage 3 (Summarize): Feed top 15 to aggregation pipeline

**Dependencies**: P0-1, P0-2, P0-4 should be done first. This builds on the multi-source merge.

---

### P1-4: Entity Extraction for Graph Enrichment

**Why**: Currently Neo4j only has Memory, Tag, and Category nodes. Adding Project, Tool, Person, Topic nodes enables richer traversal and discovery.

**Complexity**: High

**Files to modify**:
- `src/services/graphService.ts` — Add entity node types and extraction
- `src/services/memoryTextProcessor.ts` — Extract entities during memory creation
- `src/prompts/` — New prompt for entity extraction

**Specification**: [02-GRAPH-DB-IMPROVEMENTS.md § Improvement 3](02-GRAPH-DB-IMPROVEMENTS.md)

**What to implement**:
1. During memory creation, use LLM to extract entities: projects, tools, people, topics
2. Create nodes: `(:Project {name})`, `(:Tool {name})`, `(:Person {name})`, `(:Topic {name})`
3. Create relationships: `(:Memory)-[:MENTIONS_PROJECT]->(:Project)`, etc.
4. During search: traverse these relationships to find memories connected through shared entities
5. Run entity extraction on existing memories as a backfill script

**Dependencies**: None, but should schedule after P0 improvements since it requires more significant graph schema changes

---

## P2 — Enhancement (Refinement & Reliability)

These improve quality and reliability but are not critical path.

### P2-1: Cross-Encoder Re-Ranking

**Why**: Bi-encoder (embedding) search is fast but approximates relevance. Cross-encoders score query-document pairs directly and are 10–20% more accurate for re-ranking.

**Complexity**: High

**Files to modify**:
- New service: `src/services/rerankerService.ts`
- `src/services/ragOrchestrator.ts` — Integrate after merge, before aggregation
- `src/services/modelClients.ts` — Add re-ranker model client

**Specification**: [03-RERANKING-AND-MERGING.md § Cross-Encoder Re-Ranking](03-RERANKING-AND-MERGING.md)

**What to implement**:
1. After RRF merge, take top 20–30 candidates
2. Run each candidate with the original query through a cross-encoder model
3. Re-sort by cross-encoder score
4. Take top 10–15 for summarization
5. Consider running cross-encoder as a local model (Sentence Transformers) to avoid API costs

**Dependencies**: P0-1 (RRF merge to produce candidates), P1-3 (two-stage pipeline architecture)

---

### P2-2: Multi-Hop Graph Traversal

**Why**: 1-hop traversal only finds memories that share a direct tag or category. 2-hop finds memories connected through intermediate nodes, enabling discovery of indirectly related memories.

**Complexity**: Medium

**Files to modify**:
- `src/services/graphService.ts` — Extend `getRelatedMemories()` or add new method

**Specification**: [02-GRAPH-DB-IMPROVEMENTS.md § Improvement 4](02-GRAPH-DB-IMPROVEMENTS.md)

**What to implement**:
1. Add 2-hop traversal: `(m:Memory)-[:TAGGED_WITH]->(t:Tag)<-[:TAGGED_WITH]-(m2:Memory)-[:TAGGED_WITH]->(t2:Tag)<-[:TAGGED_WITH]-(m3:Memory)`
2. Score with decay: 1-hop = 1.0×, 2-hop = 0.5×
3. Set limit on intermediate results to prevent explosion
4. Only use for exploration queries (P1-1) where breadth is valued

**Dependencies**: P1-1 (query classification to know when to use multi-hop), P1-4 (entity nodes make multi-hop more valuable)

---

### P2-3: Database Reconciliation Script

**Why**: Write failures can leave databases out of sync (memory in SQL but not in Qdrant, or in Qdrant but not in Neo4j). A reconciliation script detects and repairs these inconsistencies.

**Complexity**: Medium

**Files to modify**:
- New script: `src/scripts/reconcileDatabase.ts`
- `src/services/sqlService.ts` — May need helper queries

**Specification**: [05-DATABASE-SYNC.md § Reconciliation Script](05-DATABASE-SYNC.md)

**What to implement**:
1. Get all memory IDs from each database (SQL, Qdrant, Neo4j)
2. Find discrepancies: present in one DB but not others
3. SQL is source of truth — if missing from SQL, it's an orphan
4. For missing entries in Qdrant/Neo4j: re-create from SQL data
5. Report discrepancies and actions taken

**Dependencies**: None

---

### P2-4: Search Feedback Loop

**Why**: Use SearchHistory data to detect when the pipeline is degrading and to A/B test improvements.

**Complexity**: Medium

**Files to modify**:
- `src/services/memoryReportService.ts` — Add search quality dashboard
- `src/services/sqlService.ts` — Add aggregate query methods

**Specification**: [07-SCALING-STRATEGIES.md § Monitoring with SearchHistory](07-SCALING-STRATEGIES.md)

**What to implement**:
1. Dashboard queries: average result count over time, graph contribution rate, search duration trends
2. Alert thresholds: result count < 3 or > 30, duration > 5s, graph contribution < 5%
3. Expose via API endpoint or MCP tool for periodic review

**Dependencies**: None

---

## P3 — Future (When Scale Demands It)

### P3-1: Stale Memory Management

**Why**: Memories become outdated as tools, preferences, and projects change. Stale memories pollute search results.

**Complexity**: High

**Files to modify**: See [09-STALE-MEMORY-MANAGEMENT.md](09-STALE-MEMORY-MANAGEMENT.md) for full specification

**What to implement**: Time-based decay, usage-based scoring, contradiction detection, archival workflow

**Dependencies**: P2-4 (feedback loop helps identify which memories are stale)

---

### P3-2: Embedding Model Upgrade

**Why**: nomic-embed-text (768-dim) is a strong baseline. When the collection grows past 5K–10K memories, a Matryoshka-capable model enables two-stage search (fast approximate on 256-dim, precise on 768-dim).

**Complexity**: High (re-embedding all memories)

**Files to modify**: See [06-EMBEDDING-MODEL-GUIDE.md](06-EMBEDDING-MODEL-GUIDE.md) for full specification

**Dependencies**: This is a big migration. Only do it when there's a measurable quality problem with current embeddings.

---

### P3-3: Graph Community Detection

**Why**: At 10K+ memories, pre-computed clusters of related memories enable sub-graph search instead of full traversal.

**Complexity**: High

**Files to modify**:
- `src/services/graphService.ts` — Add community detection using Neo4j GDS

**What to implement**:
1. Use Neo4j Graph Data Science library to run Louvain or Label Propagation algorithms
2. Assign community IDs to Memory nodes
3. During search: identify the community of top results → search within that community for more related memories
4. Re-run community detection periodically (weekly) as new memories are added

**Dependencies**: P1-4 (entity extraction creates richer graph for better communities)

---

## Implementation Order (Recommended Sequence)

```
Week 1:  P0-1 (RRF) + P0-3 (lower threshold)
         ↓
Week 2:  P0-2 (graph traversal in merge) + P0-4 (fulltext search)
         ↓
Week 3:  P1-1 (query classification)
         ↓
Week 4:  P1-2 (adaptive weighting) + P2-3 (reconciliation script)
         ↓
Week 5+: P1-3 (two-stage retrieval) + P1-4 (entity extraction)
         ↓
Later:   P2-1, P2-2, P2-4 as quality data accumulates
         ↓
Scale:   P3-1, P3-2, P3-3 when memory count demands it
```

### Dependencies Graph

```
P0-1 (RRF) ──────────→ P1-2 (adaptive weighting)
  │                       │
  ├──→ P0-4 (fulltext) ──┤
  │                       ↓
  └──→ P1-3 (two-stage retrieval) ──→ P2-1 (cross-encoder)
  
P0-2 (graph traversal) ──→ P1-1 (query classification) ──→ P2-2 (multi-hop)
                                                              ↑
P1-4 (entity extraction) ─────────────────────────────────────┘
                                    │
                                    └──→ P3-3 (community detection)

P0-3 (lower threshold) ── no dependencies
P2-3 (reconciliation)  ── no dependencies
P2-4 (feedback loop)   ── no dependencies → P3-1 (stale memory)
```
