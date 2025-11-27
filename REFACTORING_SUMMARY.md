# Semantic Queries Evaluation Refactoring

## Overview
Refactored `evaluateSemanticQueries.ts` to optimize model loading and improve evaluation efficiency by separating the embedding phase from the summarization phase.

## Problem
Previously, `rag.searchAndSummarizeForMcp()` was called for each query, which caused:
- The embedding model to be loaded/checked for every query
- The LLM model to be loaded/checked for every query
- Inefficient resource usage during batch evaluations

## Solution Architecture

```
OLD FLOW (Inefficient):
┌─────────────────────────────────────────────┐
│ For Each Query:                             │
│  1. Load Embedding Model (repeated!)        │
│  2. Generate Embedding                      │
│  3. Search Qdrant                           │
│  4. Load LLM Model (repeated!)              │
│  5. Run Aggregation                         │
└─────────────────────────────────────────────┘

NEW FLOW (Optimized):
┌─────────────────────────────────────────────┐
│ PHASE 1: Embedding & Search                 │
│  1. Load Embedding Model (ONCE)             │
│  2. For Each Query:                         │
│     - Generate Embedding                    │
│     - Search Qdrant                         │
│     - Store Results                         │
└─────────────────────────────────────────────┘
┌─────────────────────────────────────────────┐
│ PHASE 2: Aggregation                        │
│  1. Load LLM Model (ONCE)                   │
│  2. For Each Result Set:                    │
│     - Run Post-Search Aggregation           │
│     - Generate Summaries                    │
└─────────────────────────────────────────────┘
```

## New Methods Added

### MemoryRAGSystem (`src/services/memoryRAGSystem.ts`)

#### `searchMemoriesWithEmbedding(queryEmbedding, category?, limit?)`
Searches memories using a pre-computed embedding vector. Use this when you've already loaded the embedding model and generated embeddings.

**Parameters:**
- `queryEmbedding`: Pre-computed embedding vector
- `category`: Optional category filter
- `limit`: Maximum number of results

**Returns:** Array of `MemoryWithId[]`

#### `aggregateSearchResults(query, memories, options?)`
Runs post-search aggregation on pre-fetched memories without re-running the search.

**Parameters:**
- `query`: Original search query
- `memories`: Pre-fetched memory results
- `options`: Aggregation options (strategy, format, scoreThreshold, etc.)

**Returns:** Aggregation result with narratives, bullets, and cluster summaries

### MemoryPostSearchAggregator (`src/services/memoryPostSearchAggregator.ts`)

#### `aggregateMemories(query, memories, options)`
Aggregates and summarizes pre-fetched memories without running a search. Use this when you've already performed the search and filtering.

**Parameters:**
- `query`: Original search query
- `memories`: Pre-fetched and filtered memories
- `options`: Aggregation strategy, format, and parameters

**Returns:** Structured aggregation result

## Benefits

1. **Performance**: Models are loaded once per evaluation run instead of once per query
2. **Resource Efficiency**: Reduced memory thrashing from repeated model loading
3. **Flexibility**: Search and aggregation phases can be run independently
4. **Maintainability**: Clear separation of concerns between embedding and summarization

## Code Comparison

### Original (inefficient)
```typescript
for (const query of queries) {
    // Loads models every iteration
    const result = await rag.searchAndSummarizeForMcp(query, options);
}
```

### Refactored (optimized)
```typescript
// Phase 1: Embedding & Search
await rag.loadEmbeddingModel();
const searchResults = [];
for (const query of queries) {
    const embedding = await rag.generateEmbedding(query);
    const memories = await rag.searchMemoriesWithEmbedding(embedding, category, limit);
    searchResults.push({ query, memories, options });
}

// Phase 2: Aggregation
await rag.loadInferenceModel();
const results = [];
for (const { query, memories, options } of searchResults) {
    const result = await rag.aggregateSearchResults(query, memories, options);
    results.push(result);
}
```

## Running the Evaluation

```bash
# Use the npm script
npm run eval:aggregation

# Or run directly with options
npx tsx src/scripts/evaluateSemanticQueries.ts --model=phi-4 --provider=lmstudio
npx tsx src/scripts/evaluateSemanticQueries.ts --queries=src/samples/semanticSearchQueries.json --strategy=hybrid --format=both --limit=12
```

## Backward Compatibility

The original `searchAndSummarizeForMcp()` method remains unchanged and functional. It now internally uses `searchMemories()` which calls the new `searchMemoriesWithEmbedding()` method. All existing code continues to work as expected.

