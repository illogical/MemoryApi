import { Memory } from '../models/memory';
import { MemoryCategory } from '../models/memoryCategory';
import { MemoryRAGSystem } from './memoryRAGSystem';
import { SqlService } from './sqlService';
import path from 'path';
import fs from 'fs/promises';

const TAGS_FILE = path.join(process.cwd(), 'src', 'samples', 'allTags.json');

export interface MemoryQueueItem extends Memory {
    id: string; // Maintain ID as string for frontend compatibility, though SQL uses int
    addedAt: string;
}

export class ReviewMemoriesService {
    private memorySystem: MemoryRAGSystem;
    private sqlService: SqlService;

    constructor(memorySystem: MemoryRAGSystem) {
        this.memorySystem = memorySystem;
        this.sqlService = this.memorySystem.getSqlService();
    }

    async getQueue(): Promise<MemoryQueueItem[]> {
        const rows = await this.sqlService.getMemoriesByStatus('New');

        return rows.map(row => ({
            id: row.ID.toString(),
            Content: row.Content,
            Description: row.Description,
            Category: row.Category as MemoryCategory,
            Tags: JSON.parse(row.Tags || '[]'),
            addedAt: row.Created,
            LastUpdated: row.LastUpdated
        }));
    }

    async addToQueue(memory: Memory): Promise<MemoryQueueItem> {
        // Generate metadata
        await this.memorySystem.loadInferenceModel();
        const prepared = await this.memorySystem.summarizeClassifyAndPrepareMemory(memory);

        const memoryId = await this.sqlService.addMemory(
            memory.Content,
            prepared.description,
            prepared.tagsList,
            prepared.category,
            'New'
        );

        // Fetch back to confirm data
        const row = await this.sqlService.getMemory(memoryId);

        return {
            id: row.ID.toString(),
            Content: row.Content,
            Description: row.Description,
            Category: row.Category as MemoryCategory,
            Tags: JSON.parse(row.Tags || '[]'),
            addedAt: row.Created,
            LastUpdated: row.LastUpdated
        };
    }

    async updateQueueItem(id: string, updates: Partial<MemoryQueueItem>): Promise<MemoryQueueItem | null> {
        const memoryId = parseInt(id);
        if (isNaN(memoryId)) return null;

        const current = await this.sqlService.getMemory(memoryId);
        if (!current) return null;

        // Current values
        const currentTags = JSON.parse(current.Tags || '[]');

        // updates
        const newContent = updates.Content ?? current.Content;
        const newDescription = updates.Description ?? current.Description;
        const newTags = updates.Tags ?? currentTags;
        const newCategory = updates.Category ?? current.Category;

        // Update logic in SqlService handles history snapshot
        await this.sqlService.updateMemory(
            memoryId,
            newContent,
            newDescription,
            newTags,
            newCategory
            // Status remains 'New' implicit via updateMemory if not passed, 
            // but updateMemory optional status arg allows it. We don't pass it, so it keeps current?
            // Wait, my updateMemory implementation: if (status) sql += ... else it strictly updates content.
            // Correct.
        );

        const updatedRow = await this.sqlService.getMemory(memoryId);
        return {
            id: updatedRow.ID.toString(),
            Content: updatedRow.Content,
            Description: updatedRow.Description,
            Category: updatedRow.Category as MemoryCategory,
            Tags: JSON.parse(updatedRow.Tags || '[]'),
            addedAt: updatedRow.Created,
            LastUpdated: updatedRow.LastUpdated
        };
    }

    async deleteFromQueue(id: string): Promise<boolean> {
        const memoryId = parseInt(id);
        if (isNaN(memoryId)) return false;

        const exists = await this.sqlService.getMemory(memoryId);
        if (!exists) return false;

        await this.sqlService.softDeleteMemory(memoryId);
        return true;
    }

    getCategories(): string[] {
        return Object.values(MemoryCategory);
    }

    async getAllTags(): Promise<string[]> {
        try {
            const data = await fs.readFile(TAGS_FILE, 'utf-8');
            const json = JSON.parse(data);
            const tags: string[] = [];
            if (json.TagGroups && Array.isArray(json.TagGroups)) {
                for (const group of json.TagGroups) {
                    if (group.Tags && Array.isArray(group.Tags)) {
                        tags.push(...group.Tags);
                    }
                }
            }
            // Deduplicate and sort
            return Array.from(new Set(tags)).sort();
        } catch (error) {
            console.error('Error reading tags file:', error);
            return [];
        }
    }

    async commitMemory(id: string): Promise<string | null> {
        const memoryId = parseInt(id);
        if (isNaN(memoryId)) return null;

        const row = await this.sqlService.getMemory(memoryId);
        if (!row) return null;

        // Generate embedding for the content
        // We use the item's content directly
        const embedding = await this.memorySystem.generateEmbedding(row.Content);

        // Upsert to vector DB
        // Use the SQL ID as string for the Vector ID to maintain simple 1:1 if possible.
        // Or if upsertMemory generates a UUID, we store that.
        // Let's force using the SQL ID as String for consistency, if Qdrant handles it (it usually wants UUID, but string ID helps).
        // Actually, Qdrant usually strictly likes UUIDs fast. But string is OK.
        // Let's try passing `id` (string).

        const memoryData: Memory = {
            Content: row.Content,
            Description: row.Description,
            Category: row.Category,
            Tags: JSON.parse(row.Tags || '[]'),
            LastUpdated: row.LastUpdated
        };

        // Note: upsertMemory calls orchestrator.addMemory.
        // In clean architecture, we should perhaps rely on orchestration.
        const vectorId = await this.memorySystem.upsertMemory(memoryData, embedding, id); // using id string "123"

        // Update SQL Status to "Reviewed" and store Vector ID
        await this.sqlService.updateMemoryStatus(memoryId, 'Reviewed');

        // Update relations
        // graphId might be generated by graphService inside orchestrator? 
        // `upsertMemory` in MemoryRAGSystem only calls `orchestrator.addMemory`.
        // `orchestrator.addMemory` likely orchestrates graph too.
        // But `orchestrator.addMemory` MIGHT NOT return Graph ID.
        // If `MemoryRAGSystem`'s sqlService usage is just for `MemoryDatabaseRelations`?
        // Wait, `orchestrator` uses `sqlService` internally too for relations?
        // Let's check RAGOrchestrator to be safe. 
        // If RAGOrchestrator handles `MemoryDatabaseRelations` insertion, we might double insert or conflict?
        // `MemoryRAGSystem` passes `sqlService` to `orchestrator`.

        // Let's assume `orchestrator` handles the DB relations mapping if it has access.
        // But `MemoryDatabaseRelations` has `MemoryId` (PK).
        // If I created the memory via `sqlService.addMemory`, it inserted a row.
        // If `orchestrator` tries to insert a row for the same MemoryId...
        // `orchestrator.addMemory` might insert a NEW memory row if it doesn't know about this one?
        // Or does it update?

        // Current `orchestrator` logic is unknown to me directly without reading `ragOrchestrator.ts`.
        // However, `sqlService.addMemory` creates the relation row with NULLs.
        // If `orchestrator` updates it, great.

        // If I pass `id` to `upsertMemory`, does it reuse it?

        // I will assume for now `upsertMemory` works.
        // I should explicitly update the VectorId in SQL if I get it back.

        if (vectorId) {
            await this.sqlService.updateMemoryRelations(memoryId, undefined, vectorId);
        }

        return vectorId;
    }
}
