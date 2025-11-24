import { QdrantClient } from '@qdrant/js-client-rest';
import { randomUUID } from 'crypto';
import { LMStudioClient, LLM, EmbeddingModel } from '@lmstudio/sdk';
import { PromptTemplateService } from './promptTemplateService';
import { LoggingService } from './LoggingService';
import { env } from 'process';
import { MemoryCategory } from '../models/memoryCategory';
import { Memory, MemoryWithId } from '../models/memory';

const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text-v1.5';
const DEFAULT_MODEL_NAME = 'llama-3.2-3b-instruct';

class MemoryRAGSystem {
    private client: QdrantClient;
    private lmStudio: LMStudioClient;
    private embeddingModel: EmbeddingModel | null = null;
    private embeddingModelName: string;
    private model: LLM | null = null;
    private modelName: string;
    private promptTemplateService: PromptTemplateService = new PromptTemplateService(env.PROMPT_TEMPLATE_BASE_PATH || '~/prompts');
    private loggingService: LoggingService = new LoggingService();

    private readonly COLLECTION_NAME = 'memories';
    private readonly VECTOR_SIZE = 768;

    constructor(qdrantUrl: string, embeddingModelName: string = DEFAULT_EMBEDDING_MODEL, modelName: string = DEFAULT_MODEL_NAME) {
        this.client = new QdrantClient({ url: qdrantUrl });
        this.lmStudio = new LMStudioClient();
        this.embeddingModelName = embeddingModelName;
        this.modelName = modelName;
    }

    async loadEmbeddingModel(): Promise<void> {
        if (this.embeddingModel) {
            // Model already loaded, skip reloading
            return;
        }

        try {
            this.loggingService.log(`Loading embedding model: ${this.embeddingModelName}`);
            const loadedEmbeddingModel = await this.lmStudio.embedding.model(this.embeddingModelName);
            this.embeddingModel = loadedEmbeddingModel;
            this.model = null; // Clear inference model to force reload if needed
            this.loggingService.log('Embedding model loaded successfully');
        } catch (error) {
            this.loggingService.error(`Error loading embedding model: ${error}`);
            throw new Error('Failed to load embedding model. Make sure LM Studio is running and the model is loaded.');
        }
    }

    async loadInferenceModel(): Promise<void> {
        if (this.model) {
            // Model already loaded, skip reloading
            return;
        }

        try {
            this.loggingService.log(`Loading inference model: ${this.modelName}`);
            const loadedModel = await this.lmStudio.llm.model(this.modelName);
            this.model = loadedModel;
            this.embeddingModel = null; // Clear embedding model to force reload if needed
            this.loggingService.log('Inference model loaded successfully');
        } catch (error) {
            this.loggingService.error(`Error loading inference model: ${error}`);
            throw new Error('Failed to load inference model. Make sure LM Studio is running and the model is loaded.');
        }
    }

    async initializeCollection(): Promise<void> {
        try {
            const collections = await this.client.getCollections();
            const exists = collections.collections.some(
                c => c.name === this.COLLECTION_NAME
            );

            if (!exists) {
                await this.client.createCollection(this.COLLECTION_NAME, {
                    vectors: {
                        size: this.VECTOR_SIZE,
                        distance: 'Cosine'
                    }
                });

                await this.client.createPayloadIndex(this.COLLECTION_NAME, {
                    field_name: 'Category',
                    field_schema: 'keyword'
                });

                await this.client.createPayloadIndex(this.COLLECTION_NAME, {
                    field_name: 'Tags',
                    field_schema: 'keyword'
                });

                this.loggingService.log('Collection initialized successfully');
            } else {
                this.loggingService.log('Collection already exists');
            }
        } catch (error) {
            this.loggingService.error(`Error initializing collection: ${error}`);
            throw error;
        }
    }

    async summarizeClassifyAndTagTextParallel(text: string): Promise<{ summary: string, classification: string; tags: string[]; }> {
        try {
            const [summary, classification, tags] = await Promise.all([
                this.summarizeText(text),
                this.classifyText(text),
                this.tagText(text)
            ]);
            return { summary, classification, tags };
        } catch (error) {
            this.loggingService.error(`Error in summarizeClassifyAndTagTextParallel: ${error}`);
            throw new Error('Failed to classify, tag, and summarize text in parallel');
        }
    }

    private async summarizeText(text: string): Promise<string> {
        if (!this.model) throw new Error('[summarizeText] Inference model not loaded');
        const prompt = `Summarize the following memory content for use as a description:\n\n${text}\n\nSummary:`;
        const response = await this.timeModelResponse(() => this.model!.respond(prompt), 'summarizeText');
        return response.content.trim();
    }

    private async classifyText(text: string): Promise<string> {
        try {
            if (!this.model) throw new Error('[classifyText] Inference model not loaded');
            const prompt = this.promptTemplateService.renderClassification(text);
            const response = await this.timeModelResponse(() => this.model!.respond(prompt), 'classifyText');
            const raw = response.content.trim();
            this.loggingService.debug(`Raw classification response: ${raw}`);
            return raw;
        } catch (error) {
            this.loggingService.error(`[classifyText] Error classifying text: ${error}`);
            throw new Error('Failed to classify text');
        }
    }

    private async tagText(text: string): Promise<string[]> {
        try {
            if (!this.model) throw new Error('[tagText] Inference model not loaded');
            const prompt = this.promptTemplateService.renderTagging(text);
            const response = await this.timeModelResponse(() => this.model!.respond(prompt), 'tagText');
            const raw = response.content.trim();
            this.loggingService.debug(`Raw tags response: ${raw}`);
            return raw.split(',').map(t => t.trim()).filter(t => t.length > 0);
        } catch (error) {
            this.loggingService.error(`[tagText] Error tagging text: ${error}`);
            throw new Error('Failed to generate tags');
        }
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
        if (!this.embeddingModel) {
            this.loggingService.error(`Error loading embedding model`);
            throw new Error('Failed to generate embedding');
        }

        try {
            const result = await this.timeModelResponse(() => this.embeddingModel!.embed(text), 'generateEmbedding') as { embedding: number[] };
            return result.embedding;
        } catch (error) {
            this.loggingService.error(`Error generating embedding: ${error}`);
            throw new Error('Failed to generate embedding');
        }
    }


    /**
     * Upserts the memory record into Qdrant.
     */
    async upsertMemory(memory: Memory, embedding: number[], id?: string): Promise<string> {
        // Use a valid UUID for the memory ID
        const memoryId = id || randomUUID();
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
        this.loggingService.log(`Memory added with ID: ${memoryId}`);
        return memoryId;
    }

    /**
     * Main addMemory method, now orchestrates the above steps.
     */
    async addMemory(memory: Memory): Promise<string> {
        try {
            this.loggingService.log(`[addMemory] Received memory: ${JSON.stringify(memory, null, 2)}`);
            // Step 1: Summarize, classify, tag, and prepare memory fields
            this.loggingService.log('[addMemory] Loading inference model...');
            await this.loadInferenceModel();
            this.loggingService.log('[addMemory] Inference model loaded. Summarizing, classifying, and tagging...');
            const prepared = await this.summarizeClassifyAndPrepareMemory(memory);
            this.loggingService.log(`[addMemory] Prepared memory fields: ${JSON.stringify(prepared, null, 2)}`);
            // Step 2: Generate embedding
            this.loggingService.log('[addMemory] Loading embedding model...');
            await this.loadEmbeddingModel();
            this.loggingService.log(`[addMemory] Embedding model loaded. Generating embedding for content: ${prepared.description ? prepared.description : memory.Content}`);
            try {
                const embedding = await this.generateEmbedding(memory.Content);
                this.loggingService.log(`[addMemory] Embedding generated. Length: ${embedding.length}`);
                // Step 3: Upsert memory
                const memoryToUpsert: Memory = {
                    ...memory,
                    Description: prepared.description,
                    Category: prepared.category,
                    Tags: prepared.tagsList,
                    LastUpdated: new Date().toISOString()
                };
                this.loggingService.log(`[addMemory] Upserting memory: ${JSON.stringify(memoryToUpsert, null, 2)}`);
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
        await this.loadEmbeddingModel();
        const queryEmbedding = await this.generateEmbedding(query);

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

        const response = await this.client.search(this.COLLECTION_NAME, {
            vector: queryEmbedding,
            limit,
            filter,
            with_payload: true
        });

        return response.map(result => ({
            id: result.id.toString(),
            ...(result.payload as unknown as Memory),
            score: typeof result.score === 'number' ? result.score : undefined
        }));
    }

    async searchByTags(
        tags: string[],
        category?: MemoryCategory
    ): Promise<MemoryWithId[]> {
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

        const response = await this.client.scroll(this.COLLECTION_NAME, {
            filter: { must: mustConditions },
            limit: 100,
            with_payload: true,
            with_vector: false
        });

        return response.points.map(point => ({
            id: point.id.toString(),
            ...(point.payload as unknown as Memory)
        }));
    }

    async updateMemory(id: string, updates: Partial<Memory>): Promise<void> {
        const points = await this.client.retrieve(this.COLLECTION_NAME, {
            ids: [id],
            with_payload: true,
            with_vector: true
        });

        if (points.length === 0) {
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
            const searchableText = updatedMemory.Content;
            vector = await this.generateEmbedding(searchableText);
        }

        await this.client.upsert(this.COLLECTION_NAME, {
            points: [
                {
                    id,
                    vector,
                    payload: updatedMemory
                }
            ]
        });
    }

    async deleteMemory(id: string): Promise<void> {
        await this.client.delete(this.COLLECTION_NAME, {
            points: [id]
        });
    }

    // Get counts of memories per category
    async getCategoryCounts(): Promise<Record<MemoryCategory, number>> {
        const counts = {} as Record<MemoryCategory, number>;

        for (const category of Object.values(MemoryCategory)) {
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
        }

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
}

export { MemoryRAGSystem };
