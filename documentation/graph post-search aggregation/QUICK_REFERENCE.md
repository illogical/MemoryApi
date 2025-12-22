# Quick Reference: Graph + Vector Merging

## TL;DR

The memory search system now automatically merges vector (semantic) and graph (relationship) database results to provide richer context to LLMs.

## Key Concepts

### Vector Search (Semantic)
- **What it does**: Finds memories that are conceptually similar to the query
- **Example**: Query "project management" → finds "team coordination", "leadership"
- **Score range**: 0-1 (higher = more semantically similar)
- **Executes via**: VectorService (Qdrant)

### Graph Search (Relationships)
- **What it does**: Finds memories connected through tags, categories, and relationships
- **Example**: Query about "Q4-2024" → finds all memories tagged with "Q4-2024" regardless of semantic similarity
- **Score range**: Typically 1-20+ (based on shared connection count)
- **Executes via**: GraphService (Neo4j)

### Merged Results
- **Deduplication**: Same memory appears only once, with combined scores from both modalities
- **Score Combination**: `merged = (vectorScore × 0.5) + (normalizedGraphScore × 0.5)`
- **Ranking**: Results sorted by merged score (highest first)
- **Benefit**: LLM gets both semantic AND structural relevance

## Code Flow (Simplified)

```
searchAndSummarizeForMcp(query)
    ↓
Generate embedding once
    ↓
searchVectorAndGraphParallel(embedding)
    ├─ Vector search → [A(0.9), B(0.7), C(0.5)]
    └─ Graph search  → [B(8), D(10), E(3)]
    ↓
mergeVectorAndGraphResults()
    → Dedup: {A:0.9, B:merged(0.9,0.8), C:0.5, D:0.8, E:0.3}
    → Sort:  [B:0.9, A:0.9, D:0.8, C:0.5, E:0.3]
    ↓
aggregateMemories() → summarize with LLM
    ↓
Return: {topMemories, narrative, bullets, vectorCount, graphCount}
```

## Merging Formula Explained

### Step 1: Normalize Graph Score
```
Graph scores vary (often 2-20 based on relationship count)
Need to map to 0-1 range like vector scores

normalizedGraphScore = graphScore / maxGraphScore
```

### Step 2: Combine
```
Give equal weight to both signals

mergedScore = (vectorScore × 0.5) + (normalizedGraphScore × 0.5)

For graph-only: mergedScore = normalizedGraphScore
For vector-only: mergedScore = vectorScore
```

### Example
```
Memory A: vec=0.92, graph=10/10 → merged = (0.92×0.5)+(1.0×0.5) = 0.96
Memory B: vec=0.65, graph=none → merged = 0.65 (vector only)
Memory C: vec=none, graph=5/10  → merged = 0.5 (graph only)
```

## When Each Modality Excels

### Vector Search is Better For:
- Conceptual similarity ("tell me about X")
- Topic exploration ("what relates to...?")
- Semantic understanding
- Open-ended queries

### Graph Search is Better For:
- Entity-based lookups ("memories about Project Q4")
- Tag-based filtering ("all memories with tag:urgent")
- Relationship navigation
- Structured queries

### Combined Search is Best For:
- Everything (catches both angles)
- Ensures diverse context for LLM
- Reduces hallucination through validation

## SQL Logging

The search history now captures both modalities:

```sql
SELECT * FROM SearchHistory WHERE SearchId = 123

VectorResults:
  [{"id": "abc123", "score": 0.92}]

GraphResults:
  [{"id": "abc123", "score": 10, "relationshipPath": "shared_tags:Q4-planning,important"}]

ResultCount: 1 (deduplicated - both found same memory)
```

This enables future analysis and optimization.

## Configuration

### Adjust the Weight Ratio

In `memoryPostSearchAggregator.ts`, line ~151:

```typescript
// Default: 50-50
mergedScore = (vectorScore × 0.5) + (normalizedGraphScore × 0.5);

// Favor semantic: 70-30
mergedScore = (vectorScore × 0.7) + (normalizedGraphScore × 0.3);

// Favor relationships: 30-70
mergedScore = (vectorScore × 0.3) + (normalizedGraphScore × 0.7);
```

### Adjust Result Limits

In `memoryRAGSystem.ts`, line ~357:

```typescript
// Fetch 2x desired limit from each modality (before merging)
const searchLimit = (options?.limit ?? this.MAX_MEMORIES_FOR_SUMMARY) * 2;
```

Increase multiplier for more diversity, decrease for speed.

## Common Questions

### Q: Will the same memory appear twice?
A: No. The merge algorithm deduplicates by memory ID and combines scores.

### Q: What if vector and graph disagree on relevance?
A: The 50-50 weighting balances both signals. Adjust weights if needed.

### Q: What's the performance impact?
A: Parallel execution means vector + graph time ≈ max(vector_time, graph_time), not sum.

### Q: Can I disable graph search?
A: Yes, pass empty `graphResults: []` array to `searchAndSummarizeForMcp()`.

### Q: How are graph scores calculated?
A: Shared tags count × 2, shared category × 1 (see `GraphService.getRelatedMemories()`).

## Files Modified

| File | Change |
|------|--------|
| memoryPostSearchAggregator.ts | Added merging logic, updated method signatures |
| ragOrchestrator.ts | Added parallel dual-search method |
| graphService.ts | Added vector search wrapper |
| memoryRAGSystem.ts | Updated to use dual search |
| sqlService.ts | No changes (already supports both results) |

## Testing Quick Start

```typescript
// In your test file:
const result = await ragSystem.searchAndSummarizeForMcp(
    "test query",
    { limit: 5, scoreThreshold: 0.5, strategy: 'hybrid' }
);

// Verify results
expect(result.vectorResultCount).toBeGreaterThan(0);
expect(result.graphResultCount).toBeGreaterThan(0);
expect(result.topMemories.length).toBeLessThanOrEqual(5);

// All memories should have score >= 0.5
result.topMemories.forEach(m => {
    expect(m.score).toBeGreaterThanOrEqual(0.5);
});
```

## Next Steps

1. **Test**: Run existing queries and verify dual results
2. **Monitor**: Check SQL SearchHistory for vector vs graph overlap
3. **Tune**: Adjust weights based on your domain needs
4. **Feedback**: Use user feedback to further optimize weights
5. **Enhance**: Consider ML-based weight learning from feedback

## Documentation

- **Detailed Guide**: See `GRAPH_VECTOR_MERGING_GUIDE.md`
- **Implementation Details**: See `IMPLEMENTATION_SUMMARY.md`
- **Code Comments**: Search for "MERGING STRATEGY" in memoryPostSearchAggregator.ts

## Support

The merging algorithm is self-documenting with detailed comments in the code. Look for:
- `mergeVectorAndGraphResults()` - deduplication logic
- `searchAndSummarizeForMcp()` docstring - full explanation
- Inline comments with score calculations
