import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { Memory } from '../models/memory';
import { MemoryCategory } from '../models/memoryCategory';
import { MemoryRAGSystem } from './MemoryRAGSystem';

const DATA_DIR = path.join(process.cwd(), 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'memoryQueue.json');
const TAGS_FILE = path.join(process.cwd(), 'src', 'samples', 'allTags.json');

export interface MemoryQueueItem extends Memory {
    id: string;
    addedAt: string;
}

export class ReviewMemoriesService {
    private memorySystem: MemoryRAGSystem;

    constructor(memorySystem: MemoryRAGSystem) {
        this.memorySystem = memorySystem;
    }

    private async getQueueData(): Promise<MemoryQueueItem[]> {
        try {
            const data = await fs.readFile(QUEUE_FILE, 'utf-8');
            return JSON.parse(data);
        } catch (error) {
            if ((error as any).code === 'ENOENT') {
                return [];
            }
            throw error;
        }
    }

    private async saveQueueData(queue: MemoryQueueItem[]) {
        await fs.mkdir(DATA_DIR, { recursive: true });
        await fs.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2));
    }

    async getQueue(): Promise<MemoryQueueItem[]> {
        return this.getQueueData();
    }

    async addToQueue(memory: Memory): Promise<MemoryQueueItem> {
        // Generate metadata
        await this.memorySystem.loadInferenceModel();
        const prepared = await this.memorySystem.summarizeClassifyAndPrepareMemory(memory);
        const now = new Date().toISOString();

        const newItem: MemoryQueueItem = {
            id: randomUUID(),
            Content: memory.Content,
            Description: prepared.description,
            Category: prepared.category,
            Tags: prepared.tagsList,
            addedAt: now,
            LastUpdated: now
        };

        const queue = await this.getQueueData();
        queue.push(newItem);
        await this.saveQueueData(queue);

        return newItem;
    }

    async updateQueueItem(id: string, updates: Partial<MemoryQueueItem>): Promise<MemoryQueueItem | null> {
        const queue = await this.getQueueData();
        const index = queue.findIndex(item => item.id === id);

        if (index === -1) {
            return null;
        }

        // Prevent updating immutable fields
        delete updates.id;
        delete updates.addedAt;

        queue[index] = { ...queue[index], ...updates };
        await this.saveQueueData(queue);

        return queue[index];
    }

    async deleteFromQueue(id: string): Promise<boolean> {
        const queue = await this.getQueueData();
        const filteredQueue = queue.filter(item => item.id !== id);

        if (queue.length === filteredQueue.length) {
            return false;
        }

        await this.saveQueueData(filteredQueue);
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
        const queue = await this.getQueueData();
        const index = queue.findIndex(item => item.id === id);

        if (index === -1) {
            return null;
        }

        const item = queue[index];

        // Load embedding model if not loaded (upsertMemory doesn't do it, but generateEmbedding does check)
        await this.memorySystem.loadEmbeddingModel();
        
        // Generate embedding for the content
        const embedding = await this.memorySystem.generateEmbedding(item.Content);

        // Upsert to vector DB
        // We use the queue item's ID as the memory ID to maintain traceability if needed, 
        // or we could let upsertMemory generate a new one if we passed undefined, but passing item.id is better.
        const memoryId = await this.memorySystem.upsertMemory(item, embedding, item.id);

        // Remove from queue
        queue.splice(index, 1);
        await this.saveQueueData(queue);

        return memoryId;
    }
}
