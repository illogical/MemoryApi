# Prompt Refinement Findings

**Status:** Review notes

**Date:** 2026-09-04

**Applies to:** `categorization.txt`, `tagging.txt`, `memory_summary.txt`, `seedMemories.json`

**Related:** [`docs/plans/2026-09-03-ingestion-prompt-refinement.md`](../plans/2026-09-03-ingestion-prompt-refinement.md) · LMEval `docs/plans/2026-09-03-professional-memory-evaluations.md`

Eight findings from reading `src/samples/seedMemories.json` against the three prompts that are supposed to reproduce it, plus the prompt changes they justify. All counts are computed from the 26 seed records (73 tag assignments, 25 of 61 tags used, 2.8 tags per memory). Code references were verified against the working tree.

## What LMEval adds

MemoryApi already has evaluators. The difference is not that LMEval measures and they do not — it is what each can tell you when a number comes back bad.

| Question | Today, in MemoryApi | With LMEval |
|---|---|---|
| How good is classification? | One accuracy figure per run | Macro-F1, per-class recall, confusion matrix — which category is lost, and to what |
| Is a change an improvement? | Compare two numbers by eye | Paired comparison against an approved baseline, with an interval and a verdict |
| Where does tagging fail? | Aggregate overlap | Precision/recall split, per-tag-group recall, unknown and duplicate rates, exact-set accuracy |
| Is the model stable? | Not measured — single shot | Run-to-run agreement across repeated runs at temperature 0 |
| Is the summary faithful? | Not measured | Deterministic contract checks plus a calibrated judge on faithfulness and coverage |
| Which model should run this task? | Cannot be asked — one `LLM_MODEL` | Ranked slate per task, gated on quality, ordered by latency within tie groups |

MemoryApi's evaluators tell you *that* something is wrong. LMEval tells you *which case, which label, and whether the difference is real* — the only form of feedback a prompt can actually be rewritten from.

## Findings

### 01 — The tagging prompt teaches the wrong answer for a memory you already labeled

`tagging.txt` example 16 and seed memory 5 are the same sentence, character for character, with different answers. The prompt's answer uses a tag that is not in the 61-tag vocabulary.

| | Input | Tags |
|---|---|---|
| `tagging.txt` ex. 16 | `"My favorite cuisine is Mexican."` | `Personal, Food` — `Personal` ∉ `allTags.json` |
| `seedMemories.json` #5 | `"My favorite cuisine is Mexican."` | `Food, Favorite` |

The model is shown, in its own instructions, that the correct answer to this exact input is an invalid tag plus a missing one. Whatever the retry filter salvages afterwards, the prompt is working against the taxonomy.

### 02 — The same collision on the Orlando conference

| | Input | Tags |
|---|---|---|
| `tagging.txt` ex. 12 | `"Traveled to Orlando in 2025 for a conference."` | `Travel, Work, Archive` — `Archive` ∉ `allTags.json` |
| `seedMemories.json` #4 | `"I went to the VSLive conference in 2025 in Orlando."` | `Work, Travel` |

`Archive` also appears in example 19. Two of the prompt's twenty-two examples are near-verbatim seed memories with wrong answers attached — which is additionally pre-existing few-shot leakage, since both plans forbid benchmark cases appearing verbatim in a prompt.

### 03 — MemoryApi and LMEval disagree about Orlando

| | Input | Category |
|---|---|---|
| LMEval `classification.json` | `"Traveled to Orlando in 2025 for a conference"` | `History` |
| `seedMemories.json` #4 | `"I went to the VSLive conference in 2025 in Orlando."` | `Event` |

Same city, same year, same conference framing, opposite labels. Neither is obviously wrong, which is the point: until the annotation guide fixes the Event/History rule and both sides derive from it, an evaluation of this boundary measures whose file was read last.

### 04 — The Preference/History boundary is real, and nobody listed it

Seed memory 9 — *"I have been a computer geek since childhood… learned my first programming languages such as C++, C#, JavaScript, and HTML. I no longer use C++…"* — is labeled `Preference`, tagged `Programming, Learning, Career`.

By the refined definitions it reads as `History`: durable autobiographical background, a longer-lived period, education. Both plans enumerate four boundary pairs — Event/History, Note/Snippet, Prompt/Idea, Reminder/Note. Preference/History is not among them, and it is sitting in the seed data with a debatable label on it.

### 05 — That memory's own description drops its most important fact

| | Content |
|---|---|
| Description as stored | `"Personal interest in technology and programming background"` |
| What the content says | C++, C#, JavaScript, HTML learned; **"I no longer use C++"**; still uses the others |

Every named technology and the one negation are gone. This is exactly the failure the revised summary prompt must prevent — preserve negation and temporal state, retain retrieval-critical technologies — demonstrated in the curated corpus rather than hypothetically. It makes an excellent regression case, and it means the hand-written descriptions cannot serve as reference summaries without review.

### 06 — Descriptions are written in three incompatible styles

| Style | Example | Problem |
|---|---|---|
| Standalone summary | `"I'm not a fan of cooking due to its time-consuming nature…"` | The intended target |
| Terse label | `"Cuisine preference"` | Contains neither "Mexican" nor "food" |
| Verbatim copy | `"I went to the VSLive conference in 2025 in Orlando."` | Identical to content — zero compression |

Seeding uses `memory.Description` when present and only falls back to the model (`memoryRAGSystem.ts:131–133`), so these are the de facto reference summaries — encoding three different rubrics. A judge scored against them is scoring against a coin flip. Normalizing them to one style is the highest-value data task before any summarization evaluation runs.

### 07 — A tagger that only ever says "Favorite" scores well here

`Favorite` carries 14 of 26 memories and 19% of all tag assignments. The six media entries are near-identical two-tag patterns. Thirty-six of the 61 tags never appear.

Tag frequency across all 73 assignments:

```
Favorite            ██████████████  14
Productivity        ███████          7
Programming         ██████           6
Utility             █████            5
Software            █████            5
Tip                 ████             4
Generative AI       ████             4
Prompt Engineering  ███              3
Shortcut            ███              3
Movie               ███              3
TV Show             ███              3
(14 more tags appear once or twice)
(36 of 61 tags unused: Family, Plan, Summary, To Do, Watch Later,
 Design, Shopping, Video Game, …)
```

This is concrete evidence for a rule both plans state but neither justifies: the seed corpus cannot be the benchmark. A model that learned nothing but "preference-shaped text gets Favorite" would post a respectable overlap score against it. It is also why the eval plan reports recall by tag group — per-tag recall on this corpus takes three possible values.

### 08 — The summary never reaches the embedding

| | |
|---|---|
| `memory_summary.txt` claims | "…for use as an effective content description in a **vector database and semantic search**" |
| `memoryRAGSystem.ts:246` | `generateEmbedding(memory.Content)` |

Retrieval embeds raw content. Line 244 logs the description while line 246 embeds the content, so the log is also misleading. The description is stored in the Qdrant payload and injected into the post-search aggregator's context blocks *alongside* the content (`memoryPostSearchAggregator.ts:409, 482, 580`). The summary's real job is context compression for the aggregation stage that feeds other LLMs, under real character budgets.

That reframes the evaluation: a "retrieval utility" judge dimension measures something the pipeline does not do, while the job the summary actually performs goes unmeasured. Seed memory 4, whose description is a verbatim copy of its content, is duplicated tokens in every aggregation prompt it appears in.

Decide which behavior is wanted — embed the description, or rewrite the prompt around aggregation-context compression — and make the prompt, the code, and the rubric agree.

## Prompt changes worth making first

Ordered by evidence strength. The first three are corrections to demonstrated errors and do not need an evaluation to justify them.

### Rx 01 — `tagging.txt`: replace the contradicted examples

```text
16. Memory: "My favorite cuisine is Mexican."
    Tags: Food, Favorite

12. Memory: "Traveled to Orlando in 2025 for a conference."
    Tags: Travel, Work

19. Memory: "Completed UX design course in 2022."
    Tags: UX, Learning
```

Removes both invalid tags (`Archive`, `Personal`) and aligns the examples with the curated labels. Then replace all four seed-derived examples with content that does not appear in any dataset split, so the leakage lint passes.

### Rx 02 — `tagging.txt`: state the Favorite rule

```text
Favorite marks a specific named thing the user likes best
in its class — a film, a tool, a language, a cuisine.
Do not apply it to a general habit or working style.

  "My favorite cuisine is Mexican."     → Food, Favorite
  "I prefer working in the afternoons." → Productivity
```

The corpus already applies exactly this distinction — 14 named favorites carry the tag, the afternoon-working preference does not — but the rule appears in neither the prompt nor the guide, so it reads as inconsistency. Writing it down converts the most-used tag from a coin flip into a testable rule.

### Rx 03 — `categorization.txt`: add the fifth boundary

```text
Preference vs History:
  A stable current like, dislike, or way of working
    → Preference
  Durable background: how the user got here, what they
  once did, what they no longer do
    → History

  "My favorite programming language is C#"  → Preference
  "I learned C++, C#, and JavaScript as a kid
   and no longer use C++"                   → History
```

Add it to the tie-breaker list, then re-adjudicate seed memory 9 against the written rule and fix its label. A boundary case sitting in the ground truth with the wrong label poisons every metric computed from it.

### Rx 04 — `memory_summary.txt`: say what the summary is for

The current one-line prompt names a purpose the pipeline does not serve. Whichever direction finding 08 is resolved, the prompt should state the real job and the real constraints: preserve named technologies, people, dates and quantities; preserve negation and temporal state; never restate the content verbatim; no lead-in phrases; output the summary only.

Seed memory 9 is the test — a correct summary keeps C#, JavaScript and HTML *and* the fact that C++ was dropped.

### Rx 05 — normalize the 26 descriptions to one style

Rewrite every description as a standalone sentence naming the subject and its distinguishing fact. "Cuisine preference" becomes something a semantic query for *what food does the user like* can land on. This is an afternoon of editing and it is the prerequisite for every summarization number that follows.

## Running the loop

1. **Sweep models on the prompt you have.** Before touching prompt text, run the current prompts across the candidate models. Cheapest experiment available; sets the ceiling you are writing against, and may show a task that needs no prompt work at all.
2. **Read the confusion matrix before writing rules.** The five boundary pairs are hypotheses about where models get confused. The matrix says which ones actually happen. Prompt text spent on a boundary the model already handles is context budget spent on nothing.
3. **Iterate prompts on the calibration split only.** Fix the incumbent model, vary the wording, keep the regression split sealed — exposing it to iteration turns the promotion gate into a training target.
4. **Then pick the model, then confirm the pairing.** Fix the promoted prompt, rank the model slate, re-run the prompt comparison on the winner. A prompt tuned on one model does not automatically transfer.
5. **Reproduce it here before believing it.** Run the winner through MemoryApi's own raw evaluator with `MEMORY_DATA_ENV=test`, and measure end-to-end ingestion latency. A gap between LMEval's number and this one is a transport or parameter parity defect, and finding it is worth more than the recommendation was.
6. **Harvest corrections from the review UI.** Every time a human fixes an auto-assigned category or tag set before promoting a draft, that is a labeled model-versus-human disagreement drawn from the real input distribution. Capture the before/after pair and route it into the candidate dataset.

Step 6 is what makes this compound. The seed corpus is 26 memories written in one sitting; the review queue produces cases nobody would have thought to write, indefinitely.
