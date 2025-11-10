// Install dependencies:
// npm install @qdrant/js-client-rest express @types/express @lmstudio/sdk dotenv
// npm install -D @types/node typescript ts-node

import { QdrantClient } from '@qdrant/js-client-rest';
import express, { Request, Response } from 'express';
import { LMStudioClient } from '@lmstudio/sdk';
import dotenv from 'dotenv';
import { PromptTemplateService } from '../services/promptTemplateService';
import { env } from 'process';

dotenv.config();

const DefaultEmbeddingModelName = 'nomic-embed-text-v1.5';

// Types and Interfaces
export enum MemoryCategory {
    PREFERENCES = 'Preferences',
    REMINDERS = 'Reminders',
    CODE_SNIPPETS = 'Code Snippets',
    HISTORY = 'History',
    NOTES = 'Notes',
    PROMPTS = 'Prompts'
}

export interface Memory {
    Content: string;
    LastUpdated: string;
    Category?: MemoryCategory;
    Description?: string;
    Tags?: string[];
}

export interface MemoryWithId extends Memory {
    id: string;
}


class MemoryRAGSystem {
    private client: QdrantClient;
    private lmStudio: LMStudioClient;
    private embeddingModel: any;
    private modelName: string;
    private promptTemplateService: PromptTemplateService = new PromptTemplateService('../prompts');

    private readonly defaultModelName = 'llama-3.2-3b-instruct';

    // Qdrant Configuration
    private readonly COLLECTION_NAME = 'memories';
    private readonly VECTOR_SIZE = 768; // nomic-embed-text-v1.5 produces 768-dimensional embeddings

    constructor(qdrantUrl: string, embeddingModelName: string = DefaultEmbeddingModelName) {
        this.client = new QdrantClient({ url: qdrantUrl });
        this.lmStudio = new LMStudioClient();
        this.modelName = embeddingModelName;
    }

    // Load the embedding model
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

    // Initialize collection with proper schema
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

                // Create payload indexes for efficient filtering
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

    /**
     * Classify, tag, and summarize text in parallel using prompt template service.
     * Returns an object with summary, classification, and tags when all complete.
     */
    async summarizeClassifyAndTagTextParallel(text: string): Promise<{ summary: string, classification: string; tags: string[];}> {
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

    // Summarize text using LM Studio
    private async summarizeText(text: string): Promise<string> {
        const model = await this.lmStudio.llm.model(env.SUMMARIZATION_MODEL || this.defaultModelName);
        const prompt = `Summarize the following memory content for use as a description:\n\n${text}\n\nSummary:`;
        const response = await model.respond(prompt);
        return response.content.trim();
    }

    // Classify text using prompt template service
    private async classifyText(text: string): Promise<string> {
        try {
            const model = await this.lmStudio.llm.model(env.CLASSIFICATION_MODEL || this.defaultModelName);
            const prompt = this.promptTemplateService.renderClassification(text);
            const response = await model.respond(prompt);
            const raw = response.content.trim();
            console.debug('Raw classification response:', raw);
            return raw;
        } catch (error) {
            console.error('Error classifying text:', error);
            throw new Error('Failed to classify text');
        }
    }

    // Generate tags using prompt template service
    private async tagText(text: string): Promise<string[]> {
        try {
            const model = await this.lmStudio.llm.model(env.TAGGING_MODEL || this.defaultModelName);
            const prompt = this.promptTemplateService.renderTagging(text);
            const response = await model.respond(prompt);
            const raw = response.content.trim();
            console.debug('Raw tags response:', raw);
            // Expecting a comma-separated list of tags
            return raw.split(',').map(t => t.trim()).filter(t => t.length > 0);
        } catch (error) {
            console.error('Error tagging text:', error);
            throw new Error('Failed to generate tags');
        }
    }


    // Generate embeddings using LM Studio
    private async generateEmbedding(text: string): Promise<number[]> {
        if (!this.embeddingModel) {
            throw new Error('Embedding model not loaded. Call loadEmbeddingModel() first.');
        }

        try {
            const { embedding } = await this.embeddingModel.embed(text);
            return embedding;
        } catch (error) {
            console.error('Error generating embedding:', error);
            throw new Error('Failed to generate embedding');
        }
    }

    // Add a new memory with automatic summary
    async addMemory(memory: Memory): Promise<string> {
        const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

        const { summary, classification, tags } = await this.summarizeClassifyAndTagTextParallel(memory.Content);

        // If Description is missing or empty, generate a summary using LM Studio
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

        // Create searchable text from memory
        //const searchableText = `${description} ${memory.Content} ${tagsList?.join(' ') || ''}`;
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

    // Retrieve memories by category
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

    // Search memories by semantic similarity
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

    // Search by tags
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

    // Update a memory
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

        // Regenerate embedding if content changed
        let vector = points[0].vector as number[];
        if (updates.Content || updates.Description || updates.Tags) {
            //const searchableText = `${updatedMemory.Description} ${updatedMemory.Content} ${updatedMemory.Tags.join(' ')}`;
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

    // Delete a memory
    async deleteMemory(id: string): Promise<void> {
        await this.client.delete(this.COLLECTION_NAME, {
            points: [id]
        });
    }

    // Get all categories with counts
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
}

// Express API Setup
const app = express();
app.use(express.json());

const memorySystem = new MemoryRAGSystem(
    process.env.QDRANT_URL || 'http://localhost:6333',
    process.env.EMBEDDING_MODEL || DefaultEmbeddingModelName
);

// Initialize on startup
async function initializeServer() {
    try {
        console.log('Initializing server...');
        await memorySystem.loadEmbeddingModel();
        await memorySystem.initializeCollection();
        console.log('Server initialization complete');
    } catch (error) {
        console.error('Failed to initialize server:', error);
        process.exit(1);
    }
}

initializeServer();

// API Endpoints

// POST /api/memories - Add a new memory
app.post('/api/memories', async (req: Request, res: Response) => {
    try {
        const memory: Memory = req.body;

        // Validate required fields
        if (!memory.Description || !memory.Content || !memory.Category) {
            return res.status(400).json({
                error: 'Description, Content, and Category are required'
            });
        }

        // Validate category
        if (!Object.values(MemoryCategory).includes(memory.Category)) {
            return res.status(400).json({
                error: 'Invalid category',
                validCategories: Object.values(MemoryCategory)
            });
        }

        const id = await memorySystem.addMemory(memory);
        res.status(201).json({ id, message: 'Memory created successfully' });
    } catch (error) {
        console.error('Error adding memory:', error);
        res.status(500).json({ error: 'Failed to add memory' });
    }
});

// GET /api/memories/category/:category - Get memories by category
app.get('/api/memories/category/:category', async (req: Request, res: Response) => {
    try {
        const category = req.params.category as MemoryCategory;
        const limit = parseInt(req.query.limit as string) || 10;

        if (!Object.values(MemoryCategory).includes(category)) {
            return res.status(400).json({
                error: 'Invalid category',
                validCategories: Object.values(MemoryCategory)
            });
        }

        const memories = await memorySystem.getMemoriesByCategory(category, limit);
        res.json({ category, count: memories.length, memories });
    } catch (error) {
        console.error('Error retrieving memories:', error);
        res.status(500).json({ error: 'Failed to retrieve memories' });
    }
});

// POST /api/memories/search - Semantic search across memories
app.post('/api/memories/search', async (req: Request, res: Response) => {
    try {
        const { query, category, limit } = req.body;

        if (!query) {
            return res.status(400).json({ error: 'Query is required' });
        }

        const memories = await memorySystem.searchMemories(
            query,
            category,
            limit || 5
        );

        res.json({ query, count: memories.length, memories });
    } catch (error) {
        console.error('Error searching memories:', error);
        res.status(500).json({ error: 'Failed to search memories' });
    }
});

// GET /api/memories/tags - Search by tags
app.get('/api/memories/tags', async (req: Request, res: Response) => {
    try {
        const tags = (req.query.tags as string)?.split(',') || [];
        const category = req.query.category as MemoryCategory | undefined;

        if (tags.length === 0) {
            return res.status(400).json({ error: 'At least one tag is required' });
        }

        const memories = await memorySystem.searchByTags(tags, category);
        res.json({ tags, count: memories.length, memories });
    } catch (error) {
        console.error('Error searching by tags:', error);
        res.status(500).json({ error: 'Failed to search by tags' });
    }
});

// PUT /api/memories/:id - Update a memory
app.put('/api/memories/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const updates: Partial<Memory> = req.body;

        await memorySystem.updateMemory(id, updates);
        res.json({ message: 'Memory updated successfully' });
    } catch (error) {
        console.error('Error updating memory:', error);
        res.status(500).json({ error: 'Failed to update memory' });
    }
});

// DELETE /api/memories/:id - Delete a memory
app.delete('/api/memories/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        await memorySystem.deleteMemory(id);
        res.json({ message: 'Memory deleted successfully' });
    } catch (error) {
        console.error('Error deleting memory:', error);
        res.status(500).json({ error: 'Failed to delete memory' });
    }
});

// GET /api/memories/stats - Get statistics
app.get('/api/memories/stats', async (req: Request, res: Response) => {
    try {
        const counts = await memorySystem.getCategoryCounts();
        res.json({ categoryCounts: counts });
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ error: 'Failed to get statistics' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Memory RAG API running on port ${PORT}`);
    console.log(`Using embedding model: ${process.env.EMBEDDING_MODEL || DefaultEmbeddingModelName}`);
});

export { MemoryRAGSystem, app };