/**
 * Standalone LLM utility functions extracted from MemoryTextProcessor.
 * These are pure / near-pure helpers suitable for unit testing without mocking a full service.
 */

const MAX_LLM_ATTEMPTS = 3;

/**
 * Calls `call()` up to `maxAttempts` times, returning the first non-null result from `validate`.
 * If all attempts fail validation, returns null.
 * Re-throws immediately if `call()` itself throws (network-level or non-validation errors).
 */
export async function withLLMRetry<T>(
    call: () => Promise<string>,
    validate: (raw: string, attempt: number) => T | null,
    maxAttempts: number = MAX_LLM_ATTEMPTS
): Promise<T | null> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const raw = await call();
        const result = validate(raw, attempt);
        if (result !== null) return result;
    }
    return null;
}

/**
 * Filters raw LLM-output tags against an allowed set (case-insensitive).
 * Returns the canonical forms from `allowedTags` for matched entries.
 *
 * @param rawTags   Comma-separated tag string from the LLM
 * @param allowedTags  Full list of allowed tag strings (canonical casing)
 */
export function filterValidTags(
    rawTags: string,
    allowedTags: string[]
): { valid: string[]; discarded: string[] } {
    const allowedMap = new Map(allowedTags.map(t => [t.toLowerCase(), t]));
    const valid: string[] = [];
    const discarded: string[] = [];

    for (const tag of rawTags.split(',').map(t => t.trim()).filter(t => t.length > 0)) {
        const canonical = allowedMap.get(tag.toLowerCase());
        if (canonical && !valid.includes(canonical)) {
            valid.push(canonical);
        } else if (!canonical) {
            discarded.push(tag);
        }
    }

    return { valid, discarded };
}
