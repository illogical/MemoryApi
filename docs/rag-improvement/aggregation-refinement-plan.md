# Aggregation Pipeline Refinement Plan

**Date:** 2026-04-21  
**Area:** Post-search aggregation — quality, completeness, and overflow resilience

---

## Context

The MemoryAPI uses a combined vector + graph search pipeline whose aggregation output feeds an LLM consumer (GitHub Copilot via MCP). Evaluations reveal three gaps:

1. **Result limits are too conservative.** The default cap of 10 memories silently drops the bulk of a broad result set. A query like "What are my preferences?" could match 30+ records — only 10 come through.
2. **The aggregation memory context is too thin.** Content is cut at 200 characters and key metadata fields (Durability, Tools, Projects, Topics) are omitted from the serialized block the LLM sees.
3. **No overflow safety net exists.** Increasing limits is only useful if there's a guardrail that prevents exceeding local model context windows (4K–32K depending on the model being tested).

---

## Current Constraints

| Constraint | Current Value | Impact |
|---|---|---|
| Default result limit | 10 | Broad queries silently drop most results |
| Score threshold | 0.7 | May exclude relevant results for categorical queries |
| Content truncation | 200 chars | Truncates ~40% of real memories in seed data |
| Serialized fields | ID, Category, Tags, LastUpdated, Description, Content | Omits Durability, Tools, Projects, Topics |
| Overflow handling | None | Raising limits without this risks breaking local models |
| System message | "You are a concise memory summarizer." | Undersells the complexity of the aggregation task |

---

## Decisions Made

| Question | Decision |
|---|---|
| Broad query strategy | Raise default limit (simple, controlled, predictable) |
| Overflow condensation | Pre-pass OR chunked — unified configurable approach: `CONDENSATION_BATCH_SIZE = 1` is a full pre-pass; `N > 1` is chunked-then-meta-summarized |
| Score threshold | Configurable; recommended initial value `0.6` (from 0.7) for broad queries |
| Content truncation | Increase to `500–800` chars; log a warning when truncation occurs |
| Add Durability | Yes — enables the LLM to prioritize long-term facts over stale reminders |
| Add Tools/Projects/Topics | Yes — surfaces the graph entity relationships in aggregation context |

---

## Durability Explained

Durability is set at ingestion time (explicitly by the user, or defaulted for LLM-inferred memories). The aggregation LLM should prioritize by durability in this order:

| Durability | Meaning | Priority |
|---|---|---|
| `durable` | Stable long-term fact — preferences, skills, installed tools, habits | **Highest** |
| `working` | Currently active but may change — in-progress projects, drafts | High |
| `historical` | Past events or completed items — conferences attended, old reminders | Medium |
| `temporary` | Short-lived — appointments, time-sensitive reminders | Lowest (unless query is specifically about it) |

---

## Implementation Plan

### Phase 1 — Serialization Improvements

**File:** [src/services/memoryPostSearchAggregator.ts](../../src/services/memoryPostSearchAggregator.ts)

Update the `summarizeMemoriesLinear()` serialization block to include additional fields. The new per-memory format:

```
ID: {id}
Category: {Category}
Durability: {Durability}
Tags: {tag1, tag2, ...}
Tools: {tool1, tool2, ...}   (omit line if empty)
Projects: {project1, ...}    (omit line if empty)
Topics: {topic1, ...}        (omit line if empty)
LastUpdated: {LastUpdated}
Description: {Description}
Content: {Content[0:800]}
---
```

- Increase content truncation from `200` → `800` characters.
- Log an `info` message when content IS truncated, including the memory ID and full-length content (for diagnostics).
- Omit optional fields (Tools, Projects, Topics) if the array is empty to keep blocks compact.
- The same serialization update applies to `summarizeMemoriesByCategory()` and any other methods that call the packed format.

**Why Durability works:** The aggregation_summary.txt prompt (already updated) instructs the LLM to prefer durable > working > historical > temporary. This prioritization is intuitive given the plain-English labels and doesn't require training — any instruction-following model handles it well.

---

### Phase 2 — Raised Default Limits

**File:** [src/services/memoryRAGSystem.ts](../../src/services/memoryRAGSystem.ts)

Update the config constants at the top of `MemoryRAGSystem`:

```typescript
private readonly MAX_MEMORIES_FOR_SUMMARY = 25;       // was 10
private readonly BROAD_QUERY_SCORE_THRESHOLD = 0.6;   // new
private readonly OVERFLOW_THRESHOLD_CHARS = 15000;    // new — see Phase 3
private readonly CONDENSATION_BATCH_SIZE = 1;         // new — 1 = pre-pass, N = chunked
private readonly MAX_CLUSTERS = 5;                    // unchanged
private readonly MAX_MEMORIES_PER_CLUSTER = 8;        // was 5
```

**Recommended initial score threshold:** `0.6`

- At `0.7`, broad categorical queries ("What are my preferences?") lose results that are semantically relevant but not lexically similar to the query string.
- At `0.6`, coverage improves while still excluding low-signal noise.
- Evaluate by running the seed eval fixtures and checking how often `0.6` brings in false positives vs. how often `0.7` misses true positives. Adjust incrementally.

---

### Phase 3 — Configurable Overflow Condensation

**New prompt file:** [src/prompts/memory_condensation.txt](../../src/prompts/memory_condensation.txt)

**New method in:** [src/services/memoryPostSearchAggregator.ts](../../src/services/memoryPostSearchAggregator.ts)

#### Logic

Before calling the final aggregation LLM, check if the packed memories string exceeds `OVERFLOW_THRESHOLD_CHARS` (default `15000`). If it does, run a condensation pass first.

```
packed.length > OVERFLOW_THRESHOLD_CHARS
   → condenseMemories(memories, batchSize)
   → finalSummarize(condensedBlock)

packed.length ≤ OVERFLOW_THRESHOLD_CHARS
   → finalSummarize(packed)   (no change from current behavior)
```

#### Batch size behavior

- `batchSize = 1`: All memories passed in one condensation call (pre-pass). One extra LLM call total. Best for mid-size models.
- `batchSize = N (e.g., 10)`: Memories split into chunks of N → each chunk condensed independently → condensed chunks concatenated → final aggregation call. More calls but handles very large sets safely for smaller models.

#### `memory_condensation.txt` prompt (new file)

```
You are a memory condensation assistant. Your task is to compress a batch of memories into a compact but faithful intermediate representation to be passed to another LLM.

For each memory, produce a single condensed line using this format:
[{Category}] {key fact or instruction} | Tags: {top 1-3 most relevant tags} | {entity names if any}

Rules:
- Preserve every distinct memory — do not drop any.
- Shorten verbose phrasing while retaining all specific values (dates, names, tool names, preferences, numbers).
- Remove filler words, background context, and repeated preambles ("Remember that...", "I prefer...", etc.).
- Do not merge separate memories into one line — each memory gets exactly one output line.
- Do not add commentary, section headers, explanations, or summaries.
- Output one condensed line per memory, separated by newlines only.

## Memories to condense:
{{memories}}
```

#### New method signature

```typescript
async condenseMemories(
    memories: MemoryWithId[],
    batchSize: number = 1
): Promise<string>
// Returns condensed string ready to be used as {{memories}} in the aggregation prompt
```

---

### Phase 4 — System Message Improvement

**File:** [src/services/memoryPostSearchAggregator.ts](../../src/services/memoryPostSearchAggregator.ts)

Update the system message for the aggregation LLM call (currently just "You are a concise memory summarizer. Output only the summary.") to:

```
You are a memory aggregation engine. Synthesize the provided memory records into a structured summary as instructed. Do not add information not present in the memories. Follow the output format exactly.
```

This better aligns the system role with the complexity of the instruction set in the user prompt.

---

### Phase 5 — New Prompt File (condensation)

Create [src/prompts/memory_condensation.txt](../../src/prompts/memory_condensation.txt) (content in Phase 3 above).

Add `renderMemoryCondensation(memories: string): string` to `PromptTemplateService`.

---

## Files Modified

| File | Change |
|---|---|
| [src/prompts/aggregation_summary.txt](../../src/prompts/aggregation_summary.txt) | Already updated — category fix, durability guidance, completeness notes, bullet ordering ✓ |
| [src/prompts/memory_condensation.txt](../../src/prompts/memory_condensation.txt) | New file — condensation prompt |
| [src/services/memoryPostSearchAggregator.ts](../../src/services/memoryPostSearchAggregator.ts) | Updated serialization, overflow check, `condenseMemories()` method, system message |
| [src/services/promptTemplateService.ts](../../src/services/promptTemplateService.ts) | Add `renderMemoryCondensation()` |
| [src/services/memoryRAGSystem.ts](../../src/services/memoryRAGSystem.ts) | Raise limits, add overflow + condensation config constants |

---

## Additional Prompt Suggestions

Beyond the aggregation flow, these additional prompt/harness ideas could guide better LLM accuracy across the system:

| Prompt Idea | Purpose | Value |
|---|---|---|
| `query_intent_classifier.txt` | Classify incoming query as "specific retrieval" vs. "broad survey" — could adjust limit and threshold before search | Enables automatic limit tuning without manual API params |
| `memory_dedup_validator.txt` | Given two similar memories, determine if they are duplicates or distinct facts | Helps prune the growing memory store over time |
| `durability_assessor.txt` | For LLM-inferred memories that lack explicit durability, classify into durable/working/historical/temporary based on content | Improves quality of memories added via agent capture |
| `tag_quality_scorer.txt` | Given a memory's content and its chosen tags, score the quality of the tag assignment | Eval-only prompt — feeds metrics on tagging prompt quality across models |
| `recall_self_eval.txt` | After generating a search result, ask the LLM to self-evaluate: "Did the provided context fully answer the question?" | Detects when limit was too low or threshold too aggressive |

---

## Verification

1. Run seed ingestion and confirm Durability, Tools, Projects, Topics appear in the packed memory block in the debug logs.
2. Run the query `"What are my preferences?"` — confirm more than 10 memories appear in `topMemories` (expect 20+).
3. Artificially construct a result set that exceeds `OVERFLOW_THRESHOLD_CHARS` — confirm the condensation path is triggered and logged.
4. With `CONDENSATION_BATCH_SIZE = 10`, verify memories are chunked correctly and meta-summarized.
5. Confirm content truncation warning appears in logs for memories exceeding 800 chars.
6. Compare bullets output before and after serialization improvement — verify `[Preference]` labels appear correctly and durability-sorted ordering is present.
