# LMEval Transport Parity — Handoff Notes

**Status:** Addendum, 2026-09-04. Not a standalone implementation plan — see
`docs/plans/2026-09-03-ingestion-prompt-refinement.md` in this repo for the actual proposed fix
(TaskModelConfig per task, `LMApiClient` moving to structured chat messages, snapshot export).
This doc exists only to record precisely what LMEval needs from that plan so the two don't drift
apart when someone implements it.

**Target repository:** MemoryApi (this repository)
**Requested by:** LMEval — see `C:\LocalDev\Projects\LMEval\docs\TASK.md` Track A2 and the
cross-project review at
`C:\LocalDev\Projects\LMEval\docs\plans\2026-09-04-ingestion-eval-alignment-review.md`.

## The gap this addresses

LMEval measures prompts by posting structured `messages: [{role:'system',...},
{role:'user',...}]` to a chat-completions-shaped endpoint
(`PromptfooAdapter.buildLmapiProvider()`). MemoryApi's `LMApiClient.respond()`
(`src/services/modelClients.ts:227-241`) flattens the same two messages into one
`ROLE: content\n\nROLE: content` string and posts it as `prompt` to `/api/generate/any`. A prompt
that wins in LMEval today is not the prompt MemoryApi actually executes in production. Until this
closes, no LMEval measurement is a valid production-parity result for promotion.

## What LMEval needs from the eventual fix

1. **Message shape.** Once `LMApiClient` moves off flattening, it should post the same
   `messages: [system, user]` structure LMEval already sends — no reordering, no additional
   messages, no re-flattening at a different layer. This is a hard requirement for parity, not a
   preference.

2. **Production parameter values, preserved exactly.** Confirmed against
   `src/services/memoryTextProcessor.ts`:
   - `summarizeText` (line 30): `temperature: 0.3, maxTokens: 150`
   - `classifyText` (line 46): `temperature: 0.3, maxTokens: 50`
   - `tagText` (line 77): `temperature: 0.3, maxTokens: 100`
   - `extractEntities` (line 203, unrelated to the three ingestion tasks): `temperature: 0.1, maxTokens: 200`

   Whatever `TaskModelConfig` shape the refinement plan lands on, these are the values a strict
   LMEval production-parity run will pass in per-run to override its own generous defaults
   (LMEval's built-in purpose templates default to `temperature 0.3` / `maxTokens 1000` — the
   temperature matches production deliberately, but `maxTokens` is intentionally *not* mirrored,
   since a thin default ceiling turns an ordinary LMEval tuning run into a silent-truncation
   false failure). A parity run needs these exact numbers available to plug in, not re-derived.

3. **The `<memory>` delimiter wrapper convention**, exactly as production sends it — including the
   escaping rule for a literal closing delimiter inside memory content. Any imported/exported test
   case that will round-trip between MemoryApi and LMEval needs this wrapper preserved byte-for-byte
   inside the user message; a benchmark case that doesn't match production's escaping isn't testing
   what production runs.

4. **A declared message-shape label matching LMEval's vocabulary**, once snapshot export exists.
   LMEval will record `transportProvenance.messageShape: 'chat-messages'` on every evaluation it
   runs (see LMEval's A1 implementation plan). When MemoryApi's snapshot export
   (`memory-eval-snapshot.v1`) ships, it should declare its own message shape using the same two
   values — `'chat-messages'` (post-refactor) or `'flattened-prompt'` (current/legacy) — so LMEval's
   later import guard (Track A10) can mechanically refuse a promotion record built against a
   transport it never actually exercised, rather than relying on a human to notice the mismatch.

## Non-goals of this doc

Does not propose an implementation approach for `TaskModelConfig`, the `LMApiClient` refactor, or
the snapshot exporter — `2026-09-03-ingestion-prompt-refinement.md` already owns that design. This
is scope-narrowing input for whoever implements it, not a competing plan.
