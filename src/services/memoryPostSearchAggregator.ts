import { MemoryCategory } from '../models/memoryCategory';
import { MemoryWithId } from '../models/memory';
import { PromptTemplateService } from './promptTemplateService';
import { LoggingService } from './loggingService';
import { ModelClient } from './modelClients';
import { SqlService } from './sqlService';

// Cluster summary interfaces for category/tag clusters
export interface CategoryClusterSummary {
    key: string;
    type: 'category';
    narrative?: string;
    bullets?: string[];
}

export interface TagClusterSummary {
    key: string;
    type: 'tag';
    narrative?: string;
    bullets?: string[];
}

/**
 * Graph result structure from Neo4j graph traversal.
 * Represents memories found via relationship-based search (shared tags, categories, semantic links).
 * Graph results complement vector results by finding memories through entity relationships
 * rather than semantic similarity, offering different and valuable discovery angles.
 */
export interface GraphResult {
    memory: MemoryWithId;
    score: number; // Relationship strength score (e.g., count of shared tags x2, shared category x1)
    relationshipPath?: string; // Optional: describes how the memory is related (e.g., "shared_tags:memory,project")
}

/**
 * Merged result combining both vector and graph search results.
 * Used internally to track source and enable deduplication across search modalities.
 */
interface MergedResult {
    memory: MemoryWithId;
    vectorScore?: number; // Semantic similarity score (0-1 range typically)
    graphScore?: number; // Graph relationship score (relationship count weighted)
    mergedScore: number; // Combined score after deduplication and normalization
    sources: ('vector' | 'graph')[]; // Which search modalities found this memory
}

/**
 * MemoryPostSearchAggregator
 * Handles post-search aggregation for RAG: summarizing, clustering, and structuring memory search results.
 * This is typically called after semantic search returns top matches.
 */
export class MemoryPostSearchAggregator {
    private getModel: () => ModelClient;
    private promptTemplateService: PromptTemplateService;
    private loggingService: LoggingService;
    private sqlService: SqlService;
    private MAX_CLUSTERS: number;
    private MAX_MEMORIES_PER_CLUSTER: number;

    /**
     * @param loadInferenceModel Function to ensure LLM is loaded
     * @param getModel Function to get loaded LLM instance
     * @param promptTemplateService Service for rendering prompt templates
     * @param loggingService Logging utility
     * @param config Aggregation config knobs
     * @param sqlService SqlService for logging search history
     */
    constructor(
        getModel: () => ModelClient,
        promptTemplateService: PromptTemplateService,
        loggingService: LoggingService,
        config: { MAX_CLUSTERS: number; MAX_MEMORIES_PER_CLUSTER: number },
        sqlService: SqlService
    ) {
        this.getModel = getModel;
        this.promptTemplateService = promptTemplateService;
        this.loggingService = loggingService;
        this.MAX_CLUSTERS = config.MAX_CLUSTERS;
        this.MAX_MEMORIES_PER_CLUSTER = config.MAX_MEMORIES_PER_CLUSTER;
        this.sqlService = sqlService;
    }

    /**
     * Merges vector and graph search results using intelligent deduplication and score normalization.
     * 
     * ALGORITHM:
     * ──────────
     * 1. Build a map of all unique memories (keyed by ID) from both vector and graph results
     * 2. For each unique memory, combine scores from both modalities:
     *    - Keep both vectorScore and graphScore for audit/analysis
     *    - Normalize graphScore to 0-1 range by dividing by maxGraphScore (typically ~10 for tag relationships)
     *    - Calculate mergedScore = (vectorScore × 0.5) + (normalizedGraphScore × 0.5)
     *    - This 50-50 weighting assumes equal importance; adjust for your domain
     * 3. Sort by mergedScore descending, apply scoreThreshold, return top limit results
     * 
     * BENEFITS FOR RAG/MCP:
     * ────────────────────
     * - Eliminates redundancy: same memory won't appear twice
     * - Multi-perspective relevance: memories ranked by both semantic AND relationship signals
     * - Better LLM context: gives the model diverse angles on relevant information
     * - Improved grounding: reduces hallucination by providing cross-validated relevant information
     * 
     * @param vectorResults Semantic search results with scores (0-1 range)
     * @param graphResults Graph relationship results with scores (typically 1-20 range)
     * @param limit Max results after merging
     * @param scoreThreshold Minimum merged score to include (applied after normalization)
     */
    private mergeVectorAndGraphResults(
        vectorResults: MemoryWithId[],
        graphResults: GraphResult[],
        limit: number,
        scoreThreshold: number
    ): MemoryWithId[] {
        this.loggingService.trace('[mergeVectorAndGraphResults] Starting merge');

        // Create a map to track unique memories and aggregate their scores
        const memoryMap = new Map<string, MergedResult>();

        // Step 1: Add vector results
        for (const vectorMem of vectorResults) {
            const vectorScore = typeof vectorMem.score === 'number' ? vectorMem.score : 0;
            memoryMap.set(vectorMem.id, {
                memory: vectorMem,
                vectorScore,
                graphScore: undefined,
                mergedScore: vectorScore, // Initially just vector score
                sources: ['vector']
            });
        }

        // Step 2: Add graph results and merge scores where memories overlap
        // Find the maximum graph score to normalize later
        const maxGraphScore = graphResults.length > 0
            ? Math.max(...graphResults.map(g => g.score))
            : 1; // Avoid division by zero

        for (const graphResult of graphResults) {
            const graphScore = graphResult.score;
            const memId = graphResult.memory.id;

            if (memoryMap.has(memId)) {
                // Merge with existing vector result
                const existing = memoryMap.get(memId)!;
                existing.graphScore = graphScore;
                existing.sources.push('graph');

                // Recalculate mergedScore with both modalities
                // Normalize vector score (already 0-1) and graph score (normalize to 0-1)
                const normalizedGraphScore = graphScore / Math.max(maxGraphScore, 1);
                existing.mergedScore = (existing.vectorScore! * 0.5) + (normalizedGraphScore * 0.5);

                this.loggingService.debug(
                    `[mergeVectorAndGraphResults] Merged memory ${memId}: ` +
                    `vector=${existing.vectorScore!.toFixed(3)} + graph=${graphScore} ` +
                    `=> merged=${existing.mergedScore.toFixed(3)}`
                );
            } else {
                // New memory found only in graph results
                // Normalize graph score to 0-1 range for consistency with vector scores
                const normalizedGraphScore = graphScore / Math.max(maxGraphScore, 1);
                memoryMap.set(memId, {
                    memory: graphResult.memory,
                    vectorScore: undefined,
                    graphScore,
                    mergedScore: normalizedGraphScore, // Graph-only score, normalized
                    sources: ['graph']
                });

                this.loggingService.debug(
                    `[mergeVectorAndGraphResults] New from graph ${memId}: ` +
                    `graph=${graphScore} => merged=${normalizedGraphScore.toFixed(3)}`
                );
            }
        }

        // Step 3: Filter by threshold and sort by mergedScore descending
        const merged = Array.from(memoryMap.values())
            .filter(m => m.mergedScore >= scoreThreshold)
            .sort((a, b) => b.mergedScore - a.mergedScore)
            .slice(0, limit)
            .map(m => {
                // Return the memory with updated score (using merged score)
                return {
                    ...m.memory,
                    score: m.mergedScore // Replace with merged score for downstream consumption
                };
            });

        this.loggingService.debug(
            `[mergeVectorAndGraphResults] Merged ${vectorResults.length} vector + ` +
            `${graphResults.length} graph results => ${merged.length} deduplicated (threshold=${scoreThreshold}, limit=${limit})`
        );

        return merged;
    }

    /**
     * Main entrypoint for post-search aggregation with support for both vector and graph results.
     * 
     * MERGING STRATEGY FOR MCP CONTEXT:
     * For high-quality LLM context in MCP tool calls, we combine vector and graph results to:
     * 
     * 1. SEMANTIC RELEVANCE (Vector Search):
     *    - Vector embeddings capture semantic meaning and conceptual similarity
     *    - Best for finding memories about related topics (e.g., "project management" finds "team coordination")
     *    - Scores represent similarity in semantic space (typically 0-1 range)
     * 
     * 2. RELATIONSHIP RELEVANCE (Graph Search):
     *    - Graph queries find memories connected via structured relationships (shared tags, categories)
     *    - Best for finding memories about specific entities the user is currently working with
     *    - Scores represent relationship strength (count of shared connections, weighted)
     * 
     * 3. DEDUPLICATION & RANKING:
     *    - When same memory appears in both results, we merge scores to avoid redundancy
     *    - Vector score (0-1) is normalized by dividing by max expected graph score (e.g., 10)
     *    - Combined score = (vectorScore × 0.5) + (normalizedGraphScore × 0.5)
     *    - This 50-50 weighting assumes equal importance; adjust based on your use case
     *    - Final ranking: deduplicated memories sorted by merged score (highest first)
     * 
     * 4. PRESENTATION TO LLM:
     *    - Top-N merged memories provide diverse perspectives (semantic + entity-based)
     *    - LLM can make better decisions with both relevance angles
     *    - Improves RAG quality: less hallucination, more grounded responses
     * 
     * Accepts a query, aggregation options, a vector search function, and optional graph results.
     * Returns top merged memories and structured summaries (narrative, bullets, clusters).
     */
    async searchAndSummarizeForMcp(
        query: string,
        options: {
            category?: MemoryCategory;
            limit?: number;
            scoreThreshold?: number;
            strategy?: 'linear' | 'cluster-category' | 'cluster-tag' | 'hybrid';
            format?: 'narrative' | 'bullets' | 'both';
        } = {},
        searchMemories: (opts: typeof options) => Promise<MemoryWithId[]>,
        graphResults: GraphResult[] = [] // Optional graph search results to merge with vector results
    ): Promise<{
        query: string;
        topMemories: MemoryWithId[];
        aggregateNarrative?: string;
        aggregateBullets?: string[];
        clusterSummaries?: Array<CategoryClusterSummary | TagClusterSummary>;
        parameters: any;
        vectorResultCount?: number;
        graphResultCount?: number;
    }> {
        this.loggingService.trace('[searchAndSummarizeForMcp] Called');
        const startTime = Date.now();
        const limit = options.limit ?? 10;
        const scoreThreshold = options.scoreThreshold ?? 0.7;
        const strategy = options.strategy ?? 'linear';
        const format = options.format ?? 'bullets';
        const category = options.category;
        this.loggingService.debug(`[searchAndSummarizeForMcp] Options: ${JSON.stringify(options)}`);

        const vectorResults = await searchMemories(options);
        this.loggingService.debug(`[searchAndSummarizeForMcp] Retrieved ${vectorResults.length} memories from vector search`);
        this.loggingService.debug(`[searchAndSummarizeForMcp] Retrieved ${graphResults.length} memories from graph search`);

        // Step 2: Merge vector and graph results using deduplication and score normalization
        const merged = this.mergeVectorAndGraphResults(vectorResults, graphResults, limit, scoreThreshold);
        this.loggingService.debug(`[searchAndSummarizeForMcp] Merged to ${merged.length} deduplicated memories with combined scores`);

        // Step 3: Delegate to aggregateMemories
        const aggregationResult = await this.aggregateMemories(query, merged, { strategy, format, scoreThreshold, limit, category });

        const endTime = Date.now();
        const duration = endTime - startTime;

        // Log to search history with both vector and graph results
        try {
            const summaryText = aggregationResult.aggregateNarrative || (aggregationResult.aggregateBullets ? aggregationResult.aggregateBullets.join('\n') : '');

            const modelName = this.getModel().modelName || 'unknown';

            await this.sqlService.addSearchHistory(
                query,
                vectorResults.map(m => ({ id: m.id, score: m.score })), // Vector result info
                graphResults.map(g => ({ id: g.memory.id, score: g.score, relationshipPath: g.relationshipPath })), // Graph result info
                aggregationResult.mergePrompt || '',
                summaryText,
                limit,
                scoreThreshold,
                strategy,
                format,
                modelName,
                merged.length,
                duration
            );
        } catch (err) {
            this.loggingService.error(`[searchAndSummarizeForMcp] Failed to log search history: ${err}`);
        }

        return {
            ...aggregationResult,
            vectorResultCount: vectorResults.length,
            graphResultCount: graphResults.length
        };
    }

    /**
     * Aggregate and summarize pre-fetched memories without running a search.
     * Use this when you've already performed the search and filtering.
     */
    async aggregateMemories(
        query: string,
        memories: MemoryWithId[],
        options: {
            strategy?: 'linear' | 'cluster-category' | 'cluster-tag' | 'hybrid';
            format?: 'narrative' | 'bullets' | 'both';
            scoreThreshold?: number;
            limit?: number;
            category?: MemoryCategory;
        }
    ): Promise<{
        query: string;
        topMemories: MemoryWithId[];
        aggregateNarrative?: string;
        aggregateBullets?: string[];
        clusterSummaries?: Array<CategoryClusterSummary | TagClusterSummary>;
        parameters: any;
        mergePrompt?: string;
    }> {
        this.loggingService.trace('[aggregateMemories] Called');
        const strategy = options.strategy ?? 'linear';
        const format = options.format ?? 'bullets';
        const scoreThreshold = options.scoreThreshold ?? 0.7;
        const limit = options.limit ?? 10;
        const category = options.category;

        // Aggregate and summarize according to strategy
        let aggregateNarrative: string | undefined;
        let aggregateBullets: string[] | undefined;
        let clusterSummaries: Array<CategoryClusterSummary | TagClusterSummary> | undefined;
        let mergePrompt: string | undefined;

        if (strategy === 'linear') {
            this.loggingService.debug('[aggregateMemories] Using linear summarization');
            const summary = await this.summarizeMemoriesLinear(memories, { mode: format });
            aggregateNarrative = summary.narrative;
            aggregateBullets = summary.bullets;
            mergePrompt = summary.prompt;
        } else if (strategy === 'cluster-category') {
            this.loggingService.debug('[aggregateMemories] Using cluster-by-category summarization');
            clusterSummaries = await this.summarizeMemoriesByCategory(memories, { mode: format });
            // For now, we don't strictly capture all prompts from clusters for the single MergePrompt field
            // We could join them or just leave it empty.
        } else if (strategy === 'cluster-tag') {
            this.loggingService.debug('[aggregateMemories] Using cluster-by-tag summarization');
            clusterSummaries = await this.summarizeMemoriesByTag(memories, { mode: format });
        } else if (strategy === 'hybrid') {
            this.loggingService.debug('[aggregateMemories] Using hybrid summarization');
            const summary = await this.summarizeMemoriesLinear(memories, { mode: format });
            aggregateNarrative = summary.narrative;
            aggregateBullets = summary.bullets;
            mergePrompt = summary.prompt;
            clusterSummaries = await this.summarizeMemoriesByCategory(memories, { mode: format });
        }

        this.loggingService.debug('[aggregateMemories] Aggregation complete');
        return {
            query,
            topMemories: memories,
            aggregateNarrative,
            aggregateBullets,
            clusterSummaries,
            parameters: { scoreThreshold, limit, strategy, format, category },
            mergePrompt
        };
    }

    /**
     * Packs all memories and asks LLM for a global summary.
     * Mode can be 'narrative', 'bullets', or 'both'.
     */
    async summarizeMemoriesLinear(
        memories: MemoryWithId[],
        options: { mode: 'narrative' | 'bullets' | 'both' }
    ): Promise<{ narrative?: string; bullets?: string[]; prompt?: string }> {
        this.loggingService.trace('[summarizeMemoriesLinear] Called');
        if (!memories.length) {
            this.loggingService.debug('[summarizeMemoriesLinear] No memories to summarize');
            return {};
        }
        //await this.loadInferenceModel();

        // Serialize memories for prompt
        const packed = memories.map(m => {
            const desc = m.Description ? m.Description : '';
            const content = m.Content ? m.Content.slice(0, 200) : '';
            return `ID: ${m.id}\nCategory: ${m.Category}\nTags: ${(m.Tags || []).join(', ')}\nLastUpdated: ${m.LastUpdated}\nDescription: ${desc}\nContent: ${content}\n---`;
        }).join('\n');

        this.loggingService.debug(`[summarizeMemoriesLinear] Packed memories:\n${packed}`);

        // Render prompt using template
        const prompt = this.promptTemplateService.renderMemorySearchSummary({
            memories: packed,
            mode: options.mode,
            cluster_type: 'global',
            cluster_key: ''
        });

        this.loggingService.debug(`[summarizeMemoriesLinear] Prompt:\n${prompt}`);

        // Call LLM for summary
        const response = await this.getModel().respond([
            { role: 'system', content: 'You are a concise memory summarizer. Output only the summary.' },
            { role: 'user', content: prompt }
        ]);
        this.loggingService.debug(`[summarizeMemoriesLinear] LLM response:\n${response.content}`);

        if (options.mode === 'bullets') {
            // Parse bullet points from LLM output
            const bullets = response.content.split(/\n|\r/).map(b => b.trim()).filter(b => b.startsWith('- '));
            this.loggingService.debug(`[summarizeMemoriesLinear] Parsed bullets: ${JSON.stringify(bullets)}`);
            return { bullets, prompt };
        } else {
            // Return narrative paragraph
            this.loggingService.debug(`[summarizeMemoriesLinear] Parsed narrative`);
            return { narrative: response.content.trim(), prompt };
        }
    }

    /**
     * Groups memories by category and summarizes each cluster.
     * Returns a summary per category (up to MAX_CLUSTERS).
     */
    async summarizeMemoriesByCategory(
        memories: MemoryWithId[],
        options: { mode: 'narrative' | 'bullets' | 'both' }
    ): Promise<CategoryClusterSummary[]> {
        this.loggingService.trace('[summarizeMemoriesByCategory] Called');
        if (!memories.length) {
            this.loggingService.debug('[summarizeMemoriesByCategory] No memories to cluster');
            return [];
        }
        //await this.loadInferenceModel();

        // Group memories by Category
        const byCategory = new Map<string, MemoryWithId[]>();
        for (const m of memories) {
            const key = m.Category || 'Uncategorized';
            if (!byCategory.has(key)) byCategory.set(key, []);
            byCategory.get(key)!.push(m);
        }
        this.loggingService.debug(`[summarizeMemoriesByCategory] Found ${byCategory.size} category clusters`);

        // Limit number of clusters
        const categoryEntries = Array.from(byCategory.entries()).slice(0, this.MAX_CLUSTERS);

        const results: CategoryClusterSummary[] = [];
        for (const [categoryKey, items] of categoryEntries) {
            this.loggingService.debug(`[summarizeMemoriesByCategory] Summarizing cluster: ${categoryKey} (${items.length} memories)`);

            // Limit memories per cluster
            const topItems = items.slice(0, this.MAX_MEMORIES_PER_CLUSTER);

            // Serialize cluster memories for prompt
            const packed = topItems
                .map(m => {
                    const desc = m.Description ?? '';
                    const content = m.Content ? m.Content.slice(0, 200) : '';
                    return `ID: ${m.id}\nCategory: ${m.Category}\nTags: ${(m.Tags || []).join(', ')}\nLastUpdated: ${m.LastUpdated}\nDescription: ${desc}\nContent: ${content}\n---`;
                })
                .join('\n');

            this.loggingService.debug(`[summarizeMemoriesByCategory] Packed cluster memories:\n${packed}`);

            // Use 'bullets' for 'both' mode to ensure bullet parsing
            const modeForPrompt: 'narrative' | 'bullets' =
                options.mode === 'both' ? 'bullets' : options.mode;

            // Render prompt for this cluster
            const prompt = this.promptTemplateService.renderMemorySearchSummary({
                memories: packed,
                mode: modeForPrompt,
                cluster_type: 'category',
                cluster_key: categoryKey
            });

            this.loggingService.debug(`[summarizeMemoriesByCategory] Prompt for cluster '${categoryKey}':\n${prompt}`);

            // Call LLM for cluster summary
            const response = await this.getModel().respond([
                { role: 'system', content: 'You classify content into a single category. Output only the category.' },
                { role: 'user', content: prompt }
            ]);
            this.loggingService.debug(`[summarizeMemoriesByCategory] LLM response for '${categoryKey}':\n${response.content}`);

            const content = response.content.trim();
            const summary: CategoryClusterSummary = {
                key: categoryKey,
                type: 'category'
            };

            if (options.mode === 'narrative') {
                summary.narrative = content;
                this.loggingService.debug(`[summarizeMemoriesByCategory] Saved narrative for '${categoryKey}'`);
            } else {
                // Parse bullets
                const bullets = content
                    .split(/\r?\n/)
                    .map(l => l.trim())
                    .filter(l => l.startsWith('- '));
                summary.bullets = bullets;
                this.loggingService.debug(`[summarizeMemoriesByCategory] Saved bullets for '${categoryKey}': ${JSON.stringify(bullets)}`);
                if (options.mode === 'both') {
                    summary.narrative = content;
                    this.loggingService.debug(`[summarizeMemoriesByCategory] Saved raw narrative for '${categoryKey}'`);
                }
            }
            results.push(summary);
        }
        this.loggingService.debug('[summarizeMemoriesByCategory] All clusters summarized');
        return results;
    }

    /**
     * Groups memories by tag and summarizes each tag cluster.
     * Returns a summary per tag (up to MAX_CLUSTERS).
     */
    /**
     * Groups memories by tag and summarizes each tag cluster.
     * Returns a summary per tag (up to MAX_CLUSTERS).
     */
    async summarizeMemoriesByTag(
        memories: MemoryWithId[],
        options: { mode: 'narrative' | 'bullets' | 'both' }
    ): Promise<TagClusterSummary[]> {
        this.loggingService.trace('[summarizeMemoriesByTag] Called');
        if (!memories.length) {
            this.loggingService.debug('[summarizeMemoriesByTag] No memories to cluster');
            return [];
        }
        //await this.loadInferenceModel();

        // Helper: Group memories by tag, only include tags that appear at least minTagFrequency times
        const minTagFrequency = 2; // configurable if needed
        const tagMap = new Map<string, MemoryWithId[]>();
        for (const m of memories) {
            if (Array.isArray(m.Tags)) {
                for (const tag of m.Tags) {
                    if (!tagMap.has(tag)) tagMap.set(tag, []);
                    tagMap.get(tag)!.push(m);
                }
            }
        }
        // Filter tags by frequency
        const frequentTags = Array.from(tagMap.entries())
            .filter(([tag, items]) => items.length >= minTagFrequency)
            .sort((a, b) => b[1].length - a[1].length)
            .slice(0, this.MAX_CLUSTERS);

        this.loggingService.debug(`[summarizeMemoriesByTag] Found ${frequentTags.length} tag clusters`);

        // Helper: Serialize memories for prompt
        const serializeMemories = (items: MemoryWithId[]) => {
            return items.slice(0, this.MAX_MEMORIES_PER_CLUSTER).map(m => {
                const desc = m.Description ? m.Description : '';
                const content = m.Content ? m.Content.slice(0, 200) : '';
                return `ID: ${m.id}\nCategory: ${m.Category}\nTags: ${(m.Tags || []).join(', ')}\nLastUpdated: ${m.LastUpdated}\nDescription: ${desc}\nContent: ${content}\n---`;
            }).join('\n');
        };

        // Helper: Summarize a tag cluster
        const summarizeTagCluster = async (tagKey: string, items: MemoryWithId[]) => {
            const packed = serializeMemories(items);
            const prompt = this.promptTemplateService.renderMemorySearchSummary({
                memories: packed,
                mode: options.mode,
                cluster_type: 'tag',
                cluster_key: tagKey
            });
            this.loggingService.debug(`[summarizeMemoriesByTag] Prompt for tag '${tagKey}':\n${prompt}`);
            const response = await this.getModel().respond([
                { role: 'system', content: 'Output only comma-separated tags, nothing else.' },
                { role: 'user', content: prompt }
            ]);
            this.loggingService.debug(`[summarizeMemoriesByTag] LLM response for tag '${tagKey}':\n${response.content}`);
            if (options.mode === 'bullets') {
                const bullets = response.content.split(/\n|\r/).map(b => b.trim()).filter(b => b.startsWith('- '));
                return { key: tagKey, type: 'tag', bullets } as TagClusterSummary;
            } else {
                return { key: tagKey, type: 'tag', narrative: response.content.trim() } as TagClusterSummary;
            }
        };

        // Summarize each tag cluster
        const results: TagClusterSummary[] = [];
        for (const [tagKey, items] of frequentTags) {
            this.loggingService.debug(`[summarizeMemoriesByTag] Summarizing cluster: ${tagKey} (${items.length} memories)`);
            const summary = await summarizeTagCluster(tagKey, items);
            results.push(summary);
        }
        this.loggingService.debug('[summarizeMemoriesByTag] All clusters summarized');
        return results;
    }
}
