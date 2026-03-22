# Re-Ranking and Result Merging

> **Related docs**: [02-GRAPH-DB-IMPROVEMENTS.md](02-GRAPH-DB-IMPROVEMENTS.md) · [04-QUERY-ANALYSIS.md](04-QUERY-ANALYSIS.md) · [07-SCALING-STRATEGIES.md](07-SCALING-STRATEGIES.md)

## Current State — Analysis of Existing Merge Logic

### The Merge Algorithm

Located in `memoryPostSearchAggregator.ts` `mergeVectorAndGraphResults()`:

```
Input:
  vectorResults: MemoryWithId[]      — from Qdrant, scores 0–1
  graphResults: GraphResult[]        — from Neo4j, scores 1–20+
  limit: number                      — max results to return
  scoreThreshold: number             — minimum merged score (default 0.7)

Algorithm:
  1. Add all vector results to a map (keyed by memory ID)
  2. Find maxGraphScore = max(all graph scores)
  3. For each graph result:
     - If already in map: mergedScore = (vectorScore × 0.5) + (graphScore/maxGraphScore × 0.5)
     - If new: mergedScore = graphScore / maxGraphScore
  4. Filter by scoreThreshold, sort by mergedScore, return top limit
```

### Problems with This Approach

**Problem 1: Score averaging loses rank information**

If vector search returns memories [A=0.92, B=0.88, C=0.76] and graph returns [B=10, D=8, E=5], the merge uses raw scores. But a score of 0.92 in one search doesn't mean the same thing as a normalized 0.80 in another. Rank position (1st, 2nd, 3rd) is often more meaningful than the raw score.

**Problem 2: Max-normalization is unstable**

Graph scores are normalized by dividing by the maximum graph score. If the max score is an outlier (one memory happens to share 10 tags), it compresses all other scores. If the max is low (best graph match shares 2 tags), normalization inflates weak connections.

**Problem 3: 50-50 weighting is arbitrary**

There's no reason to weight vector and graph equally for every query. A factual query ("What's my preferred IDE?") should weight vector higher. A structural query ("What do I know about my MemoryApi project?") should weight graph higher.

**Problem 4: The 0.7 threshold is aggressive**

Graph-only results get a `mergedScore = graphScore / maxGraphScore`. Unless a memory IS the maximum graph scorer (score 1.0), its merged score will be below 1.0 — and with a 0.7 threshold, only the top ~30% of graph-only results survive. This defeats the purpose of graph search providing diverse results.

**Problem 5: No second-stage refinement**

Results go directly from merge to LLM summarization. There's no opportunity to re-assess relevance relative to the original query using a more expensive but accurate method.

---

## Concept: Two-Stage Retrieval

The key mental model for improving RAG accuracy is **two-stage retrieval**:

```
Stage 1: RECALL — Cast a wide net, retrieve more candidates than needed
  • Lower thresholds, higher limits
  • Multiple search modalities (vector + graph + fulltext)
  • Priority: don't miss relevant results

Stage 2: PRECISION — Re-rank and filter to the most relevant
  • Score candidates against the original query
  • Use more expensive/accurate scoring methods
  • Priority: surface only what's truly relevant
```

**Why two stages?** Because the goals of recall (find everything potentially relevant) and precision (return only what matters) are fundamentally in tension. A single stage must compromise between them. Two stages let each excel at its purpose.

---

## Improvement 1: Reciprocal Rank Fusion (RRF)

### What Is RRF?

RRF is a rank-based fusion method that combines multiple ranked lists without needing to normalize scores. Instead of averaging scores, it uses the **rank position** of each result in each list.

### The Formula

```
RRF_score(memory) = Σ  1 / (k + rank_i(memory))
                    i∈lists
```

Where:
- `k` is a constant (typically 60) that controls how much rank position matters
- `rank_i(memory)` is the position (1-indexed) of the memory in list `i`
- If a memory doesn't appear in a list, it's excluded from that list's contribution

### Why RRF Is Better Than Score Averaging

| Aspect | Score Averaging | RRF |
|--------|----------------|-----|
| Requires comparable score ranges | Yes — must normalize | No — uses rank only |
| Sensitive to outlier scores | Yes — one high score dominates | No — rank is bounded |
| Handles different modalities | Poorly — 0.9 vector ≠ 0.9 graph | Well — rank 1 = rank 1 |
| Computational cost | O(n) | O(n) |
| Research backing | Limited | Widely validated in IR research |

### Example: RRF vs. Current Approach

Given vector results [A=0.92, B=0.88, C=0.76, F=0.55] and graph results [B=10, D=8, E=5]:

**Current approach (score averaging):**
```
A: vectorOnly  → mergedScore = 0.92
B: both        → mergedScore = (0.88×0.5) + (10/10×0.5) = 0.94
C: vectorOnly  → mergedScore = 0.76
D: graphOnly   → mergedScore = 8/10 = 0.80
E: graphOnly   → mergedScore = 5/10 = 0.50  ← filtered at 0.7 threshold
F: vectorOnly  → mergedScore = 0.55  ← filtered at 0.7 threshold
```

**RRF (k=60):**
```
A: vector rank 1          → 1/(60+1)                    = 0.01639
B: vector rank 2, graph 1 → 1/(60+2) + 1/(60+1)        = 0.03252
D: graph rank 2            → 1/(60+2)                    = 0.01613
C: vector rank 3          → 1/(60+3)                    = 0.01587
E: graph rank 3            → 1/(60+3)                    = 0.01587
F: vector rank 4          → 1/(60+4)                    = 0.01563

Sorted: B(0.033) > A(0.016) > D(0.016) > C(0.016) ≈ E(0.016) > F(0.016)
```

**Key difference**: E (graph-only, rank 3) is now ranked alongside C (vector-only, rank 3) — they contribute equally based on rank position. In the current system, E would be filtered out at the 0.7 threshold.

### Implementation in `memoryPostSearchAggregator.ts`

Replace the body of `mergeVectorAndGraphResults()` with RRF logic:

```
New algorithm:
  1. Assign ranks to vector results (1-indexed by score descending)
  2. Assign ranks to graph results (1-indexed by score descending)
  3. For each unique memory across both lists:
     rrfScore = 0
     if in vectorResults: rrfScore += 1 / (k + vectorRank)
     if in graphResults:  rrfScore += 1 / (k + graphRank)
  4. Sort by rrfScore descending
  5. Apply a minimum-contributions filter (optional: require appearing in at least 1 list)
  6. Return top limit results
```

**Extending to three modalities** (vector + graph + fulltext):
```
  rrfScore = 1/(k+vectorRank) + 1/(k+graphRank) + 1/(k+fulltextRank)
```

RRF naturally handles any number of ranked lists. Adding fulltext search (see [02-GRAPH-DB-IMPROVEMENTS.md](02-GRAPH-DB-IMPROVEMENTS.md)) requires no changes to the fusion logic — just add the third list.

**Configuration**: The `k` parameter controls how much early ranks dominate.
- `k=60` (default): Moderate — top ranks matter but results in the 5–10 range still contribute
- `k=1`: Aggressive — top-1 result in each list dominates
- `k=1000`: Flat — rank matters very little, basically a count of how many lists include the result

Start with `k=60` (the original RRF paper's recommendation).

### Threshold Adjustment

With RRF, raw scores are in a different range (typically 0.001–0.035). The threshold must change:
- **Option A**: Remove the threshold entirely and rely on the result `limit` to cap output
- **Option B**: Set a very low threshold (e.g., 0.005) that only filters memories appearing in one list with a very low rank
- **Recommendation**: Option A — let the limit control output size, don't filter by score

---

## Improvement 2: Lower the Score Threshold

Even before implementing RRF, lowering the current `scoreThreshold` from 0.7 to a more permissive value improves recall.

**Why 0.7 is too aggressive:**
- Graph-only results (not in vector results) get `score = graphScore / maxGraphScore`, always ≤ 1.0. Only the top graph result reaches 1.0, and with 0.7 threshold, only the highest ~30% of graph-only results survive.
- At small collection sizes (< 100 memories), even vector scores are distributed more widely. A relevant memory might score 0.65 if the collection has closely related content.

**Recommended threshold by knowledge base size:**

| Size | Threshold | Rationale |
|------|-----------|-----------|
| < 100 | 0.3–0.4 | Few memories — cast a wide net |
| 100–1,000 | 0.4–0.5 | Moderate filtering |
| 1,000–10,000 | 0.5–0.6 | Need more selective filtering |
| > 10,000 | 0.6+ | Dense neighborhoods, precision matters more |

**Implementation**: Change the default in `memoryPostSearchAggregator.ts`:
```typescript
const scoreThreshold = options.scoreThreshold ?? 0.5; // was 0.7
```

This is a one-line change with significant impact on recall, especially for graph-contributed results.

---

## Improvement 3: Cross-Encoder Re-Ranking

### What Is Cross-Encoder Re-Ranking?

A **cross-encoder** takes a (query, document) pair and produces a relevance score. Unlike embeddings (which encode query and document independently), a cross-encoder **attends to both simultaneously**, making it much more accurate at determining relevance.

```
Bi-encoder (embeddings):   encode(query) · encode(document)  → fast, approximate
Cross-encoder (re-ranker):  model(query + document)           → slow, precise
```

**Why it matters**: At the re-ranking stage, you're evaluating 10–30 candidates, not 10,000. The per-candidate cost is acceptable for a small set.

### Using an LLM as a Cross-Encoder

Since the system already has LLM access via LMApi, the simplest cross-encoder approach is to ask the LLM to score relevance:

```
Prompt:
"Rate how relevant this memory is to the query on a scale of 1-10.

Query: {query}
Memory: {memory.Content}

Output only the number."
```

**Cost**: One LLM call per candidate. For 20 candidates, that's 20 calls — but each is very short (< 50 tokens output), so total latency is ~2–5 seconds with batching.

**When to apply**: Only when the first-stage retrieval returns enough candidates to warrant re-ranking:
- < 5 candidates: Skip re-ranking (not enough diversity to re-order)
- 5–20 candidates: Re-rank all
- > 20 candidates: Re-rank top 20 only

### Lighter Alternative: LLM-as-Filter

Instead of scoring every candidate, ask the LLM to classify each as relevant/not-relevant:

```
Prompt:
"Is this memory relevant to the query? Answer YES or NO.

Query: {query}
Memory: {memory.Content}"
```

This is cheaper (binary output) and can be parallelized. Filter out NO responses, keep YES responses in their original merge order.

### Implementation Approach

Add a new step between merge and aggregation in `memoryPostSearchAggregator.ts`:

```
Current flow:
  merge → filter threshold → sort → limit → aggregate

New flow:
  merge → sort → generous limit (2× needed) → re-rank → final limit → aggregate
```

**Files to modify:**
- `memoryPostSearchAggregator.ts`: Add `rerankResults(query, candidates)` method between merge and aggregation
- `modelClients.ts`: Add a re-ranking prompt helper (or use the existing `respond()` interface)
- `configService.ts`: Add `RERANK_ENABLED` and `RERANK_THRESHOLD` env vars

---

## Improvement 4: Dynamic Merge Weighting

### Based on Query Type

Different query types benefit from different vector/graph weightings (see [04-QUERY-ANALYSIS.md](04-QUERY-ANALYSIS.md)):

| Query Type | Vector Weight | Graph Weight | Rationale |
|-----------|--------------|-------------|-----------|
| Fact retrieval | 0.7 | 0.3 | Specific facts live in semantic space |
| Broad exploration | 0.4 | 0.6 | Graph discovers diverse connected memories |
| Code lookup | 0.5 | 0.5 | Balance semantic similarity with structural connections |
| Relational | 0.3 | 0.7 | Structure matters most for "what relates to X?" |

**Implementation with RRF**: Instead of changing weights, adjust the `k` parameter per query type, or multiply RRF contributions by a weight:

```
rrfScore = vectorWeight × 1/(k+vectorRank) + graphWeight × 1/(k+graphRank)
```

### Based on Result Overlap

If vector and graph return mostly the same memories, graph isn't adding diversity — weight vector higher. If they return mostly different memories, graph is contributing unique finds — weight graph higher.

```
overlap = count(memories in both vector AND graph results) / count(all unique memories)

If overlap > 0.7:  vectorWeight = 0.7, graphWeight = 0.3  (similar results, trust vector)
If overlap < 0.3:  vectorWeight = 0.4, graphWeight = 0.6  (diverse results, value graph's unique finds)
Else:              vectorWeight = 0.5, graphWeight = 0.5  (balanced)
```

This is a simple heuristic that adapts per query without LLM overhead.

---

## Improvement 5: Handling Large Result Sets

### The Scaling Problem

At small scale (< 100 memories), the search pipeline returns 5–20 candidates, and sending all of them to the LLM for summarization works fine. But as the knowledge base grows:

| Knowledge Base | Candidates Returned | Problem |
|---------------|--------------------:|---------|
| 100 memories | 5–15 | No problem — all fit in context |
| 1,000 memories | 15–40 | Some relevant memories may not make the cut |
| 10,000 memories | 40–100+ | Too many for LLM context; diminishing returns |
| 100,000+ memories | 100–500+ | Definitely need multi-stage filtering |

### Result Count-Based Strategy Selection

Currently, the aggregation strategy (linear, cluster-category, cluster-tag, hybrid) is chosen by the caller. Instead, make it adaptive based on how many results the merge produces:

```
Merged result count → Strategy selection:

1–5 results:   Use 'linear' — few enough to summarize directly
6–15 results:  Use 'linear' or caller's choice — still manageable
16–30 results: Switch to 'cluster-category' — group by category for structured summaries
31+ results:   Use 'hybrid' — both linear overview + category/tag clusters
```

**Implementation**: In `searchAndSummarizeForMcp()`, check `mergedResults.length` and override the strategy if needed:

```
// If caller didn't specify a strategy, auto-select
if (!options.strategy) {
    if (mergedResults.length <= 5) strategy = 'linear';
    else if (mergedResults.length <= 15) strategy = 'linear';
    else if (mergedResults.length <= 30) strategy = 'cluster-category';
    else strategy = 'hybrid';
}
```

### Progressive Summarization for Large Result Sets

When results exceed 20–30, a single LLM call can't meaningfully process them all. Use progressive summarization:

```
Step 1: Group results into clusters (by category or tag)
Step 2: Summarize each cluster independently (parallel LLM calls)
Step 3: Feed cluster summaries into a final synthesis prompt
Step 4: Return both cluster summaries and the synthesis
```

This is similar to the existing `cluster-category` strategy, but with an added synthesis step that produces a coherent overall answer.

**Synthesis prompt addition** (to `aggregation_summary.txt`):

```
You are synthesizing multiple cluster summaries into a single coherent response.

Cluster summaries:
{{cluster_summaries}}

Original query: {{query}}

Produce a unified narrative that integrates insights from all clusters,
resolving any contradictions and highlighting the most relevant information
for the query.
```

---

## Improvement 6: Threshold Tuning with Evaluation Data

### Using SearchHistory for Empirical Tuning

The `SearchHistory` table logs every search with vector scores, graph scores, and the resulting summary. This data can answer:

1. **What threshold maximizes result diversity?** — Compare searches with different thresholds and check if lower thresholds surface unique memories that improve summary quality
2. **What weighting produces the best merge?** — The existing `evaluateSemanticQueries.ts` script already compares multiple merge weights (50-50, 70-30, 30-70)
3. **Do graph-only results improve summaries?** — Check if searches where graph contributed unique results have better summaries

### Automated Threshold Recommendations

Build a script that analyzes SearchHistory:

```
For each past search:
  - Count how many results were vector-only, graph-only, or both
  - For each threshold (0.3, 0.4, 0.5, 0.6, 0.7):
    - Simulate: how many results would pass this threshold?
    - How many graph-only results survive?
  - Output: recommended threshold that preserves graph diversity while filtering noise
```

This uses the existing evaluation infrastructure (`baseEvaluator.ts`, `memoryReportService.ts`) and doesn't require user-provided relevance judgments.

---

## Summary: Merge Pipeline Improvements

### Current Pipeline

```
Vector + Graph → Score Normalize → 50-50 Average → Threshold 0.7 → Limit → LLM Summary
```

### Improved Pipeline

```
Vector + Graph + Fulltext
    → RRF Fusion (rank-based, no normalization needed)
    → Generous limit (2× final need)
    → [Optional] LLM Re-rank (cross-encoder or filter)
    → Final limit
    → Adaptive aggregation strategy (based on result count)
    → LLM Summary (with progressive summarization if needed)
    → Log to SearchHistory (for evaluation-driven tuning)
```

### Implementation Priority

| Change | Complexity | Impact | When |
|--------|-----------|--------|------|
| Lower threshold to 0.5 | Trivial | Medium | P0 — now |
| Replace score average with RRF | Low | High | P0 — now |
| Add fulltext as third modality | Low | Medium | P0 — now |
| Dynamic strategy selection by result count | Low | Medium | P0 — now |
| Dynamic weight by query type | Medium | Medium | P1 — next |
| Dynamic weight by overlap ratio | Low | Low | P1 — next |
| LLM-based re-ranking | Medium | High | P2 — later |
| Progressive summarization | Medium | Medium | P2 — later |
| Empirical threshold tuning | Medium | Medium | P2 — later |

See [08-IMPROVEMENT-ROADMAP.md](08-IMPROVEMENT-ROADMAP.md) for the full prioritized plan.
