/**
 * Pure function for merging and deduplicating vector + graph search results.
 * Extracted from MemoryPostSearchAggregator for testability.
 */
import { MemoryWithId } from '../models/memory.js';
import { GraphResult } from '../services/memoryPostSearchAggregator.js';

interface MergedResult {
    memory: MemoryWithId;
    vectorScore?: number;
    graphScore?: number;
    mergedScore: number;
    sources: ('vector' | 'graph')[];
}

export interface MergeOptions {
    limit: number;
    scoreThreshold: number;
}

/**
 * Merges vector and graph search results using intelligent deduplication and score normalization.
 *
 * - Deduplicates by memory ID
 * - Normalizes graph scores to 0-1 by dividing by max graph score
 * - Combined score = (vectorScore × 0.5) + (normalizedGraphScore × 0.5)
 * - Filters by scoreThreshold, sorts descending, and caps at limit
 */
export function mergeVectorAndGraphResults(
    vectorResults: MemoryWithId[],
    graphResults: GraphResult[],
    options: MergeOptions
): MemoryWithId[] {
    const { limit, scoreThreshold } = options;
    const memoryMap = new Map<string, MergedResult>();

    // Step 1: Add vector results
    for (const vectorMem of vectorResults) {
        const vectorScore = typeof vectorMem.score === 'number' ? vectorMem.score : 0;
        memoryMap.set(vectorMem.id, {
            memory: vectorMem,
            vectorScore,
            graphScore: undefined,
            mergedScore: vectorScore,
            sources: ['vector'],
        });
    }

    // Step 2: Find max graph score for normalization
    const maxGraphScore =
        graphResults.length > 0 ? Math.max(...graphResults.map(g => g.score)) : 1;

    // Step 3: Merge graph results
    for (const graphResult of graphResults) {
        const graphScore = graphResult.score;
        const memId = graphResult.memory.id;

        if (memoryMap.has(memId)) {
            const existing = memoryMap.get(memId)!;
            existing.graphScore = graphScore;
            existing.sources.push('graph');
            const normalizedGraphScore = graphScore / Math.max(maxGraphScore, 1);
            existing.mergedScore = (existing.vectorScore! * 0.5) + (normalizedGraphScore * 0.5);
        } else {
            const normalizedGraphScore = graphScore / Math.max(maxGraphScore, 1);
            memoryMap.set(memId, {
                memory: graphResult.memory,
                vectorScore: undefined,
                graphScore,
                mergedScore: normalizedGraphScore,
                sources: ['graph'],
            });
        }
    }

    // Step 4: Filter, sort, cap
    return Array.from(memoryMap.values())
        .filter(m => m.mergedScore >= scoreThreshold)
        .sort((a, b) => b.mergedScore - a.mergedScore)
        .slice(0, limit)
        .map(m => ({ ...m.memory, score: m.mergedScore }));
}
