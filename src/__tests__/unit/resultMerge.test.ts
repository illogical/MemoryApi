import { mergeVectorAndGraphResults } from '../../utils/resultMerge.js';
import { MemoryWithId } from '../../models/memory.js';
import { GraphResult } from '../../services/memoryPostSearchAggregator.js';

function makeVector(id: string, score: number): MemoryWithId {
    return { id, Content: `content-${id}`, LastUpdated: '', score };
}

function makeGraph(id: string, score: number): GraphResult {
    return { memory: { id, Content: `content-${id}`, LastUpdated: '' }, score };
}

const DEFAULT_OPTS = { limit: 10, scoreThreshold: 0 };

describe('mergeVectorAndGraphResults', () => {
    test('returns empty array when both inputs are empty', () => {
        expect(mergeVectorAndGraphResults([], [], DEFAULT_OPTS)).toEqual([]);
    });

    test('returns vector results when graph is empty', () => {
        const result = mergeVectorAndGraphResults(
            [makeVector('a', 0.9), makeVector('b', 0.7)],
            [],
            DEFAULT_OPTS
        );
        expect(result.map(r => r.id)).toEqual(['a', 'b']);
    });

    test('returns graph results (normalized) when vector is empty', () => {
        const result = mergeVectorAndGraphResults(
            [],
            [makeGraph('x', 10), makeGraph('y', 5)],
            DEFAULT_OPTS
        );
        expect(result.map(r => r.id)).toEqual(['x', 'y']);
        // x: 10/10 = 1.0; y: 5/10 = 0.5
        expect(result[0].score).toBeCloseTo(1.0);
        expect(result[1].score).toBeCloseTo(0.5);
    });

    test('deduplicates memory that appears in both vector and graph', () => {
        const result = mergeVectorAndGraphResults(
            [makeVector('shared', 0.8)],
            [makeGraph('shared', 10)],
            DEFAULT_OPTS
        );
        expect(result).toHaveLength(1);
        expect(result[0].id).toBe('shared');
    });

    test('merged score for shared memory is average of vector and normalized graph', () => {
        // vector=0.8, graph=10, maxGraph=10 → normalized=1.0 → merged = 0.8*0.5 + 1.0*0.5 = 0.9
        const result = mergeVectorAndGraphResults(
            [makeVector('a', 0.8)],
            [makeGraph('a', 10)],
            DEFAULT_OPTS
        );
        expect(result[0].score).toBeCloseTo(0.9);
    });

    test('results sorted by merged score descending', () => {
        const result = mergeVectorAndGraphResults(
            [makeVector('low', 0.2), makeVector('high', 0.9)],
            [],
            DEFAULT_OPTS
        );
        expect(result[0].id).toBe('high');
        expect(result[1].id).toBe('low');
    });

    test('score threshold filters out low-scoring results', () => {
        const result = mergeVectorAndGraphResults(
            [makeVector('a', 0.8), makeVector('b', 0.3)],
            [],
            { limit: 10, scoreThreshold: 0.5 }
        );
        expect(result.map(r => r.id)).toEqual(['a']);
    });

    test('limit caps the number of returned results', () => {
        const vectors = ['a', 'b', 'c', 'd', 'e'].map((id, i) =>
            makeVector(id, 1 - i * 0.1)
        );
        const result = mergeVectorAndGraphResults(vectors, [], { limit: 3, scoreThreshold: 0 });
        expect(result).toHaveLength(3);
    });

    test('graph-only entry has normalized score based on max graph score', () => {
        const result = mergeVectorAndGraphResults(
            [],
            [makeGraph('a', 6), makeGraph('b', 3)],
            DEFAULT_OPTS
        );
        // maxGraph=6; a: 6/6=1.0; b: 3/6=0.5
        expect(result[0].score).toBeCloseTo(1.0);
        expect(result[1].score).toBeCloseTo(0.5);
    });

    test('does not mutate original memory objects', () => {
        const original = makeVector('a', 0.8);
        mergeVectorAndGraphResults([original], [], DEFAULT_OPTS);
        expect(original.score).toBe(0.8); // spread creates new object
    });
});
