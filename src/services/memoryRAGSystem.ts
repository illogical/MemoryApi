import { randomUUID } from 'crypto';
import { RAGOrchestrator } from './ragOrchestrator';
import { VectorService } from './vectorService';
import { ModelClient, LMStudioModelClient, OllamaModelClient, EmbeddingClient, OllamaEmbeddingClient } from './modelClients';
import { PromptTemplateService } from './promptTemplateService';
import { LoggingService } from './loggingService';
import { MemoryCategory } from '../models/memoryCategory';
import { Memory, MemoryWithId } from '../models/memory';
import { MemoryPostSearchAggregator } from './memoryPostSearchAggregator';
import { MemoryTextProcessor } from './memoryTextProcessor';
import { MemoryReportService } from './memoryReportService';
import { GraphService } from './graphService';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text-v1.5';
const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

class MemoryRAGSystem {
    private orchestrator: RAGOrchestrator;
    private embeddingClient: EmbeddingClient;
    private modelClient: ModelClient; // Abstraction for provider-specific inference
    private promptTemplateService: PromptTemplateService = new PromptTemplateService(process.env.PROMPT_TEMPLATE_BASE_PATH || '~/prompts');
    private loggingService: LoggingService = new LoggingService();
    private memoryReportService: MemoryReportService = new MemoryReportService('reports');
    private graphService: GraphService;

    // Config knobs for summarization
    private readonly MAX_MEMORIES_FOR_SUMMARY = 10;
    private readonly MAX_CLUSTERS = 5;
    private readonly MAX_MEMORIES_PER_CLUSTER = 5;

    private readonly COLLECTION_NAME = 'memories';
    private readonly VECTOR_SIZE = 768;

    private memoryTextProcessor: MemoryTextProcessor | null = null;

    private postSearchAggregator: MemoryPostSearchAggregator;

    constructor(qdrantUrl: string, modelName: string, modelProvider: string, embeddingModelName: string = DEFAULT_EMBEDDING_MODEL) {
        // Initialize Services
        const vectorService = new VectorService(qdrantUrl, this.loggingService);
        this.graphService = new GraphService(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);

        this.orchestrator = new RAGOrchestrator(vectorService, this.graphService, this.loggingService);

        // Initialize embedding client (now using Ollama by default as requested)
        this.embeddingClient = new OllamaEmbeddingClient();
        this.embeddingClient.load(embeddingModelName);

        // Initialize model client abstraction
        if (modelProvider === 'lmstudio') {
            this.modelClient = new LMStudioModelClient();
        } else if (modelProvider === 'ollama') {
            this.modelClient = new OllamaModelClient();
        } else {
            throw new Error(`Unsupported model provider: ${modelProvider}`);
        }
        this.modelClient.load(modelName);

        // Re-initialize aggregator with graph service
        this.postSearchAggregator = new MemoryPostSearchAggregator(
            () => this.modelClient!,
            this.promptTemplateService,
            this.loggingService,
            {
                MAX_CLUSTERS: this.MAX_CLUSTERS,
                MAX_MEMORIES_PER_CLUSTER: this.MAX_MEMORIES_PER_CLUSTER
            }
            //this.graphService
        );
    }

    async loadInferenceModel(): Promise<void> {
        this.loggingService.trace('[loadInferenceModel] Called');
        try {
            this.loggingService.log(`[loadInferenceModel] Loading inference model (${this.modelClient.provider}): ${this.modelClient.modelName}`);
            await this.modelClient.load(this.modelClient.modelName);
            this.loggingService.log('[loadInferenceModel] Inference model loaded successfully');
        } catch (error) {
            this.loggingService.error(`[loadInferenceModel] Error loading inference model: ${error}`);
            throw new Error(`Failed to load inference model. ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    async initializeCollection(): Promise<void> {
        this.loggingService.trace('[initializeCollection] Delegating to orchestrator');
        await this.orchestrator.initialize();
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
        try {
            this.loggingService.debug(`[generateEmbedding] Generating embedding for text using ${this.embeddingClient.modelName}`);
            const embedding = await this.timeModelResponse(() => this.embeddingClient.embed(text), 'generateEmbedding');
            this.loggingService.debug(`[generateEmbedding] Embedding result length: ${embedding.length}`);
            return embedding;
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
        const memoryId = id || randomUUID();
        this.loggingService.info(`[upsertMemory] Upserting memory with ID: ${memoryId}`);
        return await this.orchestrator.addMemory(memory, embedding, memoryId);
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
        this.loggingService.trace(`[getMemoriesByCategory] Delegating to orchestrator`);
        return await this.orchestrator.getMemoriesByCategory(category, limit);
    }

    async searchMemories(
        query: string,
        category?: MemoryCategory,
        limit: number = 5
    ): Promise<MemoryWithId[]> {
        this.loggingService.trace(`[searchMemories] Called with query: ${query}, category: ${category}, limit: ${limit}`);
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
        this.loggingService.trace(`[searchMemoriesWithEmbedding] Delegating to orchestrator`);
        return await this.orchestrator.searchMemoriesWithEmbedding(queryEmbedding, category, limit);
    }

    async searchByTags(
        tags: string[],
        category?: MemoryCategory
    ): Promise<MemoryWithId[]> {
        this.loggingService.trace(`[searchByTags] Delegating to orchestrator`);
        return await this.orchestrator.searchByTags(tags, category);
    }

    async updateMemory(id: string, updates: Partial<Memory>): Promise<void> {
        this.loggingService.trace(`[updateMemory] Called for ID: ${id}`);

        let vector: number[] | undefined = undefined;
        if (updates.Content || updates.Description || updates.Tags) {
            // If we need to regenerate embedding, we need the full content.
            // But updates might be partial.
            // If Content is updated, we use it. If not, we might need to fetch existing.
            // VectorService.updateMemory handles retrieval, but here we need to generate embedding BEFORE calling update if content changed.
            // Let's rely on fetching the memory first to get the content to embed if we don't have it all.
            // Wait, `MemoryRAGSystem` logic previously fetched it:
            // const points = await this.client.retrieve(...)
            // ...
            // if (updates.Content...) vector = await generateEmbedding...

            // We can do this Logic here or move it to Orchestrator?
            // Orchestrator keeps it simple (takes embedding).
            // So we should do the logic here:
            // 1. Fetch current memory (via orchestrator)
            // 2. Generate embedding if needed
            // 3. Call orchestrator.updateMemory

            const current = await this.orchestrator.getMemoryById(id);
            if (!current) throw new Error(`Memory ${id} not found`);

            const mergedForEmbedding = { ...current, ...updates };
            if (mergedForEmbedding.Content) {
                vector = await this.generateEmbedding(mergedForEmbedding.Content);
            }
        }

        await this.orchestrator.updateMemory(id, updates, vector);
    }

    async deleteMemory(id: string): Promise<void> {
        this.loggingService.trace(`[deleteMemory] Called for ID: ${id}`);
        await this.orchestrator.deleteMemory(id);
    }

    /**
     * Retrieve a single memory by its ID. Returns null if not found.
     */
    /**
     * Retrieve a single memory by its ID. Returns null if not found.
     */
    async getMemoryById(id: string): Promise<MemoryWithId | null> {
        this.loggingService.trace(`[getMemoryById] Delegating to orchestrator`);
        return await this.orchestrator.getMemoryById(id);
    }

    // Get counts of memories per category
    async getCategoryCounts(): Promise<Record<MemoryCategory, number>> {
        this.loggingService.trace('[getCategoryCounts] Delegating to orchestrator');
        return await this.orchestrator.getCategoryCounts();
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
        await this.orchestrator.deleteCollection();
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

        if (generateReport) {
            // Generate and save a Markdown report after each search
            try {
                const filePath = await this.memoryReportService.generateAndSavePostSearchAggregationReport(
                    result as any,
                    this.embeddingClient.modelName
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

    async getDatabaseStatus(): Promise<{ vectorCount: number, graphCount: number }> {
        return await this.orchestrator.getDatabaseStatus();
    }

    async getVectorStatus(): Promise<number> {
        return await this.orchestrator.getVectorStatus();
    }

    async getGraphStatus(): Promise<number> {
        return await this.orchestrator.getGraphStatus();
    }
}


export { MemoryRAGSystem };
