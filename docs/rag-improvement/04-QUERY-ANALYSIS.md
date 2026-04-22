# Query Analysis and Adaptive Retrieval

> **Related docs**: [03-RERANKING-AND-MERGING.md](03-RERANKING-AND-MERGING.md) · [02-GRAPH-DB-IMPROVEMENTS.md](02-GRAPH-DB-IMPROVEMENTS.md) · [08-IMPROVEMENT-ROADMAP.md](08-IMPROVEMENT-ROADMAP.md)

## The Problem: One Pipeline for All Queries

The current search pipeline treats every query identically:

1. Generate embedding
2. Run vector search (Qdrant) and graph search (Neo4j) in parallel, both with `limit × 2`
3. Merge with 50-50 weighting
4. Filter at 0.7 threshold
5. Summarize with caller-specified strategy (or default to linear)

But these queries have fundamentally different needs:

| Query | Best Approach |
|-------|--------------|
| "What's my preferred IDE?" | Fact retrieval — vector search, small result set, direct answer |
| "What do I know about web development?" | Broad exploration — graph traversal, larger result set, clustered summary |
| "Show me my SQL code snippets" | Code lookup — tag filtering + fulltext, code-formatted output |
| "What relates to the MemoryApi project?" | Relational — graph-heavy, entity traversal, broad discovery |
| "What did I note about deployment last month?" | Temporal + topical — SQL date filter + vector search |

Applying the same pipeline to all of these means the system is mediocre at each instead of good at any.

---

## Concept: Query Classification

**Query classification** adds a preprocessing step before search that determines the query type, then selects an appropriate retrieval strategy.

```
Current pipeline:
  Query → Embed → Search → Merge → Summarize

Proposed pipeline:
  Query → Classify → Select Strategy → Embed → Search (strategy-specific) → Merge → Summarize
```

The classification step is lightweight (one LLM call, < 50 tokens output) and enables significant downstream optimization.

---

## Query Types for a Personal Knowledge Base

Based on the actual use patterns for this system (AI agents querying about dev projects, preferences, planning, instructions, reports, brainstorms, summaries), the following query types cover the space:

### 1. Fact Retrieval

**Pattern**: Asks for a specific piece of information the user has stored.

**Examples**:
- "What's my preferred IDE?"
- "What TypeScript libraries do I use?"
- "What's my work schedule preference?"

**Characteristics**:
- Typically has one clear "right answer" in the knowledge base
- Vector search excels — the answer is semantically close to the query
- Fewer results needed (1–5 memories usually contain the answer)
- Linear aggregation produces a direct answer

**Optimal strategy**:
- Vector weight: 0.7, Graph weight: 0.3
- Low result limit (5–8 after merge)
- Format: narrative (concise direct answer)
- Aggregation: linear

### 2. Broad Exploration

**Pattern**: Asks about a topic area to gather context or summarize knowledge.

**Examples**:
- "What do I know about web development?"
- "Summarize my ideas for projects"
- "What have I been working on recently?"

**Characteristics**:
- No single right answer — wants breadth across many memories
- Graph traversal excels — follows connections to discover related memories
- More results needed (10–20) for comprehensive coverage
- Clustered aggregation groups insights by category or tag

**Optimal strategy**:
- Vector weight: 0.4, Graph weight: 0.6
- Higher result limit (15–20 after merge)
- Format: bullets (structured overview) or both
- Aggregation: cluster-category or hybrid

### 3. Code Lookup

**Pattern**: Asks for specific code snippets, commands, or technical instructions.

**Examples**:
- "Show me my SQL queries"
- "What code did I save for API authentication?"
- "Docker commands I've stored"

**Characteristics**:
- Content type is specific (Category = "Code Snippet" in many cases)
- Fulltext search excels — exact keyword matching for language names, function names
- Tag filtering helps narrow results (tags like "Programming", "Snippet")
- Code-formatted output is more useful than narrative prose

**Optimal strategy**:
- Pre-filter by Category = "Code Snippet" (if code-specific)
- Fulltext search included with high weight
- Vector weight: 0.3, Graph weight: 0.2, Fulltext weight: 0.5
- Format: bullets (each snippet as a separate item)
- Aggregation: linear (list the snippets directly)

### 4. Relational

**Pattern**: Asks about relationships, connections, or everything related to a specific entity.

**Examples**:
- "What relates to the MemoryApi project?"
- "What tools am I using for AI development?"
- "What connects to my Docker setup?"

**Characteristics**:
- Wants to discover connections, not just semantic similarity
- Graph traversal excels — especially with entity nodes (Project, Tool)
- Multi-hop traversal valuable (find transitive connections)
- May need larger result sets to capture the full picture

**Optimal strategy**:
- Vector weight: 0.3, Graph weight: 0.7
- Higher result limit (10–15)
- Graph: use multi-hop traversal if available
- Format: bullets or both
- Aggregation: cluster-tag (group by connecting entities)

### 5. Temporal

**Pattern**: References time — "recent", "last month", "this year", or specific dates.

**Examples**:
- "What did I note about deployment last week?"
- "Recent reminders"
- "What have I added since January?"

**Characteristics**:
- Time is a first-class filter, not just a search signal
- SQL excels — WHERE LastUpdated > date_threshold
- Vector search within the time-filtered set
- Results should include timestamps in output

**Optimal strategy**:
- Pre-filter by date range (via SQL or Qdrant payload filter)
- Then run vector search within filtered set
- Standard merge weighting
- Format: bullets with dates
- Aggregation: linear

---

## Query Classifier Design

### LLM-Based Classification

Add a new method to `memoryTextProcessor.ts` (or a new `queryAnalyzer.ts` service):

```
Method: classifyQuery(query: string): Promise<QueryClassification>

Output interface:
{
    type: 'fact' | 'exploration' | 'code' | 'relational' | 'temporal',
    confidence: number,           // 0-1
    suggestedCategory?: string,   // e.g., "Code Snippet" for code queries
    temporalHint?: string,        // e.g., "last week", "2025" for temporal queries
    entityHint?: string           // e.g., "MemoryApi" for relational queries  
}
```

### Prompt Design

```
You are a query classifier for a personal knowledge base. Classify the query into one of these types:

- fact: Asks for a specific piece of information (e.g., preferences, specific tools, settings)
- exploration: Asks for a broad overview or summary of a topic area
- code: Asks for code snippets, commands, or technical instructions
- relational: Asks about relationships, connections, or everything about a specific entity/project
- temporal: References time (recent, last month, dates)

Query: "{{query}}"

Respond with a JSON object:
{"type": "...", "confidence": 0.0-1.0}

If the query mentions a specific entity, add: "entityHint": "entity_name"
If the query mentions time, add: "temporalHint": "time_reference"
If the query implies a specific category, add: "suggestedCategory": "category_name"
```

**LLM settings**: temperature=0.1 (highly deterministic), max_tokens=100

**Cost**: ~50–100ms per query (one short LLM call). This runs in parallel with embedding generation, so it adds minimal latency to the pipeline.

---

## Strategy Selection Matrix

Based on the query classification, select retrieval parameters:

```
const STRATEGIES = {
    fact: {
        vectorWeight: 0.7,
        graphWeight: 0.3,
        limit: 8,
        scoreThreshold: 0.4,
        aggregation: 'linear',
        format: 'narrative'
    },
    exploration: {
        vectorWeight: 0.4,
        graphWeight: 0.6,
        limit: 20,
        scoreThreshold: 0.3,
        aggregation: 'cluster-category',
        format: 'both'
    },
    code: {
        vectorWeight: 0.3,
        graphWeight: 0.2,
        fulltextWeight: 0.5,
        limit: 10,
        scoreThreshold: 0.3,
        aggregation: 'linear',
        format: 'bullets',
        categoryFilter: 'Code Snippet'
    },
    relational: {
        vectorWeight: 0.3,
        graphWeight: 0.7,
        limit: 15,
        scoreThreshold: 0.3,
        aggregation: 'cluster-tag',
        format: 'bullets'
    },
    temporal: {
        vectorWeight: 0.6,
        graphWeight: 0.4,
        limit: 10,
        scoreThreshold: 0.3,
        aggregation: 'linear',
        format: 'bullets',
        // Additional: date filter applied via SQL/Qdrant pre-filter
    }
};
```

### Override Behavior

If the caller explicitly provides options (limit, strategy, format), those override the auto-selected values. Query classification only fills in defaults.

```
// In searchAndSummarizeForMcp():
const classification = await this.classifyQuery(query);
const strategy = STRATEGIES[classification.type];

// Caller options override auto-selected defaults
const effectiveOptions = {
    limit: options?.limit ?? strategy.limit,
    scoreThreshold: options?.scoreThreshold ?? strategy.scoreThreshold,
    strategy: options?.strategy ?? strategy.aggregation,
    format: options?.format ?? strategy.format,
    category: options?.category ?? (strategy.categoryFilter || undefined),
    // New fields:
    vectorWeight: strategy.vectorWeight,
    graphWeight: strategy.graphWeight,
};
```

---

## Pipeline Changes

### Current Pipeline

```
searchAndSummarizeForMcp(query, options)
    → generateEmbedding(query)
    → orchestrator.searchVectorAndGraphParallel(embedding, category, searchLimit)
    → aggregator.searchAndSummarizeForMcp(query, options, vectorResults, graphResults)
        → mergeVectorAndGraphResults(vectorResults, graphResults, limit, 0.7)
        → aggregateMemories(query, merged, options)
    → log to SearchHistory
```

### Proposed Pipeline

```
searchAndSummarizeForMcp(query, options)
    → PARALLEL:
        ├── classifyQuery(query)           ← NEW
        └── generateEmbedding(query)
    → resolveStrategy(classification, options)  ← NEW
    → orchestrator.searchWithStrategy(embedding, strategy)  ← MODIFIED
        ├── vectorSearch(embedding, category, limit)
        ├── graphTraversal(vectorResultIds, limit)  ← CHANGED (see 02-GRAPH-DB-IMPROVEMENTS)
        └── fulltextSearch(query, limit)             ← NEW
    → mergeWithRRF(vectorResults, graphResults, fulltextResults, strategy)  ← MODIFIED
    → [optional] rerankResults(query, merged)  ← NEW
    → aggregateMemories(query, reranked, strategy)
    → log to SearchHistory (include classification metadata)
```

### Key Change: Parallel Classification + Embedding

The query classifier runs in parallel with embedding generation. Since both are independent LLM operations, the total latency is `max(classifyTime, embedTime)` rather than `classifyTime + embedTime`.

```typescript
const [classification, queryEmbedding] = await Promise.all([
    this.classifyQuery(query),
    this.generateEmbedding(query)
]);
```

---

## Query-Aware Aggregation Prompts

The existing `aggregation_summary.txt` prompt is generic. With query classification, the aggregation prompt can be tailored:

### Fact Retrieval Prompt Addition

```
## Query Context
The user is asking for a specific fact or preference.
Produce a direct, concise answer. If the memories contain a clear answer, state it first.
Do not provide broad context unless it directly supports the answer.
```

### Exploration Prompt Addition

```
## Query Context
The user wants a broad overview of a topic area.
Organize the response to show breadth. Use categories or themes to structure the summary.
Highlight connections between memories where relevant.
```

### Code Lookup Prompt Addition

```
## Query Context
The user is looking for code snippets or technical instructions.
Present each relevant snippet with its context. Use code formatting where applicable.
Prioritize exact matches over conceptual similarity.
```

### Relational Prompt Addition

```
## Query Context
The user wants to understand connections and relationships around a specific topic or entity.
Show how memories relate to each other. Emphasize shared themes, projects, or tools.
Highlight transitive connections (A relates to B, which relates to C).
```

These additions can be injected into the existing prompt template using a new `{{query_context}}` placeholder.

---

## Evaluation: Measuring Classification Quality

### Automatic Evaluation

Extend `evaluateSemanticQueries.ts` to include query classification:

1. For each test query in `semanticSearchQueries.json`, add an expected query type
2. Run the classifier on each query
3. Compare predicted vs. expected type
4. Report accuracy, confusion matrix (same pattern as `evaluateCategorization.ts`)

### Evaluating Strategy Impact

Compare search results with and without query-adaptive strategies:

```
For each test query:
  1. Run search with fixed default strategy → results_default
  2. Run search with query-classified strategy → results_adaptive
  3. Compare: result overlap, unique results surfaced, user-judged relevance
```

This uses the existing evaluation infrastructure and `memoryReportService.ts` for report generation.

---

## Implementation Priority

| Step | What | Complexity | Impact |
|------|------|-----------|--------|
| 1 | Create `classifyQuery()` method + prompt | Low | Foundation for all below |
| 2 | Wire into `searchAndSummarizeForMcp()` (parallel with embedding) | Low | Minimal disruption |
| 3 | Add strategy selection matrix | Low | Immediate adaptive behavior |
| 4 | Add query context to aggregation prompts | Low | Better summaries per query type |
| 5 | Add classification to evaluation scripts | Medium | Measurable improvement tracking |

Total added latency: ~0ms (classification runs parallel with embedding).
Total complexity: Low-Medium (no architectural changes, additive only).

See [08-IMPROVEMENT-ROADMAP.md](08-IMPROVEMENT-ROADMAP.md) for where this fits in the overall improvement sequence.
