import { QdrantClient } from '@qdrant/js-client-rest';
import { randomUUID } from 'crypto';
import { LMStudioClient, LLM, EmbeddingModel } from '@lmstudio/sdk';
import { ModelClient, LMStudioModelClient, OllamaModelClient } from './modelClients';
import { PromptTemplateService } from './promptTemplateService';
import { LoggingService } from './loggingService';
import { env } from 'process';
import { MemoryCategory } from '../models/memoryCategory';
import { Memory, MemoryWithId } from '../models/memory';
import { MemoryPostSearchAggregator } from './memoryPostSearchAggregator';
import { MemoryTextProcessor } from './MemoryTextProcessor';
import { MemoryReportService } from './MemoryReportService';

const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text-v1.5';

class MemoryRAGSystem {
    private client: QdrantClient;
    private lmStudio: LMStudioClient;
    private embeddingModel: EmbeddingModel | null = null;
    private embeddingModelName: string;
    private modelClient: ModelClient | null = null; // Abstraction for provider-specific inference
    private modelName: string;
    private modelProvider: string;
    private promptTemplateService: PromptTemplateService = new PromptTemplateService(env.PROMPT_TEMPLATE_BASE_PATH || '~/prompts');
    private loggingService: LoggingService = new LoggingService();
    private memoryReportService: MemoryReportService = new MemoryReportService('reports');

    // Config knobs for summarization
    private readonly MAX_MEMORIES_FOR_SUMMARY = 10;
    private readonly MAX_CLUSTERS = 5;
    private readonly MAX_MEMORIES_PER_CLUSTER = 5;

    private readonly COLLECTION_NAME = 'memories';
    private readonly VECTOR_SIZE = 768;

    private memoryTextProcessor: MemoryTextProcessor | null = null;

    private postSearchAggregator: MemoryPostSearchAggregator = new MemoryPostSearchAggregator(
        () => this.modelClient!,
        this.promptTemplateService,
        this.loggingService,
        {
            MAX_CLUSTERS: this.MAX_CLUSTERS,
            MAX_MEMORIES_PER_CLUSTER: this.MAX_MEMORIES_PER_CLUSTER
        }
    );

    constructor(qdrantUrl: string, modelName: string, modelProvider: string, embeddingModelName: string = DEFAULT_EMBEDDING_MODEL) {
        this.client = new QdrantClient({ url: qdrantUrl });
        this.lmStudio = new LMStudioClient();
        this.embeddingModelName = embeddingModelName;
        this.modelName = modelName;
        this.modelProvider = modelProvider;
        // Initialize model client abstraction
        if (this.modelProvider === 'lmstudio') {
            this.modelClient = new LMStudioModelClient();
            this.modelClient.load(this.modelName);
        } else if (this.modelProvider === 'ollama') {
            this.modelClient = new OllamaModelClient();
            this.modelClient.load(this.modelName);
        } else {
            throw new Error(`Unsupported model provider: ${this.modelProvider}`);
        }
    }

    async loadEmbeddingModel(): Promise<void> {
        this.loggingService.trace('[loadEmbeddingModel] Called');
        if (this.embeddingModel) {
            this.loggingService.info('[loadEmbeddingModel] Embedding model already loaded, skipping reload');
            return;
        }

        try {
            this.loggingService.log(`[loadEmbeddingModel] Loading embedding model: ${this.embeddingModelName}`);
            const loadedEmbeddingModel = await this.lmStudio.embedding.model(this.embeddingModelName);
            this.embeddingModel = loadedEmbeddingModel;
            this.loggingService.log('[loadEmbeddingModel] Embedding model loaded successfully');
        } catch (error) {
            this.loggingService.error(`[loadEmbeddingModel] Error loading embedding model: ${error}`);
            throw new Error('Failed to load embedding model. Make sure LM Studio is running and the model is loaded.');
        }
    }

    async loadInferenceModel(): Promise<void> {
        this.loggingService.trace('[loadInferenceModel] Called');
        // If using LM Studio's native LLM, keep existing pathway
        if (this.modelProvider === 'lmstudio') {
            try {
                this.loggingService.log(`[loadInferenceModel] Loading inference model (lmstudio): ${this.modelName}`);
                // Also load via abstraction for unified respond API
                await this.modelClient!.load(this.modelName);
                this.loggingService.log('[loadInferenceModel] Inference model loaded successfully (lmstudio)');
            } catch (error) {
                this.loggingService.error(`[loadInferenceModel] Error loading inference model: ${error}`);
                throw new Error('Failed to load inference model. Make sure LM Studio is running and the model is loaded.');
            }
        } else {
            // For non-lmstudio providers (e.g., ollama), use modelClients abstraction
            try {
                // Avoid setting this.model; MemoryTextProcessor path will be bypassed
                this.loggingService.log(`[loadInferenceModel] Loading inference model (${this.modelProvider}): ${this.modelName}`);
                await this.modelClient!.load(this.modelName);
                this.loggingService.log('[loadInferenceModel] Inference model loaded successfully via abstraction');
            } catch (error) {
                this.loggingService.error(`[loadInferenceModel] Error loading inference model via abstraction: ${error}`);
                throw new Error(`Failed to load inference model for provider ${this.modelProvider}. ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    async initializeCollection(): Promise<void> {
        this.loggingService.trace('[initializeCollection] Called');
        try {
            const collections = await this.client.getCollections();
            this.loggingService.info(`[initializeCollection] Collections fetched: ${JSON.stringify(collections.collections.map(c => c.name))}`);
            const exists = collections.collections.some(
                c => c.name === this.COLLECTION_NAME
            );

            if (!exists) {
                this.loggingService.log(`[initializeCollection] Creating collection: ${this.COLLECTION_NAME}`);
                await this.client.createCollection(this.COLLECTION_NAME, {
                    vectors: {
                        size: this.VECTOR_SIZE,
                        distance: 'Cosine'
                    }
                });

                this.loggingService.log('[initializeCollection] Creating payload index for Category');
                await this.client.createPayloadIndex(this.COLLECTION_NAME, {
                    field_name: 'Category',
                    field_schema: 'keyword'
                });

                this.loggingService.log('[initializeCollection] Creating payload index for Tags');
                await this.client.createPayloadIndex(this.COLLECTION_NAME, {
                    field_name: 'Tags',
                    field_schema: 'keyword'
                });

                this.loggingService.log('[initializeCollection] Collection initialized successfully');
            } else {
                this.loggingService.log('[initializeCollection] Collection already exists');
            }
        } catch (error) {
            this.loggingService.error(`[initializeCollection] Error initializing collection: ${error}`);
            throw error;
        }
    }


    private getOrCreateTextProcessor(): MemoryTextProcessor {
        if (!this.modelClient) throw new Error('[MemoryRAGSystem] Model client not initialized');
        if (!this.memoryTextProcessor) {
            this.memoryTextProcessor = new MemoryTextProcessor(
                this.modelClient,
                this.promptTemplateService,
                this.loggingService
            );
        }
        return this.memoryTextProcessor;
    }

    async summarizeClassifyAndTagTextParallel(text: string): Promise<{ summary: string, classification: string; tags: string[]; }> {
        this.loggingService.trace('[summarizeClassifyAndTagTextParallel] Called');
        const processor = this.getOrCreateTextProcessor();
        return await processor.summarizeClassifyAndTagTextParallel(text);
    }

    /**
     * Loads inference model and summarizes/classifies/tags memory content.
     */
    async summarizeClassifyAndPrepareMemory(memory: Memory): Promise<{
        summary: string;
        classification: string;
        tags: string[];
        description: string;
        category: MemoryCategory;
        tagsList: string[];
    }> {
        const { summary, classification, tags } = await this.summarizeClassifyAndTagTextParallel(memory.Content);

        // Prepare description, category, tagsList
        let description = memory.Description;
        if (!description || description.trim().length === 0) {
            description = summary;
        }
        let category = memory.Category;
        if (!category) {
            category = classification as MemoryCategory;
        }
        let tagsList = memory.Tags;
        if (!tagsList || tagsList.length === 0) {
            tagsList = tags;
        }
        return { summary, classification, tags, description, category, tagsList };
    }

    /**
     * Generates embedding for memory content.
     */
    async generateEmbedding(text: string): Promise<number[]> {
        this.loggingService.trace('[generateEmbedding] Called');
        if (!this.embeddingModel) {
            this.loggingService.error('[generateEmbedding] Embedding model not loaded');
            throw new Error('Failed to generate embedding');
        }

        try {
            this.loggingService.debug(`[generateEmbedding] Generating embedding for text: ${text}`);
            const result = await this.timeModelResponse(() => this.embeddingModel!.embed(text), 'generateEmbedding') as { embedding: number[] };
            this.loggingService.debug(`[generateEmbedding] Embedding result length: ${result.embedding.length}`);
            return result.embedding;
        } catch (error) {
            this.loggingService.error(`[generateEmbedding] Error generating embedding: ${error}`);
            throw new Error('Failed to generate embedding');
        }
    }


    /**
     * Upserts the memory record into Qdrant.
     */
    async upsertMemory(memory: Memory, embedding: number[], id?: string): Promise<string> {
        this.loggingService.trace('[upsertMemory] Called');
        // Use a valid UUID for the memory ID
        const memoryId = id || randomUUID();
        this.loggingService.info(`[upsertMemory] Upserting memory with ID: ${memoryId}`);
        await this.client.upsert(this.COLLECTION_NAME, {
            points: [
                {
                    id: memoryId,
                    vector: embedding,
                    payload: {
                        Content: memory.Content,
                        Description: memory.Description,
                        Tags: memory.Tags,
                        Category: memory.Category,
                        LastUpdated: new Date().toISOString()
                    }
                }
            ]
        });
        this.loggingService.log(`[upsertMemory] Memory added with ID: ${memoryId}`);
        return memoryId;
    }

    /**
     * Main addMemory method, now orchestrates the above steps.
     */
    async addMemory(memory: Memory): Promise<string> {
        this.loggingService.trace('[addMemory] Called');
        try {
            this.loggingService.info(`[addMemory] Received memory: ${JSON.stringify(memory, null, 2)}`);
            // Step 1: Summarize, classify, tag, and prepare memory fields
            this.loggingService.debug('[addMemory] Loading inference model...');
            await this.loadInferenceModel();
            this.loggingService.info('[addMemory] Inference model loaded. Summarizing, classifying, and tagging...');
            const prepared = await this.summarizeClassifyAndPrepareMemory(memory);
            this.loggingService.debug(`[addMemory] Prepared memory fields: ${JSON.stringify(prepared, null, 2)}`);
            // Step 2: Generate embedding
            this.loggingService.debug('[addMemory] Loading embedding model...');
            await this.loadEmbeddingModel();
            this.loggingService.info(`[addMemory] Embedding model loaded. Generating embedding for content: ${prepared.description ? prepared.description : memory.Content}`);
            try {
                const embedding = await this.generateEmbedding(memory.Content);
                this.loggingService.info(`[addMemory] Embedding generated. Length: ${embedding.length}`);
                // Step 3: Upsert memory
                const memoryToUpsert: Memory = {
                    ...memory,
                    Description: prepared.description,
                    Category: prepared.category,
                    Tags: prepared.tagsList,
                    LastUpdated: new Date().toISOString()
                };
                this.loggingService.info(`[addMemory] Upserting memory: ${JSON.stringify(memoryToUpsert, null, 2)}`);
                return await this.upsertMemory(memoryToUpsert, embedding);
            } catch (embeddingError) {
                this.loggingService.error(`[addMemory] Error during embedding generation: ${embeddingError}`);
                throw new Error('Failed to generate embedding. ' + (embeddingError instanceof Error ? embeddingError.message : String(embeddingError)));
            }
        } catch (error) {
            this.loggingService.error(`[addMemory] Error adding memory: ${error}`);
            throw new Error('Failed to add memory. ' + (error instanceof Error ? error.message : String(error)));
        }
    }

    async getMemoriesByCategory(
        category: MemoryCategory,
        limit: number = 10
    ): Promise<MemoryWithId[]> {
        this.loggingService.trace(`[getMemoriesByCategory] Called with category: ${category}, limit: ${limit}`);
        const response = await this.client.scroll(this.COLLECTION_NAME, {
            filter: {
                must: [
                    {
                        key: 'Category',
                        match: { value: category }
                    }
                ]
            },
            limit,
            with_payload: true,
            with_vector: false
        });
        this.loggingService.info(`[getMemoriesByCategory] Retrieved ${response.points.length} memories`);
        this.loggingService.debug(`[getMemoriesByCategory] Response: ${JSON.stringify(response.points, null, 2)}`);
        return response.points.map(point => ({
            id: point.id.toString(),
            ...(point.payload as unknown as Memory)
        }));
    }

    async searchMemories(
        query: string,
        category?: MemoryCategory,
        limit: number = 5
    ): Promise<MemoryWithId[]> {
        this.loggingService.trace(`[searchMemories] Called with query: ${query}, category: ${category}, limit: ${limit}`);
        await this.loadEmbeddingModel();
        const queryEmbedding = await this.generateEmbedding(query);
        return this.searchMemoriesWithEmbedding(queryEmbedding, category, limit);
    }

    /**
     * Search memories using a pre-computed embedding vector.
     * Use this when you've already loaded the embedding model and generated embeddings.
     */
    async searchMemoriesWithEmbedding(
        queryEmbedding: number[],
        category?: MemoryCategory,
        limit: number = 5
    ): Promise<MemoryWithId[]> {
        this.loggingService.trace(`[searchMemoriesWithEmbedding] Called with category: ${category}, limit: ${limit}`);
        const filter = category
            ? {
                must: [
                    {
                        key: 'Category',
                        match: { value: category }
                    }
                ]
            }
            : undefined;

        this.loggingService.debug(`[searchMemoriesWithEmbedding] Searching with filter: ${JSON.stringify(filter)}`);
        const response = await this.client.search(this.COLLECTION_NAME, {
            vector: queryEmbedding,
            limit,
            filter,
            with_payload: true
        });
        this.loggingService.info(`[searchMemoriesWithEmbedding] Search returned ${response.length} results`);
        this.loggingService.debug(`[searchMemoriesWithEmbedding] Response: ${JSON.stringify(response, null, 2)}`);
        return response.map(result => ({
            id: result.id.toString(),
            ...(result.payload as unknown as Memory),
            score: result.score as number | undefined
        }));
    }

    async searchByTags(
        tags: string[],
        category?: MemoryCategory
    ): Promise<MemoryWithId[]> {
        this.loggingService.trace(`[searchByTags] Called with tags: ${JSON.stringify(tags)}, category: ${category}`);
        const mustConditions: any[] = [
            {
                key: 'Tags',
                match: { any: tags }
            }
        ];

        if (category) {
            mustConditions.push({
                key: 'Category',
                match: { value: category }
            });
        }

        this.loggingService.debug(`[searchByTags] Filter: ${JSON.stringify(mustConditions)}`);
        const response = await this.client.scroll(this.COLLECTION_NAME, {
            filter: { must: mustConditions },
            limit: 100,
            with_payload: true,
            with_vector: false
        });
        this.loggingService.info(`[searchByTags] Retrieved ${response.points.length} memories`);
        this.loggingService.debug(`[searchByTags] Response: ${JSON.stringify(response.points, null, 2)}`);
        return response.points.map(point => ({
            id: point.id.toString(),
            ...(point.payload as unknown as Memory)
        }));
    }

    async updateMemory(id: string, updates: Partial<Memory>): Promise<void> {
        this.loggingService.trace(`[updateMemory] Called for ID: ${id} with updates: ${JSON.stringify(updates)}`);
        const points = await this.client.retrieve(this.COLLECTION_NAME, {
            ids: [id],
            with_payload: true,
            with_vector: true
        });

        if (points.length === 0) {
            this.loggingService.error(`[updateMemory] Memory with ID ${id} not found`);
            throw new Error(`Memory with ID ${id} not found`);
        }

        const existingMemory = points[0].payload as unknown as Memory;
        const updatedMemory = {
            ...existingMemory,
            ...updates,
            LastUpdated: new Date().toISOString()
        };

        let vector = points[0].vector as number[];
        if (updates.Content || updates.Description || updates.Tags) {
            this.loggingService.info('[updateMemory] Content/Description/Tags updated, regenerating embedding');
            const searchableText = updatedMemory.Content;
            vector = await this.generateEmbedding(searchableText);
        }

        this.loggingService.info('[updateMemory] Upserting updated memory');
        await this.client.upsert(this.COLLECTION_NAME, {
            points: [
                {
                    id,
                    vector,
                    payload: updatedMemory
                }
            ]
        });
        this.loggingService.log(`[updateMemory] Memory with ID ${id} updated successfully`);
    }

    async deleteMemory(id: string): Promise<void> {
        this.loggingService.trace(`[deleteMemory] Called for ID: ${id}`);
        await this.client.delete(this.COLLECTION_NAME, {
            points: [id]
        });
        this.loggingService.log(`[deleteMemory] Memory with ID ${id} deleted`);
    }

    /**
     * Retrieve a single memory by its ID. Returns null if not found.
     */
    async getMemoryById(id: string): Promise<MemoryWithId | null> {
        this.loggingService.trace(`[getMemoryById] Called with ID: ${id}`);
        try {
            const points = await this.client.retrieve(this.COLLECTION_NAME, {
                ids: [id],
                with_payload: true,
                with_vector: false
            });
            if (!points || points.length === 0) {
                this.loggingService.info(`[getMemoryById] Memory not found for ID: ${id}`);
                return null;
            }
            const point = points[0];
            const memory = point.payload as unknown as Memory;
            const result: MemoryWithId = {
                id: point.id.toString(),
                ...memory
            };
            this.loggingService.debug(`[getMemoryById] Retrieved memory: ${JSON.stringify(result, null, 2)}`);
            return result;
        } catch (error) {
            this.loggingService.error(`[getMemoryById] Error retrieving memory: ${error}`);
            throw new Error('Failed to retrieve memory by id');
        }
    }

    // Get counts of memories per category
    async getCategoryCounts(): Promise<Record<MemoryCategory, number>> {
        this.loggingService.trace('[getCategoryCounts] Called');
        const counts = {} as Record<MemoryCategory, number>;

        for (const category of Object.values(MemoryCategory)) {
            this.loggingService.debug(`[getCategoryCounts] Counting for category: ${category}`);
            const response = await this.client.scroll(this.COLLECTION_NAME, {
                filter: {
                    must: [
                        {
                            key: 'Category',
                            match: { value: category }
                        }
                    ]
                },
                limit: 1,
                with_payload: false,
                with_vector: false
            });
            counts[category as MemoryCategory] = response.points.length;
            this.loggingService.debug(`[getCategoryCounts] Category: ${category}, Count: ${response.points.length}`);
        }

        this.loggingService.info(`[getCategoryCounts] Counts: ${JSON.stringify(counts)}`);
        return counts;
    }

    // Helper to time and log model responses
    private async timeModelResponse<T>(fn: () => Promise<T>, caller: string): Promise<T> {
        const start = Date.now();
        const result = await fn();
        const duration = Date.now() - start;
        this.loggingService.info(`[${caller}] Model response time: ${duration}ms`);
        return result;
    }

    async deleteCollection(): Promise<void> {
        try {
            await this.client.deleteCollection(this.COLLECTION_NAME);
            this.loggingService.log(`Collection '${this.COLLECTION_NAME}' deleted successfully.`);
        } catch (error) {
            this.loggingService.error(`Error deleting collection '${this.COLLECTION_NAME}': ${error}`);
            throw new Error(`Failed to delete collection '${this.COLLECTION_NAME}'.`);
        }
    }

    /// Post-search Aggregation Interfaces

    /**
     * MCP-friendly search and summarization method.
     * Returns top memories and aggregate summary (narrative and/or bullets), optionally with cluster summaries.
     */
    async searchAndSummarizeForMcp(
        query: string,
        options?: {
            category?: MemoryCategory;
            limit?: number;
            scoreThreshold?: number;
            strategy?: 'linear' | 'cluster-category' | 'cluster-tag' | 'hybrid';
            format?: 'narrative' | 'bullets' | 'both';
        },
        generateReport: boolean = true
    ): Promise<{
        query: string;
        topMemories: MemoryWithId[];
        aggregateNarrative?: string;
        aggregateBullets?: string[];
        clusterSummaries?: Array<{
            key: string;
            type: 'category' | 'tag';
            narrative?: string;
            bullets?: string[];
        }>;
        parameters: any;
    }> {
        // Delegate to aggregator
        const result = await this.postSearchAggregator.searchAndSummarizeForMcp(query, options, (opts) =>
            this.searchMemories(query, opts?.category, (opts?.limit ?? this.MAX_MEMORIES_FOR_SUMMARY) * 2)
        );

        if(generateReport) {
            // Generate and save a Markdown report after each search
            try {
                const filePath = await this.memoryReportService.generateAndSavePostSearchAggregationReport(
                    result as any,
                    this.embeddingModelName
                );
                this.loggingService.info(`[searchAndSummarizeForMcp] Report saved: ${filePath}`);
            } catch (err) {
                this.loggingService.error(`[searchAndSummarizeForMcp] Failed to save report: ${err}`);
            }
        }

        return result;
    }

    /**
     * Run post-search aggregation on pre-fetched memories without re-running the search.
     * Use this when you've already performed the search and want to aggregate the results.
     */
    async aggregateSearchResults(
        query: string,
        memories: MemoryWithId[],
        options?: {
            category?: MemoryCategory;
            limit?: number;
            scoreThreshold?: number;
            strategy?: 'linear' | 'cluster-category' | 'cluster-tag' | 'hybrid';
            format?: 'narrative' | 'bullets' | 'both';
        }
    ): Promise<{
        query: string;
        topMemories: MemoryWithId[];
        aggregateNarrative?: string;
        aggregateBullets?: string[];
        clusterSummaries?: Array<{
            key: string;
            type: 'category' | 'tag';
            narrative?: string;
            bullets?: string[];
        }>;
        parameters: any;
    }> {
        this.loggingService.trace('[aggregateSearchResults] Called');
        const limit = options?.limit ?? 10;
        const scoreThreshold = options?.scoreThreshold ?? 0.7;
        const strategy = options?.strategy ?? 'linear';
        const format = options?.format ?? 'bullets';
        const category = options?.category;

        // Filter by score threshold and sort by score
        const filtered = memories
            .filter(m => (typeof m.score === 'number' ? m.score : 0) >= scoreThreshold)
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
            .slice(0, limit);

        this.loggingService.debug(`[aggregateSearchResults] Filtered to ${filtered.length} top memories`);

        // Delegate to aggregator for summarization
        const result = await this.postSearchAggregator.aggregateMemories(
            query,
            filtered,
            { strategy, format, scoreThreshold, limit, category }
        );

        return result;
    }
}


export { MemoryRAGSystem };
