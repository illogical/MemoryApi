import { VectorService } from './vectorService';
import { GraphService } from './graphService';
import { Memory, MemoryWithId } from '../models/memory';
import { MemoryCategory } from '../models/memoryCategory';
import { LoggingService } from './loggingService';

export class RAGOrchestrator {
    private vectorService: VectorService;
    private graphService: GraphService;
    private loggingService: LoggingService;

    constructor(
        vectorService: VectorService,
        graphService: GraphService,
        loggingService: LoggingService
    ) {
        this.vectorService = vectorService;
        this.graphService = graphService;
        this.loggingService = loggingService;
    }

    async initialize(): Promise<void> {
        this.loggingService.log('[RAGOrchestrator] Initializing services...');
        await Promise.all([
            this.vectorService.initializeCollection(),
            this.graphService.initializeSchema()
        ]);
        this.loggingService.log('[RAGOrchestrator] Services initialized.');
    }

    async addMemory(memory: Memory, embedding: number[], id: string): Promise<string> {
        this.loggingService.trace(`[RAGOrchestrator.addMemory] Adding memory ${id} to both stores`);

        // Parallel execution for dual-write
        await Promise.all([
            this.vectorService.upsertMemory(memory, embedding, id),
            this.graphService.upsertMemory({ id, ...memory }, embedding)
        ]);

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

    async getDatabaseStatus(): Promise<{ vectorCount: number, graphCount: number }> {
        const [vectorCount, graphCount] = await Promise.all([
            this.getVectorStatus(),
            this.getGraphStatus()
        ]);

        return { vectorCount, graphCount };
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
}
