import { QdrantClient } from '@qdrant/js-client-rest';
import { LMStudioClient } from '@lmstudio/sdk';
import { PromptTemplateService } from '../services/promptTemplateService';
import { env } from 'process';
import { MemoryCategory } from '../models/memoryCategory';
import { Memory, MemoryWithId } from '../models/memory';

const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text-v1.5';
const DEFAULT_MODEL_NAME = 'llama-3.2-3b-instruct';

class MemoryRAGSystem {
    private client: QdrantClient;
    private lmStudio: LMStudioClient;
    private embeddingModel: any;
    private modelName: string;
    private promptTemplateService: PromptTemplateService = new PromptTemplateService('../prompts');

    private readonly COLLECTION_NAME = 'memories';
    private readonly VECTOR_SIZE = 768;

    constructor(qdrantUrl: string, embeddingModelName: string = DEFAULT_EMBEDDING_MODEL) {
        this.client = new QdrantClient({ url: qdrantUrl });
        this.lmStudio = new LMStudioClient();
        this.modelName = embeddingModelName;
    }

    async loadEmbeddingModel(): Promise<void> {
        try {
            console.log(`Loading embedding model: ${this.modelName}`);
            this.embeddingModel = await this.lmStudio.embedding.model(this.modelName);
            console.log('Embedding model loaded successfully');
        } catch (error) {
            console.error('Error loading embedding model:', error);
            throw new Error('Failed to load embedding model. Make sure LM Studio is running and the model is loaded.');
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

                console.log('Collection initialized successfully');
            } else {
                console.log('Collection already exists');
            }
        } catch (error) {
            console.error('Error initializing collection:', error);
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
            console.error('Error in summarizeClassifyAndTagTextParallel:', error);
            throw new Error('Failed to classify, tag, and summarize text in parallel');
        }
    }

    private async summarizeText(text: string): Promise<string> {
        const model = await this.lmStudio.llm.model(env.SUMMARIZATION_MODEL || DEFAULT_MODEL_NAME);
        const prompt = `Summarize the following memory content for use as a description:\n\n${text}\n\nSummary:`;
        const response = await this.timeModelResponse(() => model.respond(prompt), 'summarizeText');
        return response.content.trim();
    }

    private async classifyText(text: string): Promise<string> {
        try {
            const model = await this.lmStudio.llm.model(env.CLASSIFICATION_MODEL || DEFAULT_MODEL_NAME);
            const prompt = this.promptTemplateService.renderClassification(text);
            const response = await this.timeModelResponse(() => model.respond(prompt), 'classifyText');
            const raw = response.content.trim();
            console.debug('Raw classification response:', raw);
            return raw;
        } catch (error) {
            console.error('Error classifying text:', error);
            throw new Error('Failed to classify text');
        }
    }

    private async tagText(text: string): Promise<string[]> {
        try {
            const model = await this.lmStudio.llm.model(env.TAGGING_MODEL || DEFAULT_MODEL_NAME);
            const prompt = this.promptTemplateService.renderTagging(text);
            const response = await this.timeModelResponse(() => model.respond(prompt), 'tagText');
            const raw = response.content.trim();
            console.debug('Raw tags response:', raw);
            return raw.split(',').map(t => t.trim()).filter(t => t.length > 0);
        } catch (error) {
            console.error('Error tagging text:', error);
            throw new Error('Failed to generate tags');
        }
    }

    private async generateEmbedding(text: string): Promise<number[]> {
        if (!this.embeddingModel) {
            throw new Error('Embedding model not loaded. Call loadEmbeddingModel() first.');
        }

        try {
            const result = await this.timeModelResponse(() => this.embeddingModel.embed(text), 'generateEmbedding') as { embedding: number[] };
            return result.embedding;
        } catch (error) {
            console.error('Error generating embedding:', error);
            throw new Error('Failed to generate embedding');
        }
    }

    async addMemory(memory: Memory): Promise<string> {
        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const { summary, classification, tags } = await this.summarizeClassifyAndTagTextParallel(memory.Content);

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

        const searchableText = memory.Content;
        const embedding = await this.generateEmbedding(searchableText);

        await this.client.upsert(this.COLLECTION_NAME, {
            points: [
                {
                    id,
                    vector: embedding,
                    payload: {
                        Content: memory.Content,
                        Description: description,
                        Tags: tagsList,
                        Category: category,
                        LastUpdated: new Date().toISOString()
                    }
                }
            ]
        });

        console.log(`Memory added with ID: ${id}`);
        return id;
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
            ...(result.payload as unknown as Memory)
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
        console.info(`[${caller}] Model response time: ${duration}ms`);
        return result;
    }
}

export { MemoryRAGSystem };
