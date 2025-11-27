import { MemoryCategory } from '../models/memoryCategory';
import { MemoryWithId } from '../models/memory';
import { PromptTemplateService } from './promptTemplateService';
import { LoggingService } from './loggingService';
import { ModelClient } from './modelClients';

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
 * MemoryPostSearchAggregator
 * Handles post-search aggregation for RAG: summarizing, clustering, and structuring memory search results.
 * This is typically called after semantic search returns top matches.
 */
export class MemoryPostSearchAggregator {
    private getModel: () => ModelClient;
    private promptTemplateService: PromptTemplateService;
    private loggingService: LoggingService;
    private MAX_CLUSTERS: number;
    private MAX_MEMORIES_PER_CLUSTER: number;

    /**
     * @param loadInferenceModel Function to ensure LLM is loaded
     * @param getModel Function to get loaded LLM instance
     * @param promptTemplateService Service for rendering prompt templates
     * @param loggingService Logging utility
     * @param config Aggregation config knobs
     */
    constructor(
        getModel: () => ModelClient,
        promptTemplateService: PromptTemplateService,
        loggingService: LoggingService,
        config: { MAX_CLUSTERS: number; MAX_MEMORIES_PER_CLUSTER: number }
    ) {
        this.getModel = getModel;
        this.promptTemplateService = promptTemplateService;
        this.loggingService = loggingService;
        this.MAX_CLUSTERS = config.MAX_CLUSTERS;
        this.MAX_MEMORIES_PER_CLUSTER = config.MAX_MEMORIES_PER_CLUSTER;
    }

    /**
     * Main entrypoint for post-search aggregation.
     * Accepts a query, aggregation options, and a searchMemories function.
     * Returns top memories and structured summaries (narrative, bullets, clusters).
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
        searchMemories: (opts: typeof options) => Promise<MemoryWithId[]>
    ): Promise<{
        query: string;
        topMemories: MemoryWithId[];
        aggregateNarrative?: string;
        aggregateBullets?: string[];
        clusterSummaries?: Array<CategoryClusterSummary | TagClusterSummary>;
        parameters: any;
    }> {
        this.loggingService.trace('[searchAndSummarizeForMcp] Called');
        // Step 1: Run semantic search
        const limit = options.limit ?? 10;
        const scoreThreshold = options.scoreThreshold ?? 0.7;
        const strategy = options.strategy ?? 'linear';
        const format = options.format ?? 'bullets';
        const category = options.category;
        this.loggingService.debug(`[searchAndSummarizeForMcp] Options: ${JSON.stringify(options)}`);

        const memories = await searchMemories(options);
        this.loggingService.debug(`[searchAndSummarizeForMcp] Retrieved ${memories.length} memories from semantic search`);

        // Step 2: Filter by score threshold and sort by score
        const filtered = memories
            .filter(m => (typeof m.score === 'number' ? m.score : 0) >= scoreThreshold)
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
            .slice(0, limit);

        this.loggingService.debug(`[searchAndSummarizeForMcp] Filtered to ${filtered.length} top memories`);

        // Step 3: Delegate to aggregateMemories
        return await this.aggregateMemories(query, filtered, { strategy, format, scoreThreshold, limit, category });
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

        if (strategy === 'linear') {
            this.loggingService.debug('[aggregateMemories] Using linear summarization');
            const summary = await this.summarizeMemoriesLinear(memories, { mode: format });
            aggregateNarrative = summary.narrative;
            aggregateBullets = summary.bullets;
        } else if (strategy === 'cluster-category') {
            this.loggingService.debug('[aggregateMemories] Using cluster-by-category summarization');
            clusterSummaries = await this.summarizeMemoriesByCategory(memories, { mode: format });
        } else if (strategy === 'cluster-tag') {
            this.loggingService.debug('[aggregateMemories] Using cluster-by-tag summarization');
            clusterSummaries = await this.summarizeMemoriesByTag(memories, { mode: format });
        } else if (strategy === 'hybrid') {
            this.loggingService.debug('[aggregateMemories] Using hybrid summarization');
            const summary = await this.summarizeMemoriesLinear(memories, { mode: format });
            aggregateNarrative = summary.narrative;
            aggregateBullets = summary.bullets;
            clusterSummaries = await this.summarizeMemoriesByCategory(memories, { mode: format });
        }

        this.loggingService.debug('[aggregateMemories] Aggregation complete');
        return {
            query,
            topMemories: memories,
            aggregateNarrative,
            aggregateBullets,
            clusterSummaries,
            parameters: { scoreThreshold, limit, strategy, format, category }
        };
    }

    /**
     * Packs all memories and asks LLM for a global summary.
     * Mode can be 'narrative', 'bullets', or 'both'.
     */
    async summarizeMemoriesLinear(
        memories: MemoryWithId[],
        options: { mode: 'narrative' | 'bullets' | 'both' }
    ): Promise<{ narrative?: string; bullets?: string[] }> {
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
            return { bullets };
        } else {
            // Return narrative paragraph
            this.loggingService.debug(`[summarizeMemoriesLinear] Parsed narrative`);
            return { narrative: response.content.trim() };
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
