import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { randomUUID } from 'crypto';
import { memorySystem } from './qdrantAPI';
import { Memory } from '../models/memory';
import { MemoryCategory } from '../models/memoryCategory';

const reviewRouter = Router();
const DATA_DIR = path.join(process.cwd(), 'data');
const QUEUE_FILE = path.join(DATA_DIR, 'memoryQueue.json');

interface MemoryQueueItem extends Memory {
    id: string;
    addedAt: string;
}

// Helper to read queue
async function getQueue(): Promise<MemoryQueueItem[]> {
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

// Helper to save queue
async function saveQueue(queue: MemoryQueueItem[]) {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(QUEUE_FILE, JSON.stringify(queue, null, 2));
}

// POST /api/review/queue - Add a new memory to the review queue (generates metadata)
reviewRouter.post('/review/queue', async (req: Request, res: Response) => {
    try {
        const memory: Memory = req.body;

        // Validate required fields
        if (!memory.Content) {
            return res.status(400).json({
                error: 'Content is required'
            });
        }

        // Generate metadata using the existing memory system
        // We need to load the inference model first as summarizeClassifyAndPrepareMemory expects it
        await memorySystem.loadInferenceModel();
        const prepared = await memorySystem.summarizeClassifyAndPrepareMemory(memory);
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

        const queue = await getQueue();
        queue.push(newItem);
        await saveQueue(queue);

        res.status(201).json({ 
            message: 'Memory added to review queue', 
            item: newItem 
        });
    } catch (error) {
        console.error('Error adding to review queue:', error);
        res.status(500).json({ error: 'Failed to add memory to review queue' });
    }
});

// GET /api/review/queue - Get all memories in the review queue
reviewRouter.get('/review/queue', async (req: Request, res: Response) => {
    try {
        const queue = await getQueue();
        res.json(queue);
    } catch (error) {
        console.error('Error retrieving review queue:', error);
        res.status(500).json({ error: 'Failed to retrieve review queue' });
    }
});

// PUT /api/review/queue/:id - Update a memory in the review queue
reviewRouter.put('/review/queue/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const updates: Partial<MemoryQueueItem> = req.body;
        
        // Prevent updating immutable fields if necessary, but for now allow all
        delete updates.id; // Don't allow ID update
        delete updates.addedAt; // Don't allow addedAt update

        const queue = await getQueue();
        const index = queue.findIndex(item => item.id === id);

        if (index === -1) {
            return res.status(404).json({ error: 'Memory not found in queue' });
        }

        // Validate category if provided
        if (updates.Category && !Object.values(MemoryCategory).includes(updates.Category)) {
            return res.status(400).json({
                error: 'Invalid category',
                validCategories: Object.values(MemoryCategory)
            });
        }

        queue[index] = { ...queue[index], ...updates };
        await saveQueue(queue);

        res.json({ 
            message: 'Memory updated in queue', 
            item: queue[index] 
        });
    } catch (error) {
        console.error('Error updating review queue item:', error);
        res.status(500).json({ error: 'Failed to update review queue item' });
    }
});

// DELETE /api/review/queue/:id - Delete a memory from the review queue
reviewRouter.delete('/review/queue/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const queue = await getQueue();
        const filteredQueue = queue.filter(item => item.id !== id);

        if (queue.length === filteredQueue.length) {
            return res.status(404).json({ error: 'Memory not found in queue' });
        }

        await saveQueue(filteredQueue);
        res.json({ message: 'Memory removed from review queue' });
    } catch (error) {
        console.error('Error deleting from review queue:', error);
        res.status(500).json({ error: 'Failed to delete from review queue' });
    }
});

export { reviewRouter };
