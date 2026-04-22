import { Memory } from '../models/memory';
import { MemoryCategory } from '../models/memoryCategory';
import { MemoryDurability } from '../models/memoryDurability';
import { MemoryRAGSystem } from './memoryRAGSystem';
import { SqlService } from './sqlService';
import { LoggingService } from './loggingService';
import path from 'path';
import fs from 'fs/promises';

const TAGS_FILE = path.join(process.cwd(), 'src', 'samples', 'allTags.json');

export interface MemoryQueueItem extends Memory {
    id: string; // Maintain ID as string for frontend compatibility, though SQL uses int
    addedAt: string;
    Durability?: MemoryDurability;
}

export class ReviewMemoriesService {
    private memorySystem: MemoryRAGSystem;
    private sqlService: SqlService;
    private logger: LoggingService;

    constructor(memorySystem: MemoryRAGSystem) {
        this.memorySystem = memorySystem;
        this.sqlService = this.memorySystem.getSqlService();
        this.logger = new LoggingService();
    }

    async getQueue(): Promise<MemoryQueueItem[]> {
        const rows = await this.sqlService.getMemoriesByStatus('New');

        return rows.map(row => ({
            id: row.ID.toString(),
            Content: row.Content,
            Description: row.Description,
            Category: row.Category as MemoryCategory,
            Tags: JSON.parse(row.Tags || '[]'),
            Durability: row.Durability as MemoryDurability | undefined,
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
            Durability: row.Durability as MemoryDurability | undefined,
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
        const newDurability = updates.Durability ?? current.Durability;

        // Update logic in SqlService handles history snapshot
        await this.sqlService.updateMemory(
            memoryId,
            newContent,
            newDescription,
            newTags,
            newCategory,
            undefined, // status: keep current (New), only changed on commit
            newDurability
        );

        const updatedRow = await this.sqlService.getMemory(memoryId);
        return {
            id: updatedRow.ID.toString(),
            Content: updatedRow.Content,
            Description: updatedRow.Description,
            Category: updatedRow.Category as MemoryCategory,
            Tags: JSON.parse(updatedRow.Tags || '[]'),
            Durability: updatedRow.Durability as MemoryDurability | undefined,
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

    getDurabilities(): { value: string; label: string; description: string; priority: number }[] {
        return [
            {
                value: MemoryDurability.Durable,
                label: 'Durable',
                description: 'Stable long-term fact — preferences, skills, installed tools, habits',
                priority: 1
            },
            {
                value: MemoryDurability.Working,
                label: 'Working',
                description: 'Currently active but may change — in-progress projects, drafts',
                priority: 2
            },
            {
                value: MemoryDurability.Historical,
                label: 'Historical',
                description: 'Past events or completed items — conferences attended, old reminders',
                priority: 3
            },
            {
                value: MemoryDurability.Temporary,
                label: 'Temporary',
                description: 'Short-lived — appointments, time-sensitive reminders',
                priority: 4
            }
        ];
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
        this.logger.info(`[commitMemory] Starting commit for memory ID: ${id}`);
        
        try {
            const memoryId = parseInt(id);
            if (isNaN(memoryId)) {
                this.logger.error(`[commitMemory] Invalid memory ID format: ${id}`);
                return null;
            }
            this.logger.debug(`[commitMemory] Parsed memory ID: ${memoryId}`);

            this.logger.debug(`[commitMemory] Fetching memory from SQL...`);
            const row = await this.sqlService.getMemory(memoryId);
            if (!row) {
                this.logger.error(`[commitMemory] Memory not found in SQL: ${memoryId}`);
                return null;
            }
            this.logger.debug(`[commitMemory] Memory retrieved: Content length=${row.Content.length}, Category=${row.Category}`);

            // Generate embedding for the content
            this.logger.debug(`[commitMemory] Generating embedding for content...`);
            const embedding = await this.memorySystem.generateEmbedding(row.Content);
            this.logger.debug(`[commitMemory] Embedding generated: dimension=${embedding?.length || 0}`);

            // Prepare memory data
            const memoryData: Memory = {
                Content: row.Content,
                Description: row.Description,
                Category: row.Category,
                Tags: JSON.parse(row.Tags || '[]'),
                LastUpdated: row.LastUpdated,
                Status: row.Status
            };
            this.logger.debug(`[commitMemory] Memory data prepared: Tags=${memoryData.Tags?.length}`);

            // Upsert to vector DB
            this.logger.debug(`[commitMemory] Upserting to vector DB with ID: ${id}`);
            const vectorId = await this.memorySystem.upsertMemory(memoryData, embedding, id);
            this.logger.info(`[commitMemory] Vector DB upsert completed. Vector ID: ${vectorId}`);

            this.logger.debug(`[commitMemory] Shared upsert flow updated SQL status and relation IDs for memory ${memoryId}`);

            this.logger.info(`[commitMemory] Successfully committed memory ${memoryId} with vectorId: ${vectorId}`);
            return vectorId;
        } catch (error) {
            this.logger.error(`[commitMemory] Error committing memory ${id}: ${error instanceof Error ? error.message : String(error)}`);
            if (error instanceof Error && error.stack) {
                this.logger.error(`[commitMemory] Stack trace: ${error.stack}`);
            }
            throw error;
        }
    }
}
