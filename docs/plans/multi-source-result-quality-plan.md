# Multi-Source Result Quality Plan

**Date:** 2026-08-27
**Area:** How Qdrant, Neo4j, and SQLite results reach the aggregation LLM — and how to make that payload maximally usable by a downstream LLM (Copilot/Claude via MCP)
**Scope:** Retrieval fan-out, merge, serialization, and MCP response shape. Ingestion quality is out of scope.

> **Relationship to existing docs.** `docs/rag-improvement/*` covers the *retrieval strategy* layer (RRF, graph traversal, query analysis, embeddings) and `aggregation-refinement-plan.md` covers *limits and truncation*. Neither covers what this plan is about: the **data fidelity of what each source contributes** and the **shape of the response the consuming LLM actually reads**. Where an item overlaps, it is cross-referenced rather than restated.

---

## 1. How results are produced today (as-built)

Traced through [memoryMcpServer.ts:60](../../src/app/memoryMcpServer.ts#L60) → [memoryRAGSystem.ts](../../src/services/memoryRAGSystem.ts) → [ragOrchestrator.ts](../../src/services/ragOrchestrator.ts) → [memoryPostSearchAggregator.ts](../../src/services/memoryPostSearchAggregator.ts).

```
query
  |
  |- generateEmbedding(query)                        memoryRAGSystem.ts:430
  |
  |- searchVectorAndGraphParallel(emb, category, limit*2)      ragOrchestrator.ts:134
  |    |- Qdrant : searchMemoriesWithEmbedding()  -> cosine, Category filter applied
  |    \- Neo4j  : getMemoriesByKeywordAndSimilarity() -> cosine on Neo4j vector index,
  |                NO category filter, NO traversal
  |
  |- mergeVectorAndGraphResults()                    memoryPostSearchAggregator.ts:129
  |    mergedScore = 0.5*vector + 0.5*(graph / max(maxGraph, 1))
  |    filter >= scoreThreshold (0.6), sort, slice(limit)
  |    -> drops `sources`, `vectorScore`, `graphScore`
  |
  |- aggregateMemories() -> summarize via LLM        memoryPostSearchAggregator.ts:300
  |    packs "ID/Category/Tags/LastUpdated/Description/Content"
  |
  \- JSON.stringify(result, null, 2) -> MCP text content
```

**SQLite participates in retrieval not at all.** It is written on ingest ([memoryRAGSystem.ts:170](../../src/services/memoryRAGSystem.ts#L170)), used for `list_all_memories`, tag suggestions, and search-history logging. The system is described as three databases but reads from two — and those two run the *same* query.

---

## 2. Defects found, ranked by impact on LLM answer quality

### D1 — Graph-sourced memories arrive at the LLM as empty shells (Critical)

Neo4j `Memory` nodes store **lowercase** scalar properties and hold category/tags/tools/projects only as *relationships*, never as node properties ([graphService.ts:96-142](../../src/services/graphService.ts#L96-L142)):

```cypher
SET m.content = $content, m.description = $description,
    m.lastUpdated = $lastUpdated, m.created = ...
MERGE (m)-[:TAGGED_WITH]->(t)   // tags live on the edge, not the node
```

`getMemoriesByKeywordAndSimilarity()` returns `node.properties` spread and cast `as MemoryWithId` ([graphService.ts:298](../../src/services/graphService.ts#L298)) — a cast TypeScript cannot check. The aggregator then packs memories using **PascalCase** accessors ([memoryPostSearchAggregator.ts:377](../../src/services/memoryPostSearchAggregator.ts#L377)):

```ts
`ID: ${m.id}\nCategory: ${m.Category}\nTags: ${(m.Tags || []).join(', ')}\n` +
`LastUpdated: ${m.LastUpdated}\nDescription: ${desc}\nContent: ${content}`
```

For any memory Qdrant did **not** also return, every one of `Category`, `Tags`, `LastUpdated`, `Description`, `Content` is `undefined`. The LLM literally receives:

```
ID: 8f3a...
Category: undefined
Tags:
LastUpdated: undefined
Description:
Content:
---
```

Consequences compound: the aggregation prompt's core instructions — "prefer more recent (`LastUpdated`) over stale", "prefix each bullet with a type label `[Preference]`…", and the entire `cluster-category` / `cluster-tag` strategy — are **inoperable** on graph-only rows. Those rows also sink into the `'Uncategorized'` bucket in `summarizeMemoriesByCategory` and vanish entirely from `summarizeMemoriesByTag`. The unique contribution of the second source is destroyed at the boundary.

**Fix (two layers, both needed):**

1. **Projection layer.** Replace the blind cast with an explicit mapper and change the Cypher to collect the relationships it needs:
   ```cypher
   CALL db.index.vector.queryNodes('memory_embedding_index', $topK, $queryVector)
   YIELD node, score
   OPTIONAL MATCH (node)-[:TAGGED_WITH]->(t:Tag)
   OPTIONAL MATCH (node)-[:IN_CATEGORY]->(c:Category)
   OPTIONAL MATCH (node)-[:USES_TOOL]->(tool:Tool)
   OPTIONAL MATCH (node)-[:RELATES_TO_PROJECT]->(p:Project)
   RETURN node {.id, .content, .description, .lastUpdated, .created} AS memory,
          collect(DISTINCT t.name) AS tags, head(collect(c.name)) AS category,
          collect(DISTINCT tool.name) AS tools, collect(DISTINCT p.name) AS projects,
          score
   ```
   The `node {.id, .content, …}` map projection also solves D2.
2. **Defensive serialization.** Make the packing function total, so no future source-shape drift can silently emit `undefined`. See §3.

### D2 — 768-float embeddings are shipped to the LLM in the MCP payload (Critical)

`vectorSearch` returns `r.get('memory').properties`, which **includes `m.embedding`**. That object is spread into the result, survives the merge, lands in `topMemories`, and is emitted by `JSON.stringify(result, null, 2)` at [memoryMcpServer.ts:66](../../src/app/memoryMcpServer.ts#L66).

Rough cost: a 768-dim vector at ~19 chars per pretty-printed float is roughly **15 KB / 4–5K tokens per graph-sourced memory**. With `AGGREGATION_MAX_MEMORIES = 25`, a single `search_memories` call can emit six figures of tokens of pure noise — crowding out or blowing past the consumer's context, and pushing the clean Qdrant-sourced rows out of attention.

**Fix:** the map projection in D1 excludes `embedding` at the database boundary. Additionally, add an explicit response-shaping step before the MCP return (§4) so nothing unexpected can ever reach the wire.

### D3 — Cluster summarizers are driven by copy-pasted, wrong system prompts (Critical)

[memoryPostSearchAggregator.ts:481](../../src/services/memoryPostSearchAggregator.ts#L481) — category clustering:
```ts
{ role: 'system', content: 'You classify content into a single category. Output only the category.' }
```
[memoryPostSearchAggregator.ts:576](../../src/services/memoryPostSearchAggregator.ts#L576) — tag clustering:
```ts
{ role: 'system', content: 'Output only comma-separated tags, nothing else.' }
```

Both are ingestion-pipeline prompts pasted into the summarization path. The user prompt (the carefully written `aggregation_summary.txt`) asks for a narrative or a `- `-prefixed bullet list; the system prompt orders the model to emit a bare category name or a comma list. Small local models resolve that conflict by obeying the system message, so the bullet parser `filter(l => l.startsWith('- '))` matches nothing and `bullets` comes back `[]`.

Net effect: **`cluster-category`, `cluster-tag`, and `hybrid` return empty or junk cluster summaries** — while the MCP tool description tells the agent to *"Prefer hybrid strategy for best results."* The advertised best path is the broken one.

**Fix:** use one summarization system prompt across all three paths, matched to the task:
```ts
const SUMMARIZER_SYSTEM = 'You are a memory aggregation engine. Follow the output contract in the user message exactly. Output only the summary.';
```
Extract the LLM call into a single private `runSummaryPrompt(packed, mode, clusterType, clusterKey)` so there is exactly one place this can drift.

### D4 — Cross-source agreement *demotes* a memory (High)

```ts
existing.mergedScore = (existing.vectorScore! * 0.5) + (normalizedGraphScore * 0.5);
```

A vector-only memory keeps `mergedScore = vectorScore`. A memory found by **both** sources gets the mean. So vector `0.75` + graph `0.72` becomes `0.735`, ranking *below* a vector-only `0.75`. The one signal a multi-source system exists to produce — corroboration — is penalized, and the memory can be filtered out by a `scoreThreshold` it would have passed on its vector score alone.

The normalization is also inert: `graphScore / Math.max(maxGraphScore, 1)`. Graph scores are cosine (0–1), so `maxGraphScore < 1`, the divisor clamps to `1`, and normalization is a no-op. The code comments describing graph scores as "typically 1–20 range" and "relationship strength (count of shared tags x2)" document a function that is not the one being called.

**Fix:** adopt Reciprocal Rank Fusion, per [03-RERANKING-AND-MERGING.md](../rag-improvement/03-RERANKING-AND-MERGING.md) / roadmap P0-1. RRF is distribution-agnostic and additive, so appearing in both lists strictly increases rank. Critically for this plan: **RRF scores are not similarities**, so the current `scoreThreshold = 0.6` must not be applied to them. Apply the threshold to the *vector* score before fusion, then fuse.

### D5 — The LLM is never told which source found a memory, or why (High)

`MergedResult` carries `sources: ('vector'|'graph')[]`, `vectorScore`, and `graphScore`, and `GraphResult` carries `relationshipPath`. All four are **discarded** in the final `.map()` ([memoryPostSearchAggregator.ts:196](../../src/services/memoryPostSearchAggregator.ts#L196)), which returns `{...m.memory, score: m.mergedScore}`. Only an opaque blended float survives.

This is the largest missed opportunity for the consuming LLM. Provenance is what lets a downstream model calibrate trust: "found by both semantic and relational search" is a materially stronger claim than "ranked 9th by cosine" — and the aggregation prompt already asks the model to explain *"why specific memories are relevant"* while withholding the only data that would let it.

**Fix:** widen the returned type and thread it through to both the prompt and the MCP payload:
```ts
export interface RetrievedMemory extends MemoryWithId {
    retrieval: {
        sources: ('vector' | 'graph')[];
        vectorScore?: number;
        vectorRank?: number;
        graphScore?: number;
        graphRank?: number;
        fusedScore: number;
        relationshipPath?: string;   // e.g. "shared_tags:memory,project"
    };
}
```

### D6 — The category filter is applied to one source and not the other (Medium)

Qdrant honors `category` via a payload filter ([vectorService.ts:110](../../src/services/vectorService.ts#L110)); the Neo4j call takes only `(queryVector, limit)` and cannot filter. A `search_memories(query, category='Preference')` call therefore merges in graph rows of *any* category. Because those rows carry no `Category` field at all (D1), the leak is invisible to both the aggregator and the LLM — the response silently violates the filter the agent asked for.

**Fix:** add an optional category parameter to the graph search and apply it as `MATCH (node)-[:IN_CATEGORY]->(c:Category {name: $category})` in the D1 projection.

### D7 — `format: 'both'` silently returns half the contract (Medium)

`summarizeMemoriesLinear` branches `if (mode === 'bullets') {…} else { narrative }` ([memoryPostSearchAggregator.ts:397](../../src/services/memoryPostSearchAggregator.ts#L397)). For `mode: 'both'`, the template instructs the model to emit a paragraph, a blank line, then the bullet list — and the code files the entire response into `aggregateNarrative`, leaving `aggregateBullets` undefined. A consumer reading the structured `aggregateBullets` field gets nothing while the data sits unparsed in the adjacent field.

**Fix:** parse both from one response — bullets are the `- `-prefixed lines, narrative is the leading text before the first bullet.

### D8 — Two divergent copies of the merge algorithm; the tested one is dead (Medium)

[resultMerge.ts](../../src/utils/resultMerge.ts) exists as the "extracted for testability" pure function and has unit coverage in `src/__tests__/unit/resultMerge.test.ts`. The production path calls the **private duplicate** inside `MemoryPostSearchAggregator`. The tests validate code that never runs, so the merge — the highest-leverage logic in the system — is effectively untested, and the two copies are free to drift.

**Fix:** delete the private method; have the aggregator call the pure function. Do this *first*, so D4 and D5 are implemented once, under test.

### D9 — Configured overflow knobs are wired but unimplemented (Low)

`AGGREGATION_OVERFLOW_THRESHOLD_CHARS = 15000` and `AGGREGATION_CONDENSATION_BATCH_SIZE = 1` are defined in config, documented in `.env.example`, passed through the constructor, and assigned to fields — then **never read**. `aggregation-refinement-plan.md` specifies the condensation behavior they were meant to drive.

With `MAX_MEMORIES=25 × CONTENT_MAX_CHARS=800` the packed block can reach ~20K chars, over the configured ceiling, with no guardrail. Either implement the pre-pass or delete the knobs; leaving them is a trap for the next reader.

### D10 — A markdown report is written to disk on every search (Low)

`searchAndSummarizeForMcp` defaults `generateReport = true` ([memoryRAGSystem.ts:487](../../src/services/memoryRAGSystem.ts#L487)) and the MCP path never overrides it, so every agent query does synchronous report I/O plus a `SqlService.addSearchHistory` write in the request path. Make it opt-in for MCP (`generateReport: false`), keep it on for evaluation scripts.

---

## 3. Make the serialized memory block source-agnostic

The packing string is duplicated in three places (linear, by-category, by-tag) with slight variations. Consolidate into one function and make it **total** — every field either has a value or is omitted, never printed as `undefined`:

```ts
private packMemory(m: RetrievedMemory): string {
    const lines = [`ID: ${m.id}`];
    if (m.Category) lines.push(`Category: ${m.Category}`);
    if (m.Tags?.length) lines.push(`Tags: ${m.Tags.join(', ')}`);
    if (m.Tools?.length) lines.push(`Tools: ${m.Tools.join(', ')}`);
    if (m.Projects?.length) lines.push(`Projects: ${m.Projects.join(', ')}`);
    if (m.LastUpdated) lines.push(`LastUpdated: ${m.LastUpdated}`);
    lines.push(`Retrieval: ${m.retrieval.sources.join('+')} (fused ${m.retrieval.fusedScore.toFixed(3)})`);
    if (m.retrieval.relationshipPath) lines.push(`RelatedVia: ${m.retrieval.relationshipPath}`);
    if (m.Description) lines.push(`Description: ${m.Description}`);
    if (m.Content) lines.push(`Content: ${this.truncate(m.Content)}`);
    return lines.join('\n') + '\n---';
}
```

Two behavioral gains beyond tidiness: `Tools` and `Projects` reach the LLM for the first time (they are stored in Qdrant's payload and in the graph, and never serialized — `aggregation-refinement-plan.md` called for this and it was not carried through), and the `Retrieval` line gives the model the D5 provenance in the same place it reads the fact.

Update `aggregation_summary.txt` in step with the new block: document the `Retrieval` and `RelatedVia` lines, and add a rule — *"when a memory was found by both sources, treat it as more strongly corroborated; when found only via a relationship path, say what it is connected to rather than asserting direct relevance."*

---

## 4. Shape the MCP response deliberately

Today the entire internal result object is `JSON.stringify`'d to the MCP consumer. It should be an explicit, versioned contract instead — nothing reaches the wire by accident:

```jsonc
{
  "query": "...",
  "summary": { "narrative": "...", "bullets": ["- [Preference] ..."] },
  "clusters": [ { "key": "Preference", "type": "category", "bullets": ["..."] } ],
  "memories": [                      // no embeddings, no undefined fields
    { "id": "...", "category": "Preference", "tags": ["..."], "tools": ["..."],
      "lastUpdated": "...", "description": "...", "content": "...",
      "retrieval": { "sources": ["vector", "graph"], "fusedScore": 0.031,
                     "vectorRank": 2, "graphRank": 5 } }
  ],
  "retrievalReport": {               // lets the agent judge coverage
    "vectorCount": 12, "graphCount": 10, "mergedCount": 15,
    "overlapCount": 7, "filtersApplied": { "category": "Preference" },
    "truncated": true, "durationMs": 840
  }
}
```

`retrievalReport` deserves emphasis: it is how a downstream agent decides whether to **re-query**. An `overlapCount` near zero on a well-formed query signals that the two sources disagree and coverage may be thin; `truncated: true` tells the model its view is partial — exactly what the prompt's "results may not be exhaustive" instruction tries to convey in prose, but as a machine-readable flag.

Also emit the summary as the MCP `text` content and the structured object as `structuredContent`, rather than dumping identical pretty-printed JSON into both.

---

## 5. Give SQLite a retrieval role

SQLite currently contributes nothing to any answer. It holds the canonical row, `Status`, `Deleted`, `Created`, `UserReviewed`, `IngestionBatchId`, and the `MemoryDatabaseRelations` cross-walk — all *quality signals the other two stores do not have*. Three uses, in increasing ambition:

1. **Post-merge integrity filter (do this one).** After fusion, look up the merged IDs in `Memories` and drop rows where `Deleted = 1` or `Status` is not stored/reviewed. Qdrant and Neo4j have no soft-delete concept, so **a soft-deleted memory is still fully retrievable today** — a correctness bug the user experiences as "I deleted that, why does it keep coming back." One indexed `WHERE ID IN (...)` query.
2. **Trust weighting.** Promote `UserReviewed = 'human-confirmed'` rows over `'auto'` in the fused ranking, and surface the flag in the serialized block so the LLM can weigh a confirmed preference above an inferred one.
3. **Structured-query lane.** For queries that are relational rather than semantic ("what did I save last week", "everything from batch X"), run a SQL lane and fuse it as a third ranked list. See [04-QUERY-ANALYSIS.md](../rag-improvement/04-QUERY-ANALYSIS.md) for routing.

---

## 6. Sequencing

Ordered so each step is verifiable and nothing is implemented twice.

| # | Change | Defects | Effort |
|---|---|---|---|
| 1 | Consolidate merge onto `utils/resultMerge.ts`; delete the private duplicate | D8 | S |
| 2 | Fix the three summarizer system prompts; extract one `runSummaryPrompt` | D3 | S |
| 3 | Graph map projection: correct casing, tags/category/tools/projects, drop `embedding`, optional category filter | D1, D2, D6 | M |
| 4 | Single total `packMemory()`; add Tools/Projects/Retrieval lines; update `aggregation_summary.txt` | D1, D5 | M |
| 5 | RRF fusion + `RetrievedMemory.retrieval` provenance; move threshold to pre-fusion vector score | D4, D5 | M |
| 6 | Explicit MCP response contract + `retrievalReport`; `generateReport: false` on the MCP path | D2, D10 | M |
| 7 | Parse narrative *and* bullets for `format: 'both'` | D7 | S |
| 8 | SQLite integrity filter on merged IDs (soft-delete / status) | §5.1 | S |
| 9 | Implement or delete the overflow/condensation knobs | D9 | M |
| 10 | Graph *traversal* lane replacing the duplicate cosine search | roadmap P0-2 | L |

Steps 1–5 are the quality core. Step 10 is where the graph starts earning its place — but it is deliberately last: **traversal results are worthless until step 3 makes graph rows carry their metadata**, and premature traversal work would only add more empty shells to the prompt.

---

## 7. How to tell it worked

The repo already has an evaluation harness (`src/scripts/evaluateSemanticQueries.ts`, `baseEvaluator.ts`) and a search-history table capturing per-source IDs and scores. Use them:

- **Assert no `undefined` reaches the prompt.** A unit test on `packMemory()` with a graph-shaped input — this is the D1 regression, and it is cheap to lock down.
- **Payload size.** Assert the MCP response for a 25-memory result contains no array longer than ~50 numbers. Catches any future embedding leak.
- **Overlap rate.** Log `overlapCount / mergedCount` per query in search history. Today it measures whether two identical cosine searches agree (near 1.0, uninformative). After step 10 it becomes the real measure of whether the graph contributes anything the vector store missed.
- **Cluster non-emptiness.** Run each strategy over the seed set and assert `clusterSummaries` are non-empty with parsed bullets — the direct check on D3.
- **Soft-delete leakage.** Delete a seeded memory, re-query, assert it is absent.

Record before/after on a fixed query set so the ranking changes in step 5 are measured rather than assumed.
