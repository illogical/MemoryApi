# Graph & Vector Results Merging for RAG/MCP Context

## Overview

This document explains how the Memory API now integrates graph database results with vector search results to provide superior context for LLM-based decision-making in MCP (Model Context Protocol) tool calls.

## Key Changes

### 1. **memoryPostSearchAggregator.ts** - Enhanced Post-Search Aggregation

#### New Interfaces

```typescript
// Graph result structure from Neo4j graph traversal
export interface GraphResult {
    memory: MemoryWithId;
    score: number; // Relationship strength score (count of shared tags x2, shared category x1)
    relationshipPath?: string; // How the memory is related (e.g., "shared_tags:memory,project")
}

// Internal merging structure
interface MergedResult {
    memory: MemoryWithId;
    vectorScore?: number; // Semantic similarity (0-1 range)
    graphScore?: number; // Relationship strength (typically 1-20 range)
    mergedScore: number; // Combined normalized score
    sources: ('vector' | 'graph')[]; // Which modalities found this memory
}
```

#### New Method: `mergeVectorAndGraphResults()`

**Purpose**: Intelligently combines vector and graph search results while eliminating redundancy.

**Algorithm**:
1. Create a deduplicated map of all memories from both sources (keyed by memory ID)
2. For memories found in both modalities:
   - Keep scores from both sources for transparency
   - Normalize graph score (typically 1-20 range) to 0-1 range using max value
   - Calculate: `mergedScore = (vectorScore × 0.5) + (normalizedGraphScore × 0.5)`
3. Filter by score threshold and return top N results sorted by merged score

**Score Normalization Logic**:
```
maxGraphScore = Max(all graph result scores)  // Typically ~10 for relationship counts
normalizedGraphScore = graphScore / max(maxGraphScore, 1)

mergedScore = (vectorScore × 0.5) + (normalizedGraphScore × 0.5)
```

The 50-50 weighting assumes equal importance between semantic and relationship signals. Adjust the weights if your domain requires different emphasis.

#### Enhanced `searchAndSummarizeForMcp()` Method

**New Signature**:
```typescript
async searchAndSummarizeForMcp(
    query: string,
    options?: { /* ... */ },
    searchMemories: (opts) => Promise<MemoryWithId[]>,
    graphResults: GraphResult[] = []  // NEW: Graph search results
): Promise<{ /* ... */, vectorResultCount?: number, graphResultCount?: number }>
```

**Changes**:
- Now accepts graph results as a parameter
- Calls `mergeVectorAndGraphResults()` internally
- Returns counts of both vector and graph results for transparency
- Logs both vector and graph results to SQL SearchHistory

### 2. **ragOrchestrator.ts** - Dual Search Support

#### New Method: `searchVectorAndGraphParallel()`

**Purpose**: Execute vector and graph searches concurrently for efficiency.

```typescript
async searchVectorAndGraphParallel(
    queryEmbedding: number[],
    category?: MemoryCategory,
    limit: number = 5
): Promise<{ vectorResults: MemoryWithId[], graphResults: any[] }>
```

**Benefits**:
- Both searches run in parallel (Promise.all) instead of sequentially
- Graceful fallback if graph search fails (returns empty array, doesn't crash)
- Single embedding generation for both modalities

### 3. **graphService.ts** - Vector Search on Graph

#### New Method: `getMemoriesByKeywordAndSimilarity()`

**Purpose**: Performs vector similarity search using Neo4j's vector index.

```typescript
async getMemoriesByKeywordAndSimilarity(
    queryVector: number[],
    limit: number = 10
): Promise<MemoryWithId[]>
```

This allows Neo4j to find semantically similar memories independently of the vector database, providing an alternative ranking perspective.

### 4. **memoryRAGSystem.ts** - Updated MCP Integration

#### Enhanced `searchAndSummarizeForMcp()` Method

**Updated Flow**:
1. Generate query embedding once
2. Execute vector + graph search in parallel via `orchestrator.searchVectorAndGraphParallel()`
3. Convert graph results to `GraphResult[]` interface
4. Pass both result sets to `postSearchAggregator.searchAndSummarizeForMcp()`
5. Aggregator merges, ranks, and summarizes combined results

**Benefits**:
- Dual search happens automatically - no changes needed in calling code
- Graph results enriched with relationship metadata
- Improved context quality through multi-angle relevance

### 5. **sqlService.ts** - Enhanced Search History Tracking

The `addSearchHistory()` method now properly receives and logs:
- **vectorResults**: Array of vector search matches with scores
- **graphResults**: Array of graph relationship matches with relationship paths
- Both are serialized as JSON in the database

This enables future analysis of:
- Which modality found more relevant results
- Overlap between vector and graph searches
- Relationship path patterns in successful searches

## Why This Matters for RAG/MCP

### Multiple Relevance Signals

When an LLM calls the memory search tool, it now receives diverse perspectives on relevance:

**Vector Search** (Semantic Similarity):
- Captures conceptual meaning
- Good for: "Tell me about project management" → finds "team coordination", "leadership"
- Score: 0-1 (higher = more semantically similar)

**Graph Search** (Relationship Strength):
- Finds connected memories via tags and categories
- Good for: Finding all memories tagged with "Q4-planning" even if not semantically similar
- Score: 1-20+ (higher = more shared connections)

### Deduplication & Ranking

Without merging, the same high-quality memory might appear twice (once from each modality), cluttering the context. The merging algorithm:
- Eliminates duplicates
- Combines relevance signals from both modalities
- Ranks by merged score for better coverage

### Example Ranking Impact

```
Memory A: vector=0.92, graph=8 → merged=0.70
Memory B: vector=0.65, graph=15 → merged=0.70  (tied - good diversity!)
Memory C: vector=0.88, graph=1 → merged=0.47
Memory D: vector=0.50, graph=0 → merged=0.25 (below threshold, filtered out)

Final order: A (0.70), B (0.70), C (0.47), D (filtered)
```

This ranking ensures the LLM gets both semantically relevant AND structurally connected memories.

## Configuration & Tuning

### Score Weighting

In `mergeVectorAndGraphResults()`, adjust the weighting formula:

```typescript
// Default: Equal weighting
existing.mergedScore = (existing.vectorScore! * 0.5) + (normalizedGraphScore * 0.5);

// Favor semantic relevance (70% vector, 30% graph)
existing.mergedScore = (existing.vectorScore! * 0.7) + (normalizedGraphScore * 0.3);

// Favor relationship strength (30% vector, 70% graph)
existing.mergedScore = (existing.vectorScore! * 0.3) + (normalizedGraphScore * 0.7);
```

### Graph Score Normalization

The normalization uses the max graph score in the current result set:

```typescript
const maxGraphScore = graphResults.length > 0
    ? Math.max(...graphResults.map(g => g.score))
    : 1; // Avoid division by zero
```

This is adaptive - if one search has higher relationship scores, they're normalized accordingly.

### Result Limits

In `memoryRAGSystem.searchAndSummarizeForMcp()`:

```typescript
const searchLimit = (options?.limit ?? this.MAX_MEMORIES_FOR_SUMMARY) * 2;
```

This fetches 2x the desired results from each modality before merging, increasing diversity in the merged set.

## Logging & Monitoring

Search results are logged to SQL `SearchHistory` table with:

- `VectorResults`: JSON array of vector search matches
- `GraphResults`: JSON array of graph search matches with relationship paths
- `ResultCount`: Final deduplicated result count
- `DurationMilliseconds`: Total search + merge time

This enables future evaluation of:
- Search quality metrics (overlap, diversity)
- Performance tuning (which modality is slower)
- User feedback integration (which results were helpful)

## Future Enhancements

1. **Adaptive Weighting**: Learn optimal vector/graph weight ratio from user feedback
2. **Relationship Analysis**: Extract and analyze relationship paths in successful searches
3. **Category-Specific Strategies**: Use different weights for different memory categories
4. **Graph Clustering**: Group results by relationship paths for better organization
5. **Feedback Loop**: Track which merged results users found most helpful

## Testing

To verify the merging behavior:

```typescript
// Mock vector results (semantic)
const vectorResults = [
    { id: '1', score: 0.9 },
    { id: '2', score: 0.7 }
];

// Mock graph results (relationship-based)
const graphResults = [
    { memory: { id: '2', ... }, score: 10 },  // Same memory as id:2
    { memory: { id: '3', ... }, score: 5 }    // New memory
];

// Merged result should deduplicate id:2 and combine scores
const merged = aggregator.mergeVectorAndGraphResults(
    vectorResults,
    graphResults,
    limit = 10,
    scoreThreshold = 0.4
);

// Expected: [id:2 (combined), id:1 (vector only), id:3 (graph only)]
```

## Summary

This enhancement transforms the post-search aggregation from single-modality (vector-only) to multi-modal (vector + graph), providing:

- **Richer Context**: Multiple relevance perspectives for LLM decision-making
- **Better Deduplication**: No redundant results cluttering the context
- **Intelligent Ranking**: Combined scores reflect both semantic and structural relevance
- **Audit Trail**: SQL logging enables future optimization
- **Flexible Tuning**: Adjustable weights and thresholds for domain-specific needs

The result: LLMs receive better-quality, more diverse context for improved RAG outcomes and more grounded responses.
