# Graph Database Improvements

> **Related docs**: [01-MULTI-DB-ARCHITECTURE.md](01-MULTI-DB-ARCHITECTURE.md) · [03-RERANKING-AND-MERGING.md](03-RERANKING-AND-MERGING.md) · [08-IMPROVEMENT-ROADMAP.md](08-IMPROVEMENT-ROADMAP.md)

## Current State

### What Exists in Neo4j

**Nodes**: `Memory`, `Tag`, `Category`

**Relationships**: `TAGGED_WITH` (Memory→Tag), `IN_CATEGORY` (Memory→Category)

**Indexes** (from `graphService.ts` `initializeSchema()`):
- Unique constraints: `memory_id_unique`, `tag_name_unique`, `category_name_unique`
- Property index: `memory_last_updated_index`
- **Vector index**: `memory_embedding_index` — 768-dim, cosine similarity
- **Fulltext index**: `memory_fulltext_index` — on `content` and `description`

**Graph search in the merge pipeline** (via `ragOrchestrator.ts` `searchVectorAndGraphParallel()`):
- Calls `graphService.getMemoriesByKeywordAndSimilarity()` which delegates to `graphService.vectorSearch()`
- This runs: `CALL db.index.vector.queryNodes('memory_embedding_index', $topK, $queryVector)`
- Returns memory nodes with cosine similarity scores (0–1 range)

**What is NOT used in the merge pipeline**:
- `getRelatedMemories()` — 1-hop tag/category traversal (exists but not called during search)
- Fulltext index `memory_fulltext_index` — exists but no search method leverages it
- Multi-hop traversal — not implemented

**Key gap**: The graph is currently used as a **second vector database**, not as a graph. Running the same cosine similarity search on Neo4j's vector index and Qdrant's collection returns similar results, which reduces the diversity benefit of dual search.

---

## Understanding the Gap: Vector Search vs. Graph Traversal

The power of a graph database is **relationship traversal**, not vector similarity. For vector similarity, Qdrant is purpose-built and faster. Neo4j's value proposition is answering questions that vector search cannot:

| Question | Answer From |
|----------|-------------|
| "What memories are semantically similar to this query?" | Vector search (Qdrant) |
| "What other memories share tags with the vector search results?" | Graph traversal (Neo4j) |
| "What concept cluster does this memory belong to?" | Graph traversal + community detection |
| "What memories mention the same project as this one?" | Entity-based graph traversal |
| "What keywords appear in memories related to this query?" | Fulltext search (Neo4j) |

**Recommendation**: Change the graph's role in the merge pipeline from vector similarity (redundant with Qdrant) to **relationship traversal** and **fulltext search** (complementary to Qdrant).

---

## Improvement 1: Use Graph Traversal Instead of Graph Vector Search

### Current Approach (Redundant)

```
Query → Embedding → ┬→ Qdrant vector search      → vectorResults
                     └→ Neo4j vector search (same) → graphResults  ← REDUNDANT
```

Both searches operate on the same embedding space. Overlap will be high, reducing the benefit of merging.

### Proposed Approach (Complementary)

```
Query → Embedding → Qdrant vector search → vectorResults
                                               │
              For each vector result: ─────────┘
                  │
                  └→ Neo4j getRelatedMemories(resultId)
                       → Find memories sharing tags/categories
                       → graphResults  ← COMPLEMENTARY
```

**How it works:**
1. Run vector search on Qdrant (get top N similar memories)
2. For the top K vector results, walk Neo4j relationships to find related memories
3. The graph now surfaces memories that are **structurally connected** to the semantically relevant ones — a genuinely different signal

**Implementation in `ragOrchestrator.ts`:**
- Replace `getMemoriesByKeywordAndSimilarity(queryVector, limit)` with a new method
- New method: take the IDs of top vector results → call `getRelatedMemories()` for each → aggregate and deduplicate
- This uses the existing `getRelatedMemories()` Cypher query (shared tags × 2, shared category × 1)

**Tradeoff**: Slightly more latency (sequential: vector first, graph second) vs. current parallel approach. But the quality gain from complementary results outweighs the ~50–200ms added latency.

**Hybrid option**: Run both in parallel by using *previous* search results to seed the graph traversal:
- Keep a small cache of recent search results per session
- Use those IDs for graph expansion while the current vector search runs

---

## Improvement 2: Integrate Fulltext Search

Neo4j has a fulltext index on `content` and `description` (`memory_fulltext_index`) that is currently unused. Fulltext search is particularly valuable for:

- **Exact keyword matching**: Vector search may miss "TypeScript" if the embedding focuses on the broader "programming" concept. Fulltext search will find the exact keyword.
- **Code-related queries**: Code snippets have specific identifiers (function names, library names) that fulltext search handles better than embeddings.
- **Named entity queries**: "What do I know about Elysia?" — fulltext will find exact mentions.

### Proposed Integration

Add a new method to `graphService.ts`:

```
Method: fulltextSearch(queryText: string, limit: number)

Cypher:
CALL db.index.fulltext.queryNodes('memory_fulltext_index', $queryText)
YIELD node, score
RETURN node AS memory, score
LIMIT $limit
```

Then add fulltext as a **third search modality** in the merge pipeline:

```
Query → ┬→ Qdrant vector search      → vectorResults (semantic)
         ├→ Neo4j graph traversal     → graphResults (structural)
         └→ Neo4j fulltext search     → fulltextResults (keyword)
                   │
             Merge all three with RRF
```

**Files to modify:**
- `graphService.ts`: Add `fulltextSearch()` method
- `ragOrchestrator.ts`: Add fulltext to `searchVectorAndGraphParallel()`
- `memoryPostSearchAggregator.ts`: Update `mergeVectorAndGraphResults()` to accept three result sets

See [03-RERANKING-AND-MERGING.md](03-RERANKING-AND-MERGING.md) for how RRF handles multiple result lists.

---

## Improvement 3: Entity Extraction — Richer Graph Structure

### The Problem with Tags-Only

Currently, the graph has two dimensions of structure:
- Tags (e.g., "TypeScript", "Programming", "Project")
- Categories (e.g., "Code Snippet", "Preference", "Idea")

This limits graph traversal to finding memories that share these exact labels. But memories contain richer entities that aren't captured:

- **Projects**: "MemoryApi", "fitness tracker app", "portfolio site"
- **Tools/Technologies**: "Elysia", "Bun", "Docker", "Neo4j"
- **Concepts**: "deployment", "authentication", "API design"
- **People**: "John", "the team" (as generic roles, not names — per the tag_suggestion.md prompt rules)

### What Entity Extraction Adds

New node types and relationships:

```
Current:
  (Memory)──TAGGED_WITH──>(Tag)
  (Memory)──IN_CATEGORY──>(Category)

With entity extraction:
  (Memory)──TAGGED_WITH──>(Tag)
  (Memory)──IN_CATEGORY──>(Category)
  (Memory)──MENTIONS_PROJECT──>(Project)
  (Memory)──USES_TOOL──>(Tool)
  (Memory)──ABOUT_TOPIC──>(Topic)
  (Memory)──INVOLVES_PERSON──>(Person)
```

### How Traversal Improves

**Before** (current, tags-only):
```
"Elysia REST API" ──TAGGED_WITH──> "TypeScript" <──TAGGED_WITH── "Zod validation"
                                                 <──TAGGED_WITH── "React component" (noise)
```
Every TypeScript memory is a neighbor — low signal.

**After** (with entity extraction):
```
"Elysia REST API" ──USES_TOOL──> "Elysia" <──USES_TOOL── "Elysia middleware patterns"
                   ──ABOUT_TOPIC──> "API Design" <──ABOUT_TOPIC── "REST best practices"
                   ──MENTIONS_PROJECT──> "MemoryApi" <──MENTIONS_PROJECT── "MemoryApi deploy config"
```
Traversal now finds memories related through specific entities, not just broad tags.

### Implementation Approach

**Option A: LLM-Based Entity Extraction** (Recommended)

Add a new prompt and extraction step to `memoryTextProcessor.ts`:

```
New method: extractEntities(content: string): Promise<{
    projects: string[],
    tools: string[],
    topics: string[],
    people: string[]
}>
```

This runs alongside the existing `summarizeClassifyAndTagTextParallel()` during memory ingestion. The LLM extracts structured entity data, which is then stored as graph nodes during `graphService.upsertMemory()`.

**Prompt design considerations:**
- Use the same low-temperature (0.3) approach as categorization/tagging
- Output format: JSON object with arrays for each entity type
- Include examples showing what qualifies as each entity type
- Instruct the LLM to use normalized names (lowercase, singular form) to reduce duplicate nodes

**Option B: Rule-Based Extraction** (Simpler, less accurate)

Use regex and NLP heuristics to extract:
- Tools: match against a known list (configurable)
- Projects: match against previously seen project names
- People: basic NER (Named Entity Recognition)

**Recommendation**: Start with Option A (LLM-based). It's more accurate and fits the existing pattern of using LLM for all metadata generation.

### Graph Schema Changes

```cypher
// New constraints
CREATE CONSTRAINT project_name_unique IF NOT EXISTS FOR (p:Project) REQUIRE p.name IS UNIQUE
CREATE CONSTRAINT tool_name_unique IF NOT EXISTS FOR (t:Tool) REQUIRE t.name IS UNIQUE
CREATE CONSTRAINT topic_name_unique IF NOT EXISTS FOR (tp:Topic) REQUIRE tp.name IS UNIQUE
CREATE CONSTRAINT person_name_unique IF NOT EXISTS FOR (pr:Person) REQUIRE pr.name IS UNIQUE

// New relationships
(Memory)-[:MENTIONS_PROJECT]->(Project)
(Memory)-[:USES_TOOL]->(Tool)
(Memory)-[:ABOUT_TOPIC]->(Topic)
(Memory)-[:INVOLVES_PERSON]->(Person)
```

**Files to modify:**
- `graphService.ts`: Add constraints in `initializeSchema()`, extend `upsertMemory()` to create entity nodes/relationships
- `memoryTextProcessor.ts`: Add `extractEntities()` method
- `memoryRAGSystem.ts`: Call entity extraction during `addMemory()` pipeline
- `src/prompts/`: Add new `entity_extraction.txt` prompt

### Backfill Strategy

Existing memories won't have entities until re-processed. Create a migration script:
1. Load all memories from SQLite (source of truth)
2. Run `extractEntities()` on each
3. Update Neo4j with new entity nodes and relationships
4. No changes to Qdrant or SQLite needed

---

## Improvement 4: Multi-Hop Graph Traversal

### Current: 1-Hop Only

The existing `getRelatedMemories()` query finds memories that share tags or categories with a given memory — this is 1 hop:

```
Memory A → Tag → Memory B (1 hop)
```

### What Multi-Hop Adds

2-hop traversal finds memories connected transitively:

```
Memory A → Tag "TypeScript" → Memory B → Tag "API Design" → Memory C
```

Memory C might be about "REST API security patterns" — not directly sharing any tags with Memory A, but reachable through the graph. This is a discovery that **neither vector search nor 1-hop traversal** would make unless the embeddings happen to be close.

### 2-Hop Traversal Cypher

```cypher
MATCH (m:Memory {id: $memoryId})

// 1-hop: Direct tag/category neighbors
OPTIONAL MATCH (m)-[:TAGGED_WITH|IN_CATEGORY]->(shared)<-[:TAGGED_WITH|IN_CATEGORY]-(hop1:Memory)
WHERE hop1.id <> $memoryId
WITH m, hop1, count(shared) AS hop1Score

// 2-hop: Neighbors of neighbors
OPTIONAL MATCH (hop1)-[:TAGGED_WITH|IN_CATEGORY]->(shared2)<-[:TAGGED_WITH|IN_CATEGORY]-(hop2:Memory)
WHERE hop2.id <> $memoryId AND hop2.id <> hop1.id
WITH hop1, hop1Score, hop2, count(shared2) * 0.5 AS hop2Score  // Decay factor

// Combine and deduplicate
UNWIND(
    [{node: hop1, score: hop1Score}] + 
    [{node: hop2, score: hop2Score}]
) AS item
WITH item.node AS memory, sum(item.score) AS totalScore
WHERE memory IS NOT NULL
RETURN memory, totalScore
ORDER BY totalScore DESC
LIMIT $limit
```

**Key design choices:**
- **Decay factor (0.5)**: 2-hop results are scored at half the rate of 1-hop results, reflecting decreased relevance with distance
- **With entity nodes**: Multi-hop becomes even more powerful — `Memory → Project → Memory → Tool → Memory` discovers memories connected through project and tooling relationships
- **Performance**: 2-hop queries are more expensive. Limit to top vector results only, not for every candidate.

### When Multi-Hop Helps vs. Hurts

**Helps when:**
- Knowledge base has dense, diverse structure (many entities, many connections)
- Queries are exploratory ("What do I know about web development?")
- The graph has entity nodes (projects, tools) — not just tags

**Hurts when:**
- Knowledge base is small (< 100 memories) — few paths exist
- Graph has minimal structure (tags-only) — 2-hop through tags generates noise
- Queries are specific ("What's my preferred IDE?") — direct vector search is better

**Recommendation**: Implement multi-hop **after** entity extraction (Improvement 3). Without entity nodes, 2-hop through tags generates too much noise.

---

## Improvement 5: Dynamic Relationship Weighting

### Current: Static Weights

```cypher
count(t) * 2 AS tagScore    -- each shared tag = 2 points
1 AS catScore                -- shared category = 1 point
```

These weights are fixed and don't account for:
- **Tag frequency**: A rare tag ("MemoryApi") is more informative than a common tag ("Programming")
- **Relationship type importance**: Entity-based relationships (MENTIONS_PROJECT) may be more relevant than tag-based ones
- **Query context**: For a code query, shared "Code Snippet" category is more meaningful than for a preference query

### Data-Driven Weighting with Inverse Frequency

**Concept**: Tags shared by many memories are less informative (analogous to IDF in TF-IDF). Weight rare connections higher.

```cypher
// Pre-compute tag frequency (or pass as parameter)
MATCH (m:Memory {id: $memoryId})-[:TAGGED_WITH]->(t:Tag)<-[:TAGGED_WITH]-(other:Memory)
WHERE other.id <> $memoryId
WITH other, t, size((t)<-[:TAGGED_WITH]-()) AS tagPopularity
WITH other, sum(1.0 / log(tagPopularity + 1)) AS tagScore  // IDF-like weighting
```

**Effect**: A shared tag "MemoryApi" (used by 3 memories) contributes much more to the score than "Programming" (used by 50 memories).

### Relationship Type Weighting (After Entity Extraction)

With entity nodes, different relationship types carry different signals:

| Relationship | Suggested Weight | Rationale |
|-------------|-----------------|-----------|
| `MENTIONS_PROJECT` | 3.0 | Projects are highly specific — shared project = strong relevance |
| `USES_TOOL` | 2.5 | Tools are fairly specific |
| `ABOUT_TOPIC` | 2.0 | Topics are moderately specific |
| `TAGGED_WITH` | 1.5 (× IDF) | Tags vary in specificity — use IDF weighting |
| `IN_CATEGORY` | 1.0 | Categories are broad — lowest weight |
| `INVOLVES_PERSON` | 2.0 | People context is meaningful but not always relevant to content |

These weights should be configurable and tunable based on evaluation results.

---

## Improvement 6: Fulltext-Enhanced Graph Queries

### Combining Fulltext with Traversal

Instead of running fulltext search independently, combine it with graph traversal for compound queries:

```cypher
// Find memories that mention a keyword AND are connected to a given memory
CALL db.index.fulltext.queryNodes('memory_fulltext_index', $queryText)
YIELD node AS ftResult, score AS ftScore

MATCH (seed:Memory {id: $seedMemoryId})
OPTIONAL MATCH (seed)-[:TAGGED_WITH|IN_CATEGORY]->(shared)<-[:TAGGED_WITH|IN_CATEGORY]-(ftResult)
WITH ftResult, ftScore, count(shared) AS graphOverlap
WHERE graphOverlap > 0  // Only keep fulltext results that are also graph-connected

RETURN ftResult AS memory, ftScore * (1 + graphOverlap * 0.2) AS combinedScore
ORDER BY combinedScore DESC
LIMIT $limit
```

This surfaces memories that match both keyword search AND have structural connections — a very strong relevance signal.

---

## Summary of Graph Improvements

| # | Improvement | Complexity | Impact | Prerequisite |
|---|-----------|-----------|--------|-------------|
| 1 | Use traversal instead of graph vector search | Low | High | None |
| 2 | Integrate fulltext search as third modality | Low | Medium | None |
| 3 | Entity extraction (Project, Tool, Topic nodes) | Medium | High | New prompt |
| 4 | Multi-hop traversal | Medium | Medium | Entity extraction (3) |
| 5 | Dynamic relationship weighting (IDF) | Low | Medium | None |
| 6 | Fulltext-enhanced graph queries | Low | Medium | Fulltext integration (2) |

**Recommended order**: 1 → 2 → 5 → 3 → 4 → 6

Start by making the graph complementary to vector search (1, 2, 5), then enrich the graph structure (3), then leverage the richer structure (4, 6).

See [08-IMPROVEMENT-ROADMAP.md](08-IMPROVEMENT-ROADMAP.md) for prioritized implementation sequence across all improvements.
