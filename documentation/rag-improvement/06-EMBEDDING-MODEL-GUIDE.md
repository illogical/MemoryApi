# Embedding Model Guide

> **Related docs**: [00-OVERVIEW.md](00-OVERVIEW.md) · [07-SCALING-STRATEGIES.md](07-SCALING-STRATEGIES.md)

## Current Setup

| Property | Value |
|----------|-------|
| **Model** | nomic-embed-text |
| **Dimensions** | 768 |
| **Distance metric** | Cosine similarity |
| **Used by** | Qdrant (`vectorService.ts` VECTOR_SIZE = 768) and Neo4j (`graphService.ts` vector index with 768 dimensions) |
| **Provider** | LMApi (custom) via `EmbeddingClient.embed()` in `modelClients.ts` |
| **When called** | On memory add (embed content), on search (embed query), on update (re-embed if content changed) |

Both Qdrant and Neo4j store the **same embedding** for each memory. The embedding is generated once and written to both databases.

---

## How Embedding Quality Affects RAG

The embedding model is the foundation of the entire retrieval pipeline. Every other improvement (re-ranking, graph search, aggregation) operates on the candidate set that embeddings surface. A poor embedding model means even perfect re-ranking will work with bad candidates.

**What the embedding model determines:**
- Whether "I prefer TypeScript for web projects" is close to "What's my favorite language for frontend?" (it should be)
- Whether "Docker setup for Bun" is close to "deployment configuration" (it should be, but with weaker models it may not be)
- Whether code snippets are close to natural language descriptions of what they do (hard for most models)

**What it does not determine:**
- Whether two memories share the same tags (that's graph structure)
- Whether a memory is stale or current (that's metadata)
- Whether a query is asking for a fact vs. a broad summary (that's query analysis)

---

## nomic-embed-text Characteristics

nomic-embed-text is a solid general-purpose embedding model:

| Aspect | Details |
|--------|---------|
| **Architecture** | Based on BERT, trained with contrastive learning |
| **Dimensions** | 768 |
| **Context window** | 8,192 tokens (generous for short memories) |
| **Strengths** | Good at general semantic similarity, handles mixed content (code + prose), open-source, runs locally |
| **Weaknesses** | 768 dims is moderate (some newer models use 1024+), not specifically optimized for code embeddings |
| **MTEB ranking** | Competitive with models 2-3× its size |

**For a personal knowledge base with < 100 memories**: nomic-embed-text is more than sufficient. The bottleneck is not embedding quality — it's graph structure, merge logic, and query analysis.

---

## When to Consider Alternatives

### Signals That Suggest Upgrading

1. **Evaluation shows poor recall**: If `evaluateSemanticQueries.ts` consistently shows that relevant memories rank below position 5, the embedding model may be the bottleneck
2. **Code snippet retrieval is weak**: Most general embedding models struggle with code. If code snippets are a major query pattern, consider a code-specialized model
3. **Knowledge base exceeds 10,000 memories**: Larger collections need more discriminating embeddings. 768 dimensions may not separate closely related memories well enough
4. **Multilingual content**: If memories include multiple languages, multilingual models like `bge-m3` are worth considering

### Signals That Suggest Staying

1. **Knowledge base is small** (< 1,000): Switching models gains marginal value
2. **Retrieval quality is acceptable**: If evaluation shows good recall, don't fix what isn't broken
3. **Re-embedding cost is significant**: Changing models means re-embedding every memory in both Qdrant and Neo4j
4. **Code is a minor query pattern**: General models handle prose, preferences, and notes well

---

## Alternative Models Worth Evaluating

| Model | Dimensions | Notes |
|-------|-----------|-------|
| **nomic-embed-text-v1.5** | 768 (Matryoshka-capable) | Drop-in upgrade with Matryoshka support (see below). Same dimensions, better quality on benchmarks. |
| **bge-m3** | 1024 | Multi-lingual, multi-granularity. Higher dimension = more discriminating but more storage/compute. |
| **mxbai-embed-large** | 1024 | Strong MTEB scores, good for general retrieval. Runs locally via Ollama. |
| **snowflake-arctic-embed-m** | 768 | Trained on diverse retrieval tasks, same dimension as current. Could be a direct swap. |
| **jina-embeddings-v3** | 1024 | Supports code, supports multiple task types (retrieval, classification, etc.) |

**Recommendation**: If you upgrade, start with **nomic-embed-text-v1.5** (same dimensions, minimal disruption) or **mxbai-embed-large** (if willing to increase dimensions to 1024).

---

## Matryoshka Embeddings — A Useful Concept

Some newer models (including nomic-embed-text-v1.5) support **Matryoshka Representation Learning (MRL)**. This means the embedding dimensions are ordered by importance — the first 256 dimensions carry more information than dimensions 257–768.

**Why this matters:**
- You can truncate embeddings to lower dimensions (e.g., 256 or 512) for faster approximate search, then use full dimensions for re-ranking
- Enables a **two-stage retrieval** pattern: fast search on truncated embeddings → re-rank on full embeddings
- Reduces Qdrant storage and search latency without changing the model

**How it would work with the current system:**
1. Store full 768-dim embeddings in both Qdrant and Neo4j (no change)
2. Create a second Qdrant collection with 256-dim truncated embeddings
3. First stage: search truncated collection (fast, high recall, lower precision)
4. Second stage: re-rank candidates using full embeddings

This is a **scaling optimization** — not needed until the knowledge base is significantly larger. See [07-SCALING-STRATEGIES.md](07-SCALING-STRATEGIES.md).

---

## Re-Embedding Strategy: How to Change Models Safely

Changing the embedding model means **every memory must be re-embedded** in both Qdrant and Neo4j, because embeddings from different models exist in incompatible vector spaces (cosine similarity between embeddings from different models is meaningless).

### Recommended Approach: Versioned Collections

```
Step 1: Create new Qdrant collection "memories_v2" with new dimensions
Step 2: Create new Neo4j vector index "memory_embedding_v2_index"
Step 3: Re-embed all memories from SQLite (source of truth) into new collections
Step 4: Run evaluation against both old and new collections
Step 5: If new model wins, swap active collection references in configService
Step 6: Delete old collections after verification
```

**Implementation details:**
- `vectorService.ts`: `COLLECTION_NAME` would become configurable (e.g., `'memories_v2'`)
- `graphService.ts`: Vector index name would need to be configurable
- `configService.ts`: New env var `EMBEDDING_MODEL_VERSION` or `COLLECTION_VERSION`
- SQLite `Memories` table has all content — it's the source for re-embedding

### Cost Estimate

| Knowledge Base Size | Re-embedding Time (est.) | Notes |
|--------------------|--------------------------| ------|
| 100 memories | ~30 seconds | Trivial — just do it |
| 1,000 memories | ~5 minutes | Schedule during downtime |
| 10,000 memories | ~45 minutes | Consider batching, run overnight |
| 100,000 memories | ~8 hours | Need a dedicated migration script with progress tracking |

Times assume local LMApi inference. Cloud inference would be faster but costs money.

---

## Impact on Both Vector Stores

A critical detail: **both Qdrant and Neo4j store embeddings from the same model**. Any model change must update both simultaneously.

| Store | What Changes | How |
|-------|-------------|-----|
| **Qdrant** | Collection dimensions, all point vectors | Create new collection with new `VECTOR_SIZE`, re-upsert all points |
| **Neo4j** | Vector index dimensions, all Memory node embeddings | Drop and recreate `memory_embedding_index` with new dimensions, update all `m.embedding` properties |
| **SQLite** | Nothing | SQLite doesn't store embeddings — it's unaffected |

This is another reason SQL is valuable as the source of truth during model migrations.

---

## Dimension Size Tradeoffs

| Dimensions | Storage per Memory | Search Speed | Discrimination |
|-----------|-------------------|--------------|----------------|
| 256 | 1 KB | Fastest | Lower — similar memories may have indistinguishable vectors |
| 384 | 1.5 KB | Fast | Moderate |
| 768 (current) | 3 KB | Moderate | Good for general-purpose |
| 1024 | 4 KB | Slower | Better separation of closely related concepts |
| 1536 | 6 KB | Slowest | Highest discrimination, but diminishing returns |

**For a personal knowledge base**: 768 is the sweet spot. You'd only benefit from 1024+ when the collection is large enough that many memories compete for the same semantic neighborhood (roughly > 5,000 memories on similar topics).

---

## Recommendation

**Short term (< 1,000 memories)**: Keep nomic-embed-text. Focus improvements on graph structure, merge logic, and query analysis — these will deliver far more impact than a model upgrade.

**Medium term (1,000–10,000 memories)**: Evaluate nomic-embed-text-v1.5 (Matryoshka-capable, same dimensions, drop-in upgrade). Run the existing evaluation scripts (`evaluateSemanticQueries.ts`) against both models to compare.

**Long term (> 10,000 memories)**: Consider 1024-dim models (mxbai-embed-large or jina-embeddings-v3) if semantic search recall degrades. Use the versioned collection approach to migrate safely.

**Do not change the embedding model before**:
1. The existing merge/re-ranking pipeline is improved (see [03-RERANKING-AND-MERGING.md](03-RERANKING-AND-MERGING.md))
2. Graph search is enriched (see [02-GRAPH-DB-IMPROVEMENTS.md](02-GRAPH-DB-IMPROVEMENTS.md))
3. Evaluation consistently shows embedding quality as the bottleneck
