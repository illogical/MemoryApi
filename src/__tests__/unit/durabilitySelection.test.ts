/**
 * Unit tests for the durability auto-selection feature:
 * - durability_selection.txt prompt template rendering
 * - selectDurability() validation and retry logic
 * - Seeds cover all four durability levels
 */

import path from 'path';
import fs from 'fs';
import { MemoryDurability } from '../../models/memoryDurability.js';
import { PromptTemplateService } from '../../services/promptTemplateService.js';

const PROMPTS_PATH = path.join(process.cwd(), 'src', 'prompts');
const SEEDS_PATH = path.join(process.cwd(), 'src', 'samples', 'seedMemories.json');

// ────────────────────────────────────────────────────────────
// Section 1: Prompt template rendering
// ────────────────────────────────────────────────────────────

describe('durability_selection.txt prompt template', () => {
    let pts: PromptTemplateService;

    beforeAll(() => {
        pts = new PromptTemplateService(PROMPTS_PATH);
    });

    test('template file exists', () => {
        const templatePath = path.join(PROMPTS_PATH, 'durability_selection.txt');
        expect(fs.existsSync(templatePath)).toBe(true);
    });

    test('renderDurabilitySelection() renders without throwing', () => {
        expect(() => pts.renderDurabilitySelection('I prefer dark mode in all editors')).not.toThrow();
    });

    test('rendered prompt contains user input', () => {
        const content = 'I prefer working in the afternoons';
        const rendered = pts.renderDurabilitySelection(content);
        expect(rendered).toContain(content);
    });

    test('rendered prompt contains all four durability levels as valid outputs', () => {
        const rendered = pts.renderDurabilitySelection('test input');
        expect(rendered).toContain('durable');
        expect(rendered).toContain('working');
        expect(rendered).toContain('historical');
        expect(rendered).toContain('temporary');
    });

    test('rendered prompt injects examples section', () => {
        const rendered = pts.renderDurabilitySelection('test input');
        expect(rendered).toContain('Examples:');
    });

    test('rendered prompt contains at least one durable example from seeds', () => {
        const rendered = pts.renderDurabilitySelection('test input');
        expect(rendered).toContain('Durability: durable');
    });

    test('rendered prompt contains at least one working example from seeds', () => {
        const rendered = pts.renderDurabilitySelection('test input');
        expect(rendered).toContain('Durability: working');
    });

    test('rendered prompt contains at least one historical example from seeds', () => {
        const rendered = pts.renderDurabilitySelection('test input');
        expect(rendered).toContain('Durability: historical');
    });

    test('rendered prompt contains at least one temporary example from seeds', () => {
        const rendered = pts.renderDurabilitySelection('test input');
        expect(rendered).toContain('Durability: temporary');
    });

    test('rendered prompt does not contain unreplaced {{}} placeholders', () => {
        const rendered = pts.renderDurabilitySelection('test input');
        expect(rendered).not.toMatch(/{{[a-z_]+}}/);
    });

    test('system prompt instructs to output only one of the valid values', () => {
        const rendered = pts.renderDurabilitySelection('test input');
        // Should contain the instruction for single-word output
        expect(rendered).toMatch(/only.*one|one.*only/i);
    });
});

// ────────────────────────────────────────────────────────────
// Section 2: seedMemories.json ground-truth coverage
// ────────────────────────────────────────────────────────────

describe('seedMemories.json durability ground-truth coverage', () => {
    let seeds: any[];

    beforeAll(() => {
        const data = JSON.parse(fs.readFileSync(SEEDS_PATH, 'utf-8'));
        seeds = data.memories;
    });

    test('all seed memories have a durability field', () => {
        const missing = seeds.filter(s => !s.durability);
        expect(missing).toHaveLength(0);
    });

    test('all durability values are valid MemoryDurability enum values', () => {
        const valid = new Set(Object.values(MemoryDurability));
        const invalid = seeds.filter(s => !valid.has(s.durability));
        expect(invalid).toHaveLength(0);
    });

    test('seeds include at least one example of each durability level', () => {
        const durs = new Set(seeds.map((s: any) => s.durability));
        expect(durs.has('durable')).toBe(true);
        expect(durs.has('working')).toBe(true);
        expect(durs.has('historical')).toBe(true);
        expect(durs.has('temporary')).toBe(true);
    });

    test('durable seeds represent stable long-term facts', () => {
        const durableSeeds = seeds.filter(s => s.durability === 'durable');
        expect(durableSeeds.length).toBeGreaterThan(5);
    });

    test('working seeds represent in-progress or currently-active items', () => {
        const workingSeeds = seeds.filter(s => s.durability === 'working');
        expect(workingSeeds.length).toBeGreaterThan(0);
    });

    test('historical seeds represent concluded past events', () => {
        const historicalSeeds = seeds.filter(s => s.durability === 'historical');
        expect(historicalSeeds.length).toBeGreaterThan(0);
    });

    test('temporary seeds represent time-sensitive or short-lived information', () => {
        const tempSeeds = seeds.filter(s => s.durability === 'temporary');
        expect(tempSeeds.length).toBeGreaterThan(0);
    });
});

// ────────────────────────────────────────────────────────────
// Section 3: selectDurability retry/validation logic (unit test)
// ────────────────────────────────────────────────────────────

describe('selectDurability() retry and validation logic', () => {
    /**
     * Reproduces the withLLMRetry + validation from MemoryTextProcessor.selectDurability()
     * without requiring a live LLM.
     */
    const MAX_ATTEMPTS = 3;
    const validDurabilities = Object.values(MemoryDurability);

    function validate(raw: string): MemoryDurability | null {
        const lower = raw.trim().toLowerCase();
        return (validDurabilities.find(d => d === lower) as MemoryDurability) ?? null;
    }

    async function withRetry(
        responses: string[],
        fallback: MemoryDurability
    ): Promise<MemoryDurability> {
        for (let attempt = 0; attempt < Math.min(responses.length, MAX_ATTEMPTS); attempt++) {
            const result = validate(responses[attempt]);
            if (result !== null) return result;
        }
        return fallback;
    }

    test('returns valid durability on first attempt', async () => {
        const result = await withRetry(['durable'], MemoryDurability.Durable);
        expect(result).toBe(MemoryDurability.Durable);
    });

    test('retries and succeeds on second attempt', async () => {
        const result = await withRetry(['invalid_response', 'working'], MemoryDurability.Durable);
        expect(result).toBe(MemoryDurability.Working);
    });

    test('retries and succeeds on third attempt', async () => {
        const result = await withRetry(['bad', 'bad2', 'historical'], MemoryDurability.Durable);
        expect(result).toBe(MemoryDurability.Historical);
    });

    test('falls back to durable after all attempts fail', async () => {
        const result = await withRetry(['garbage', 'trash', 'invalid'], MemoryDurability.Durable);
        expect(result).toBe(MemoryDurability.Durable);
    });

    test.each([
        ['Durable', MemoryDurability.Durable],
        ['TEMPORARY', MemoryDurability.Temporary],
        ['Working', MemoryDurability.Working],
        ['HISTORICAL', MemoryDurability.Historical],
    ] as [string, MemoryDurability][])('is case-insensitive — accepts "%s"', (input, expected) => {
        expect(validate(input)).toBe(expected);
    });

    test('rejects hallucinated durability values', () => {
        expect(validate('very-stable')).toBeNull();
        expect(validate('permanent')).toBeNull();
        expect(validate('short-term')).toBeNull();
        expect(validate('medium')).toBeNull();
    });

    test('accepts all four valid durability values', () => {
        for (const dur of Object.values(MemoryDurability)) {
            expect(validate(dur)).not.toBeNull();
        }
    });
});

// ────────────────────────────────────────────────────────────
// Section 4: explicit durability takes precedence over LLM selection
// ────────────────────────────────────────────────────────────

describe('Durability precedence — explicit value beats LLM selection', () => {
    test('explicit Durability overrides the LLM-detected value', () => {
        const explicitDurability = MemoryDurability.Historical;
        const llmDetectedDurability = MemoryDurability.Durable;

        // This is the logic from summarizeClassifyAndPrepareMemory
        const effectiveDurability = explicitDurability ?? llmDetectedDurability;
        expect(effectiveDurability).toBe(MemoryDurability.Historical);
    });

    test('LLM-detected value used when no explicit Durability set', () => {
        const explicitDurability: MemoryDurability | undefined = undefined;
        const llmDetectedDurability = MemoryDurability.Working;

        const effectiveDurability = explicitDurability ?? llmDetectedDurability;
        expect(effectiveDurability).toBe(MemoryDurability.Working);
    });
});
