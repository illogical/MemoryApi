import { Router, Request, Response } from 'express';
import { memorySystem } from './qdrantAPI';
import { ReviewMemoriesService } from '../services/reviewMemoriesService';
import { Memory } from '../models/memory';
import { MemoryCategory } from '../models/memoryCategory';

const reviewRouter = Router();
const reviewService = new ReviewMemoriesService(memorySystem);

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

        const newItem = await reviewService.addToQueue(memory);

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
        const queue = await reviewService.getQueue();
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
        const updates = req.body;
        
        // Validate category if provided
        if (updates.Category && !Object.values(MemoryCategory).includes(updates.Category)) {
            return res.status(400).json({
                error: 'Invalid category',
                validCategories: Object.values(MemoryCategory)
            });
        }

        const updatedItem = await reviewService.updateQueueItem(id, updates);

        if (!updatedItem) {
            return res.status(404).json({ error: 'Memory not found in queue' });
        }

        res.json({ 
            message: 'Memory updated in queue', 
            item: updatedItem 
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
        const success = await reviewService.deleteFromQueue(id);

        if (!success) {
            return res.status(404).json({ error: 'Memory not found in queue' });
        }

        res.json({ message: 'Memory removed from review queue' });
    } catch (error) {
        console.error('Error deleting from review queue:', error);
        res.status(500).json({ error: 'Failed to delete from review queue' });
    }
});

// GET /api/review/categories - Get all available categories
reviewRouter.get('/review/categories', (req: Request, res: Response) => {
    try {
        const categories = reviewService.getCategories();
        res.json(categories);
    } catch (error) {
        console.error('Error retrieving categories:', error);
        res.status(500).json({ error: 'Failed to retrieve categories' });
    }
});

// GET /api/review/tags - Get all available tags for auto-complete
reviewRouter.get('/review/tags', async (req: Request, res: Response) => {
    try {
        const tags = await reviewService.getAllTags();
        res.json(tags);
    } catch (error) {
        console.error('Error retrieving tags:', error);
        res.status(500).json({ error: 'Failed to retrieve tags' });
    }
});

// POST /api/review/commit/:id - Commit a memory from the queue to the vector database
reviewRouter.post('/review/commit/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const memoryId = await reviewService.commitMemory(id);

        if (!memoryId) {
            return res.status(404).json({ error: 'Memory not found in queue' });
        }

        res.json({ 
            message: 'Memory committed to database', 
            id: memoryId 
        });
    } catch (error) {
        console.error('Error committing memory:', error);
        res.status(500).json({ error: 'Failed to commit memory' });
    }
});

export { reviewRouter };
