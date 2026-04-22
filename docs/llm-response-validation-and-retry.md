# LLM Response Validation and Retry Strategy

**Date:** 2026-04-21  
**Area:** Ingestion — metadata enrichment quality

---

## Context

The MemoryAPI uses local LLM models (via Ollama/LMStudio) to enrich each memory at ingestion time with a category, tags, summary, and entity metadata. Evaluations against multiple models reveal that smaller local models frequently return invalid responses — particularly for classification (returning categories not in the finite list) and tagging (returning tags not in the provided tag set).

Because the valid options are known ahead of time and injected into the prompts, we can apply deterministic post-processing to:

1. **Filter** invalid values out of LLM responses and log what was discarded.
2. **Retry** when a response is so bad it's entirely unusable (invalid category, or zero valid tags).

This creates a feedback loop for metrics: every discard and every retry is logged so we can track how often models make specific mistakes — and whether prompt changes reduce them over time.

---

## Goals

- Improve end-to-end metadata accuracy without requiring manual memory review.
- Make every invalid LLM value observable (logged with enough context to run metrics later).
- Avoid silent data corruption (e.g., storing a hallucinated category that passes undetected).
- Fix the pre-existing mismatch between `MemoryCategory` enum values and what `allCategories.json` (and therefore the prompt) actually tells the LLM to use.

---

## Design Decisions

| Question | Decision |
|---|---|
| Category source of truth | Fix the `MemoryCategory` enum to match `allCategories.json`. The JSON is what gets injected into the prompt, so it's the ground truth. |
| Fallback after max category retries | Default to `"Note"` — safe, neutral category. Logged as a fallback so it's visible in metrics. |
| Tag retry trigger | Only retry when **0 valid tags remain** after filtering. If even 1 valid tag survives, keep it — partial signal is better than none. |
| `suggestTags()` scope | Normalize only (lowercase, trim, filter empty). This is an open-ended discovery prompt whose output feeds a frontend tag-suggestion UI — all values are informative. |

---

## Category Enum Fix

**File:** [src/models/memoryCategory.ts](../src/models/memoryCategory.ts)

The `MemoryCategory` enum is misaligned with `allCategories.json`:

| allCategories.json | Current enum value |
|---|---|
| `Snippet` | `Code Snippet` ❌ (wrong) |
| `History` | *(missing)* ❌ |

**Change:** Rename `CODE_SNIPPET = 'Code Snippet'` → `SNIPPET = 'Snippet'` and add `HISTORY = 'History'`.

> `MemoryCategory.CODE_SNIPPET` is never referenced outside the enum definition itself, so this is a safe rename.

---

## Implementation Plan

### 1 — Expose valid category/tag lists from PromptTemplateService

**File:** [src/services/promptTemplateService.ts](../src/services/promptTemplateService.ts)

Add two public helper methods that read from the same JSON files the prompts already use. The result should be cached (read-once, stored in instance variables) since these files don't change at runtime.

```typescript
// Returns the canonical category strings (from allCategories.json)
getValidCategories(): string[]

// Returns all canonical tag strings across all groups (from allTags.json)
getValidTags(): string[]
```

These methods give `MemoryTextProcessor` a single source of truth without duplicating file-read logic.

---

### 2 — classifyText(): validate + retry

**File:** [src/services/memoryTextProcessor.ts](../src/services/memoryTextProcessor.ts)

**Max attempts:** 3 (original call + 2 retries)  
**Validation:** Case-insensitive match against `getValidCategories()`. On match, return the canonical casing from the list.  
**On failure:** Log a `warn` with the discarded value and attempt number.  
**After all attempts exhausted:** Log a final `warn` and return `MemoryCategory.NOTE` as the safe fallback.

```
Attempt 1 → raw = "snippet" → matches "Snippet" ✓ → return "Snippet"
Attempt 1 → raw = "CodeBlock" → no match → log warn, retry
Attempt 2 → raw = "Note" → matches ✓ → return "Note" (log that valid found on attempt 2)
... all 3 fail → log warn, return "Note" as fallback
```

Log format for discards:
```
[classifyText] Attempt 1/3: discarded invalid category "CodeBlock"
[classifyText] Valid category "Note" found on attempt 2
[classifyText] All 3 attempts failed. Falling back to "Note"
```

---

### 3 — tagText(): filter invalid tags + conditional retry

**File:** [src/services/memoryTextProcessor.ts](../src/services/memoryTextProcessor.ts)

**Max attempts:** 3  
**Validation:** Build a case-insensitive lookup map from `getValidTags()` (`lowercase → canonical`). Split the LLM comma-separated response, then for each tag check the map.

- **Match found** → keep the canonical-cased string from the map.
- **No match** → discard and log.

**Retry trigger:** Only when 0 valid tags remain after filtering.  
**After all attempts exhausted:** Log a `warn` and return `[]`.

> **Important:** Bypass `normalizeTags()` before the validation lookup — the plural-to-singular converter would mangle multi-word tags like "Notes" → "note", causing false misses. `normalizeTags()` is replaced by the map lookup for deduplication and canonical casing.

Log format:
```
[tagText] Attempt 1/3: discarded 2 invalid tag(s): [Archive, PersonalPreference]
[tagText] Attempt 1/3: 0 valid tags remain. Retrying...
[tagText] All 3 attempts failed. Returning empty tags.
```

---

### 4 — suggestTags(): normalize output

**File:** [src/services/memoryTextProcessor.ts](../src/services/memoryTextProcessor.ts)

After parsing the JSON array, apply:
```typescript
tags
  .filter(t => typeof t === 'string')
  .map(t => t.trim().toLowerCase())
  .filter(t => t.length > 0)
```

No retry. No filtering against the canonical list. The goal is consistent casing for DB storage and frontend display — not restriction.

---

## Files Modified

| File | Change |
|---|---|
| [src/models/memoryCategory.ts](../src/models/memoryCategory.ts) | Rename `CODE_SNIPPET→SNIPPET`, add `HISTORY` |
| [src/services/promptTemplateService.ts](../src/services/promptTemplateService.ts) | Add `getValidCategories()`, `getValidTags()` with instance-level cache |
| [src/services/memoryTextProcessor.ts](../src/services/memoryTextProcessor.ts) | Refactor `classifyText`, `tagText`, `suggestTags` |

---

## Logging Strategy

All discarded values and retries are logged at `warn` level so they survive the default `info` console threshold and show up in the daily log file. The caller context prefix (`[classifyText]`, `[tagText]`) is preserved so log lines can be grepped independently for metrics.

Future work: aggregate these warn-level lines into a post-ingestion metrics report (count of discards per model, per category, per session).

---

## Verification

1. Run seed ingestion with `npm run load:seeds` — confirm no TypeScript errors.
2. Check logs for `[classifyText]` and `[tagText]` warn lines — verify discards are reported.
3. Add a test memory whose content is ambiguous (e.g., a code snippet) — confirm category lands on `Snippet` not `Code Snippet`.
4. Temporarily point at a low-quality model — verify retry kicks in and fallback to `Note` is logged when all 3 attempts fail.
5. Confirm `suggestTags` output in SQL `TagSuggestions` table shows lowercase values.
