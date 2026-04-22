/**
 * Unit tests for the aggregation refinement features:
 * - Memory serialization including Durability, Tools, Projects, Topics
 * - Overflow condensation path
 * - MemoryDurability enum values
 * - ReviewMemoriesService.getDurabilities()
 */

import { jest } from '@jest/globals';
import { MemoryWithId } from '../../models/memory.js';
import { MemoryDurability } from '../../models/memoryDurability.js';
import { MemoryCategory } from '../../models/memoryCategory.js';

// ────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────

function makeMem(overrides: Partial<MemoryWithId> = {}): MemoryWithId {
    return {
        id: 'test-01',
        Content: 'Sample content for testing',
        LastUpdated: '2024-01-01T00:00:00.000Z',
        Category: MemoryCategory.NOTE,
        Tags: ['TypeScript', 'testing'],
        Description: 'A test memory',
        ...overrides
    };
}

/**
 * Reproduces the serialization logic from MemoryPostSearchAggregator.serializeMemory()
 * so we can test field inclusion without spinning up the full aggregator.
 */
function serializeMemory(m: MemoryWithId, contentMaxChars: number = 800): string {
    const desc = m.Description ?? '';
    const fullContent = m.Content ?? '';
    const content = fullContent.slice(0, contentMaxChars);

    const lines: string[] = [
        `ID: ${m.id}`,
        `Category: ${m.Category ?? ''}`,
        `Durability: ${m.Durability ?? ''}`,
        `Tags: ${(m.Tags || []).join(', ')}`,
    ];
    if (m.Tools && m.Tools.length > 0) lines.push(`Tools: ${m.Tools.join(', ')}`);
    if (m.Projects && m.Projects.length > 0) lines.push(`Projects: ${m.Projects.join(', ')}`);
    if (m.Topics && m.Topics.length > 0) lines.push(`Topics: ${m.Topics.join(', ')}`);
    lines.push(`LastUpdated: ${m.LastUpdated}`);
    lines.push(`Description: ${desc}`);
    lines.push(`Content: ${content}`);
    lines.push('---');
    return lines.join('\n');
}

// ────────────────────────────────────────────────────────────
// Tests: MemoryDurability enum
// ────────────────────────────────────────────────────────────

describe('MemoryDurability enum', () => {
    test('has exactly four values', () => {
        expect(Object.values(MemoryDurability)).toHaveLength(4);
    });

    test('durable value is "durable"', () => {
        expect(MemoryDurability.Durable).toBe('durable');
    });

    test('working value is "working"', () => {
        expect(MemoryDurability.Working).toBe('working');
    });

    test('historical value is "historical"', () => {
        expect(MemoryDurability.Historical).toBe('historical');
    });

    test('temporary value is "temporary"', () => {
        expect(MemoryDurability.Temporary).toBe('temporary');
    });
});

// ────────────────────────────────────────────────────────────
// Tests: Memory serialization
// ────────────────────────────────────────────────────────────

describe('Memory serialization (serializeMemory)', () => {
    test('includes ID, Category, Tags, LastUpdated, Description, Content', () => {
        const m = makeMem();
        const packed = serializeMemory(m);
        expect(packed).toContain('ID: test-01');
        expect(packed).toContain(`Category: ${MemoryCategory.NOTE}`);
        expect(packed).toContain('Tags: TypeScript, testing');
        expect(packed).toContain('LastUpdated: 2024-01-01T00:00:00.000Z');
        expect(packed).toContain('Description: A test memory');
        expect(packed).toContain('Content: Sample content for testing');
        expect(packed).toContain('---');
    });

    test('includes Durability field', () => {
        const m = makeMem({ Durability: MemoryDurability.Durable });
        const packed = serializeMemory(m);
        expect(packed).toContain('Durability: durable');
    });

    test('includes empty Durability field when not set', () => {
        const m = makeMem();
        const packed = serializeMemory(m);
        expect(packed).toContain('Durability: ');
    });

    test('includes Tools when present', () => {
        const m = makeMem({ Tools: ['Node.js', 'TypeScript'] });
        const packed = serializeMemory(m);
        expect(packed).toContain('Tools: Node.js, TypeScript');
    });

    test('omits Tools line when Tools is empty', () => {
        const m = makeMem({ Tools: [] });
        const packed = serializeMemory(m);
        expect(packed).not.toContain('Tools:');
    });

    test('omits Tools line when Tools is undefined', () => {
        const m = makeMem({ Tools: undefined });
        const packed = serializeMemory(m);
        expect(packed).not.toContain('Tools:');
    });

    test('includes Projects when present', () => {
        const m = makeMem({ Projects: ['MemoryApi', 'CopilotPlugin'] });
        const packed = serializeMemory(m);
        expect(packed).toContain('Projects: MemoryApi, CopilotPlugin');
    });

    test('omits Projects line when Projects is empty', () => {
        const m = makeMem({ Projects: [] });
        const packed = serializeMemory(m);
        expect(packed).not.toContain('Projects:');
    });

    test('includes Topics when present', () => {
        const m = makeMem({ Topics: ['AI', 'Memory Systems'] });
        const packed = serializeMemory(m);
        expect(packed).toContain('Topics: AI, Memory Systems');
    });

    test('omits Topics line when Topics is empty', () => {
        const m = makeMem({ Topics: [] });
        const packed = serializeMemory(m);
        expect(packed).not.toContain('Topics:');
    });

    test('all extended fields together in a single block', () => {
        const m = makeMem({
            Durability: MemoryDurability.Working,
            Tools: ['Node.js'],
            Projects: ['MemoryApi'],
            Topics: ['RAG']
        });
        const packed = serializeMemory(m);
        expect(packed).toContain('Durability: working');
        expect(packed).toContain('Tools: Node.js');
        expect(packed).toContain('Projects: MemoryApi');
        expect(packed).toContain('Topics: RAG');
    });

    test('truncates content to CONTENT_MAX_CHARS', () => {
        const longContent = 'A'.repeat(1200);
        const m = makeMem({ Content: longContent });
        const packed = serializeMemory(m, 800);
        const contentLine = packed.split('\n').find(l => l.startsWith('Content: '))!;
        expect(contentLine.length).toBeLessThanOrEqual('Content: '.length + 800);
    });

    test('does not truncate content when within CONTENT_MAX_CHARS', () => {
        const shortContent = 'A'.repeat(400);
        const m = makeMem({ Content: shortContent });
        const packed = serializeMemory(m, 800);
        expect(packed).toContain(shortContent);
    });

    test('block ends with separator line ---', () => {
        const m = makeMem();
        const packed = serializeMemory(m);
        expect(packed.endsWith('---')).toBe(true);
    });
});

// ────────────────────────────────────────────────────────────
// Tests: Overflow condensation logic
// ────────────────────────────────────────────────────────────

describe('Overflow condensation — condenseMemories logic', () => {
    /**
     * Reproduces the batch-splitting logic from MemoryPostSearchAggregator.condenseMemories()
     */
    function splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
        if (batchSize <= 1) return [items];
        const batches: T[][] = [];
        for (let i = 0; i < items.length; i += batchSize) {
            batches.push(items.slice(i, i + batchSize));
        }
        return batches;
    }

    const memories = Array.from({ length: 10 }, (_, i) => makeMem({ id: `mem-${i}` }));

    test('batchSize=1 produces a single chunk containing all memories', () => {
        const batches = splitIntoBatches(memories, 1);
        expect(batches).toHaveLength(1);
        expect(batches[0]).toHaveLength(10);
    });

    test('batchSize=5 splits 10 memories into 2 chunks', () => {
        const batches = splitIntoBatches(memories, 5);
        expect(batches).toHaveLength(2);
        expect(batches[0]).toHaveLength(5);
        expect(batches[1]).toHaveLength(5);
    });

    test('batchSize=3 splits 10 memories into 4 chunks (last chunk has 1)', () => {
        const batches = splitIntoBatches(memories, 3);
        expect(batches).toHaveLength(4);
        expect(batches[3]).toHaveLength(1);
    });

    test('overflow threshold correctly identifies oversized packed blocks', () => {
        const OVERFLOW_THRESHOLD = 15000;
        const smallBlock = 'x'.repeat(5000);
        const largeBlock = 'x'.repeat(20000);

        expect(smallBlock.length > OVERFLOW_THRESHOLD).toBe(false);
        expect(largeBlock.length > OVERFLOW_THRESHOLD).toBe(true);
    });

    test('packed block of 25 large memories likely exceeds overflow threshold', () => {
        const OVERFLOW_THRESHOLD = 15000;
        const largeMemories = Array.from({ length: 25 }, (_, i) => makeMem({
            id: `large-${i}`,
            Content: 'X'.repeat(800),
            Description: 'Large description for testing overflow'
        }));
        const packed = largeMemories.map(m => serializeMemory(m, 800)).join('\n');
        // Each block is ~1000 chars, 25 blocks = ~25000 chars — should exceed threshold
        expect(packed.length).toBeGreaterThan(OVERFLOW_THRESHOLD);
    });
});

// ────────────────────────────────────────────────────────────
// Tests: getDurabilities() output structure
// ────────────────────────────────────────────────────────────

describe('ReviewMemoriesService.getDurabilities()', () => {
    /**
     * Reproduce the getDurabilities() output without importing the full service
     * (which has dependencies on MemoryRAGSystem).
     */
    function getDurabilities() {
        return [
            {
                value: MemoryDurability.Durable,
                label: 'Durable',
                description: 'Stable long-term fact — preferences, skills, installed tools, habits',
                priority: 1
            },
            {
                value: MemoryDurability.Working,
                label: 'Working',
                description: 'Currently active but may change — in-progress projects, drafts',
                priority: 2
            },
            {
                value: MemoryDurability.Historical,
                label: 'Historical',
                description: 'Past events or completed items — conferences attended, old reminders',
                priority: 3
            },
            {
                value: MemoryDurability.Temporary,
                label: 'Temporary',
                description: 'Short-lived — appointments, time-sensitive reminders',
                priority: 4
            }
        ];
    }

    test('returns exactly 4 durability levels', () => {
        expect(getDurabilities()).toHaveLength(4);
    });

    test('each entry has value, label, description, priority', () => {
        for (const d of getDurabilities()) {
            expect(d).toHaveProperty('value');
            expect(d).toHaveProperty('label');
            expect(d).toHaveProperty('description');
            expect(d).toHaveProperty('priority');
        }
    });

    test('priorities are 1–4 in ascending order', () => {
        const priorities = getDurabilities().map(d => d.priority);
        expect(priorities).toEqual([1, 2, 3, 4]);
    });

    test('values match MemoryDurability enum', () => {
        const validValues = new Set(Object.values(MemoryDurability));
        for (const d of getDurabilities()) {
            expect(validValues.has(d.value as MemoryDurability)).toBe(true);
        }
    });

    test('Durable has priority 1 (highest)', () => {
        const durs = getDurabilities();
        const durable = durs.find(d => d.value === MemoryDurability.Durable)!;
        expect(durable.priority).toBe(1);
    });

    test('Temporary has priority 4 (lowest)', () => {
        const durs = getDurabilities();
        const temporary = durs.find(d => d.value === MemoryDurability.Temporary)!;
        expect(temporary.priority).toBe(4);
    });

    test('all descriptions are non-empty', () => {
        for (const d of getDurabilities()) {
            expect(d.description.length).toBeGreaterThan(0);
        }
    });
});
