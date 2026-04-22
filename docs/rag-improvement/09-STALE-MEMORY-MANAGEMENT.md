# Stale Memory Management

> **Priority**: P3 — implement after core pipeline improvements are in place.
> **Related docs**: [07-SCALING-STRATEGIES.md](07-SCALING-STRATEGIES.md) · [08-IMPROVEMENT-ROADMAP.md](08-IMPROVEMENT-ROADMAP.md) · [05-DATABASE-SYNC.md](05-DATABASE-SYNC.md)

## The Problem

Memories become outdated over time. A preference for "VS Code with Vim keybindings" from 6 months ago may have changed. A code snippet using an old API version may be misleading. A project that's been completed shouldn't rank equally with active work.

Stale memories:
- **Pollute search results** — vector similarity doesn't know about temporal relevance
- **Waste context window space** — outdated memories displace current ones in LLM prompts
- **Cause contradictions** — old and new memories may disagree, confusing the LLM summarizer

The user explicitly asked to **flag stale memories for future action** rather than implement automatic archival now. This doc covers the full spectrum of approaches, from simple flags to advanced contradiction detection, so a coding assistant can implement them incrementally.

---

## Freshness Signals

These are signals that indicate whether a memory is still relevant. Each can be computed from existing data.

### Signal 1: Time Since Creation

**Source**: `Memories.Created` in SQLite

**Logic**: Older memories are more likely to be outdated, but the decay rate depends on category.

| Category | Half-life (suggested) | Rationale |
|----------|----------------------|-----------|
| Code Snippet | 90 days | APIs, libraries, and patterns change frequently |
| Preference | 180 days | Personal preferences evolve slowly |
| Note | 120 days | Project notes become irrelevant after project completion |
| Fact | 365 days | Facts are relatively stable |
| Procedure | 180 days | Workflows change as tools evolve |
| Creative | Never | Creative work doesn't expire |
| Interaction Note | 60 days | Conversational context is highly temporal |

**Decay formula** (exponential):

$$
\text{freshness}(t) = e^{-\lambda t}
$$

Where $t$ is days since creation, and $\lambda = \frac{\ln 2}{\text{halfLife}}$.

For a "Code Snippet" with half-life of 90 days:
- Day 0: freshness = 1.0
- Day 90: freshness = 0.5
- Day 180: freshness = 0.25
- Day 365: freshness = 0.06

### Signal 2: Usage Frequency

**Source**: `SearchHistory` in SQLite — count how often a memory appears in search results.

**Logic**: Memories that are frequently returned in searches are likely still relevant (they keep matching queries). Memories that haven't appeared in any search result for 90+ days may be stale.

**Computation**:

```
SELECT m.Id, m.Title, 
       COUNT(sh.Id) as searchAppearances,
       MAX(sh.Created) as lastAppearedInSearch
FROM Memories m
LEFT JOIN SearchHistory sh ON sh.Results LIKE '%' || m.Id || '%'
WHERE sh.Created > date('now', '-90 days')
GROUP BY m.Id
ORDER BY searchAppearances ASC
```

Note: This requires SearchHistory to store result IDs, which it may already capture in VectorResults/GraphResults JSON fields.

**Score**: 
- 0 appearances in 90 days → usage score 0.0
- 1–2 appearances → 0.3
- 3–5 appearances → 0.6
- 6+ appearances → 1.0

### Signal 3: Last Updated

**Source**: Would need a `LastUpdated` or `Modified` field in SQLite (may not exist yet).

**Logic**: If a memory was recently updated, it was deliberately refreshed and should be considered fresh regardless of creation date.

**Implementation note**: If `Memories` table doesn't have an `Updated` column, add one. Populate it whenever a memory is updated through the API.

### Signal 4: Relationship Density

**Source**: Neo4j — count of relationships from a memory node.

**Logic**: Memories with many connections (shared tags with other memories, linked to active projects) are embedded in the knowledge graph and likely still relevant. Isolated memories with few connections may be stale.

```
MATCH (m:Memory {id: $id})
OPTIONAL MATCH (m)-[r]-()
RETURN m.id, count(r) as relationshipCount
```

**Score**:
- 0–1 relationships → density score 0.2
- 2–3 relationships → 0.5
- 4–6 relationships → 0.8
- 7+ relationships → 1.0

---

## Composite Staleness Score

Combine the signals into a single score:

$$
\text{staleness} = 1 - \left( w_1 \cdot \text{freshness}(t) + w_2 \cdot \text{usageScore} + w_3 \cdot \text{densityScore} \right)
$$

**Suggested weights** (tunable):

| Weight | Value | Rationale |
|--------|-------|-----------|
| $w_1$ (time) | 0.4 | Strongest signal — old things are often outdated |
| $w_2$ (usage) | 0.4 | If it keeps appearing in searches, it's still useful |
| $w_3$ (density) | 0.2 | Connected memories are more likely to be current |

**Interpreting the score**:

| Staleness Score | Meaning | Action |
|----------------|---------|--------|
| 0.0 – 0.3 | Fresh | No action needed |
| 0.3 – 0.6 | Aging | Monitor — may need review soon |
| 0.6 – 0.8 | Likely stale | Flag for review |
| 0.8 – 1.0 | Almost certainly stale | Flag for archival or deletion |

---

## Flagging Strategy (Recommended First Step)

Rather than automatically archiving, flag stale memories for human review. This is the safest approach for a small knowledge base.

### Option A: SQL Status Flag

Add a `FreshnessStatus` column to the `Memories` table:

```
ALTER TABLE Memories ADD COLUMN FreshnessStatus TEXT DEFAULT 'active';
-- Values: 'active', 'aging', 'stale', 'archived'

ALTER TABLE Memories ADD COLUMN StalenessScore REAL DEFAULT 0.0;

ALTER TABLE Memories ADD COLUMN LastReviewedAt TEXT;
```

**Staleness update script** — run periodically (daily or weekly):

1. Compute staleness score for each memory using the formula above
2. Update `StalenessScore` in SQLite
3. Set `FreshnessStatus` based on thresholds:
   - score < 0.3 → 'active'
   - score 0.3–0.6 → 'aging'  
   - score > 0.6 → 'stale'
4. Log a summary: "X memories active, Y aging, Z stale"

### Option B: Neo4j Property

Add `stalenessScore` and `freshnessStatus` properties to Memory nodes. This lets the graph traversal factor in freshness:

```
MATCH (m:Memory) WHERE m.id = $id
SET m.stalenessScore = $score, m.freshnessStatus = $status
```

Then in graph search, penalize stale memories:

```
MATCH (m:Memory)-[:TAGGED_WITH]->(t:Tag)<-[:TAGGED_WITH]-(related:Memory)
WHERE related.freshnessStatus <> 'archived'
RETURN related, 
       related.score * (1 - related.stalenessScore * 0.5) as adjustedScore
ORDER BY adjustedScore DESC
```

### Recommendation: Do Both

Store the canonical staleness score in SQL (source of truth), and sync it to Neo4j for graph-aware freshness weighting.

---

## Integration with Search Pipeline

Once staleness scores are computed and stored, integrate with the search pipeline:

### During Retrieval

**Option 1: Pre-filter** — Exclude archived memories before search:
- Qdrant: Add `FreshnessStatus` to payload, filter with `must_not: [{key: "FreshnessStatus", match: "archived"}]`
- Neo4j: Add `WHERE m.freshnessStatus <> 'archived'` to traversal queries
- This is the simplest approach and recommended as the first step

**Option 2: Score adjustment** — Blend staleness into the final score:

$$
\text{adjustedScore} = \text{mergedScore} \times (1 - \alpha \cdot \text{staleness})
$$

Where $\alpha$ controls how aggressively staleness penalizes results. Start with $\alpha = 0.3$ (30% penalty at max staleness).

This is better than pre-filtering because it doesn't completely eliminate stale memories — they just rank lower.

### During Aggregation

In the LLM summarization prompt, flag stale memories so the LLM can contextualize:

```
Memory 5 (relevance: 0.72, freshness: STALE — last updated 8 months ago):
"My preferred editor is Sublime Text"

Note: This may be outdated. More recent memories suggest VS Code is now preferred.
```

This lets the LLM decide whether to include stale information with appropriate caveats.

---

## Contradiction Detection (Advanced)

When two memories contradict each other, the newer one is usually correct.

### Approach: LLM-Based Contradiction Check

During memory creation, check if the new memory contradicts any existing memory:

1. When creating a new memory, run a focused vector search for similar existing memories
2. If similarity > 0.85 with an existing memory, check for contradiction:
   ```
   Prompt:
   Existing memory: "I prefer VS Code with Vim keybindings"
   New memory: "I've switched to Neovim as my primary editor"
   
   Do these contradict? If yes, which is likely the updated version?
   Response: { contradicts: true, supersedes: "existing" }
   ```
3. If contradiction detected, mark the old memory as superseded

**Implementation location**: `src/services/memoryTextProcessor.ts` or `src/app/memoryAPI.ts` (during `addMemory` flow)

**When to implement**: After P2 improvements. This is expensive (extra LLM call per memory creation) but valuable for keeping the knowledge base consistent.

### Simpler Alternative: Same-Title Detection

If a new memory has the same or very similar Title as an existing memory (Levenshtein distance < 3 or cosine similarity > 0.95 on title embeddings), flag the existing one as potentially superseded.

This is cheap, doesn't require LLM calls, and catches the most common case (updating a preference or fact).

---

## MCP / API Integration

Expose staleness information through existing interfaces:

### MCP Tool: Review Stale Memories

Add an MCP tool that returns memories needing review:

```
Tool name: review-stale-memories
Parameters: { limit: number, minStaleness: number }
Returns: List of stale memories with staleness scores and last-reviewed dates
```

This lets an AI agent proactively ask: "I noticed some of your memories may be outdated. Would you like to review them?"

### API Endpoint: GET /api/memories/stale

Return memories sorted by staleness score, optionally filtered by category:

```
GET /api/memories/stale?limit=10&category=Preference
Response: [{ id, title, category, stalenessScore, freshnessStatus, created, lastReviewedAt }]
```

### Reminder Service Integration

The existing `reminderService.ts` could be extended to include stale memory review reminders alongside its current functionality.

---

## Implementation Steps (For Coding Assistant)

### Step 1: Add Schema Changes (Low effort)

1. Add `FreshnessStatus`, `StalenessScore`, `LastReviewedAt` columns to SQLite `Memories` table
2. Add corresponding properties to Neo4j Memory nodes
3. Update the Memory model in `src/models/memory.ts`

### Step 2: Build Staleness Calculator (Medium effort)

1. Create `src/services/freshnessService.ts`
2. Implement time decay, usage frequency, and relationship density scoring
3. Compute composite staleness score
4. Add a script `src/scripts/updateStalenessScores.ts` to run batch updates

### Step 3: Integrate with Search (Low effort, once Step 2 is done)

1. Add pre-filter for archived memories in vector and graph search
2. Optionally add score adjustment in merge pipeline

### Step 4: Expose via API/MCP (Low effort)

1. Add `/api/memories/stale` endpoint
2. Add `review-stale-memories` MCP tool

### Step 5: Contradiction Detection (High effort, optional)

1. Add contradiction check in memory creation flow
2. Use LLM or simple title-similarity heuristic

---

## Summary

| Approach | Effort | Impact | When to Implement |
|----------|--------|--------|-------------------|
| SQL freshness flag | Low | Low-medium | After P0 improvements |
| Staleness scoring | Medium | Medium | With feedback loop (P2-4) |
| Search pre-filtering | Low | Medium | After staleness scoring |
| Score adjustment | Low | Medium-high | After pre-filtering proves useful |
| Contradiction detection | High | High | When knowledge base has 500+ memories |
| MCP review tool | Low | Medium | Anytime after freshness flags exist |
