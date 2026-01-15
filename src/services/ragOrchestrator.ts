import { VectorService } from './vectorService';
import { GraphService } from './graphService';
import { SqlService } from './sqlService';
import { Memory, MemoryWithId } from '../models/memory';
import { MemoryCategory } from '../models/memoryCategory';
import { LoggingService } from './loggingService';
import { ReminderService } from './reminderService';
import { config } from './configService';

export class RAGOrchestrator {
    private vectorService: VectorService;
    private graphService: GraphService;
    private sqlService: SqlService;
    private loggingService: LoggingService;
    private reminderService: ReminderService;

    constructor(loggingService: LoggingService) {
        this.loggingService = loggingService;
        
        // Initialize services
        this.vectorService = new VectorService(config.QDRANT_URL, this.loggingService);
        this.graphService = new GraphService(config.NEO4J_URI, config.NEO4J_USER, config.NEO4J_PASSWORD);
        this.sqlService = new SqlService();
        this.reminderService = new ReminderService(config.TODOIST_TOKEN, this.loggingService);
    }

    async initialize(): Promise<void> {
        this.loggingService.log('[RAGOrchestrator] Initializing services...');
        await Promise.all([
            this.vectorService.initializeCollection(),
            this.graphService.initializeSchema()
        ]);
        this.loggingService.log('[RAGOrchestrator] Services initialized.');
    }

    async addMemory(memory: Memory, embedding: number[], id: string, model?: string, durationMilliseconds?: number): Promise<string> {
        this.loggingService.trace(`[RAGOrchestrator.addMemory] Adding memory ${id} to both stores`);

        // Parallel execution for dual-write to vector and graph stores
        await Promise.all([
            this.vectorService.upsertMemory(memory, embedding, id),
            this.graphService.upsertMemory({ id, ...memory }, embedding)
        ]);

        // Add to SQL for relational tracking and history
        // Note: SqlService.addMemory returns a numeric ID, but we use the UUID from vector/graph stores
        await this.sqlService.addMemory(
            memory.Content,
            memory.Description || '',
            memory.Tags || [],
            memory.Category || 'Uncategorized',
            memory.Status,
            model,
            durationMilliseconds
        );

        // If memory is a reminder, create a task in Todoist
        if (memory.Category === MemoryCategory.REMINDER) {
            this.loggingService.info(`[RAGOrchestrator.addMemory] Memory is a Reminder, creating Todoist task`);
            await this.reminderService.createTask(memory);
        }

        return id;
    }

    async updateMemory(id: string, updates: Partial<Memory>, embedding?: number[]): Promise<void> {
        this.loggingService.trace(`[RAGOrchestrator.updateMemory] Updating memory ${id}`);

        // Fetch current memory from Vector Store (source of truth for content)
        const currentMemory = await this.vectorService.getMemoryById(id);
        if (!currentMemory) {
            throw new Error(`Memory ${id} not found`);
        }

        const updatedMemory: MemoryWithId = {
            ...currentMemory,
            ...updates,
            LastUpdated: new Date().toISOString()
        };

        await Promise.all([
            this.vectorService.updateMemory(id, updates, embedding),
            this.graphService.upsertMemory(updatedMemory, embedding) // Upsert handles update in Graph logic
        ]);
    }

    async deleteMemory(id: string): Promise<void> {
        this.loggingService.trace(`[RAGOrchestrator.deleteMemory] Deleting memory ${id}`);

        await Promise.all([
            this.vectorService.deleteMemory(id),
            this.graphService.deleteMemory(id)
        ]);
    }

    // Read/Search Methods - Delegating primarily to VectorService for now, but ready for Graph

    async getMemoriesByCategory(category: MemoryCategory, limit: number = 10): Promise<MemoryWithId[]> {
        return this.vectorService.getMemoriesByCategory(category, limit);
    }

    async searchMemoriesWithEmbedding(queryEmbedding: number[], category?: MemoryCategory, limit: number = 5): Promise<MemoryWithId[]> {
        return this.vectorService.searchMemoriesWithEmbedding(queryEmbedding, category, limit);
    }

    async searchByTags(tags: string[], category?: MemoryCategory): Promise<MemoryWithId[]> {
        return this.vectorService.searchByTags(tags, category);
    }

    async getMemoryById(id: string): Promise<MemoryWithId | null> {
        return this.vectorService.getMemoryById(id);
    }

    async getCategoryCounts(): Promise<Record<MemoryCategory, number>> {
        return this.vectorService.getCategoryCounts();
    }

    async deleteCollection(): Promise<void> {
        await this.vectorService.deleteCollection();
        // Graph cleanup?
    }

    // Graph specific exposures
    async getRelatedMemories(id: string): Promise<any> {
        return this.graphService.getRelatedMemories(id);
    }

    /**
     * Performs parallel vector and graph search to retrieve both semantic and relationship-based results.
     * Useful for RAG systems that want to present diverse perspectives from both modalities.
     * 
     * @param queryEmbedding Vector embedding for semantic similarity search
     * @param category Optional category filter
     * @param limit Maximum results from each modality
     * @returns { vectorResults, graphResults } both arrays of MemoryWithId
     */
    async searchVectorAndGraphParallel(
        queryEmbedding: number[],
        category?: MemoryCategory,
        limit: number = 5
    ): Promise<{ vectorResults: MemoryWithId[], graphResults: any[] }> {
        this.loggingService.trace('[searchVectorAndGraphParallel] Called');

        // Execute both searches in parallel for efficiency
        const [vectorResults, graphResults] = await Promise.all([
            this.vectorService.searchMemoriesWithEmbedding(queryEmbedding, category, limit),
            this.graphService.getMemoriesByKeywordAndSimilarity(queryEmbedding, limit)
                .catch(err => {
                    this.loggingService.error(`[searchVectorAndGraphParallel] Graph search failed: ${err}`);
                    return []; // Fallback to empty if graph search unavailable
                })
        ]);

        return { vectorResults, graphResults };
    }

    async getDatabaseStatus(): Promise<{ vectorCount: number, graphCount: number, sqlCount: number }> {
        const [vectorCount, graphCount, sqlCount] = await Promise.all([
            this.getVectorStatus(),
            this.getGraphStatus(),
            this.getSqlStatus()
        ]);

        return { vectorCount, graphCount, sqlCount };
    }

    async getVectorStatus(): Promise<number> {
        return this.vectorService.getRecordCount().catch(err => {
            this.loggingService.error(`[RAGOrchestrator] Failed to get vector count: ${err}`);
            return -1;
        });
    }

    async getGraphStatus(): Promise<number> {
        return this.graphService.getRelationshipCount().catch(err => {
            this.loggingService.error(`[RAGOrchestrator] Failed to get graph relationship count: ${err}`);
            return -1;
        });
    }

    async getSqlStatus(): Promise<number> {
        return this.sqlService.getMemoryCount().catch(err => {
            this.loggingService.error(`[RAGOrchestrator] Failed to get sql memory count: ${err}`);
            return -1;
        });
    }
}
