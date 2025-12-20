import { Router, Request, Response } from 'express';
import dotenv from 'dotenv';
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { MemoryCategory } from '../models/memoryCategory';
import { Memory } from '../models/memory';

// Memory system instance (shared)
const memorySystem = new MemoryRAGSystem();

// Initialization function to be called by the main entrypoint
export async function initializeMemorySystem() {
    console.log('Initializing MemoryRAGSystem...');
    await memorySystem.initializeCollection();
    console.log('MemoryRAGSystem initialization complete');
}

// Exported router instead of standalone app
const memoryRouter = Router();

// Memory API Endpoints (mounted under /api in index.ts)

// POST /api/memories - Add a new memory
memoryRouter.post('/memories', async (req: Request, res: Response) => {
    try {
        const memory: Memory = req.body;

        // Validate required fields
        if (!memory.Content) {
            return res.status(400).json({
                error: 'Content is required'
            });
        }

        // Validate category
        if (memory.Category && !Object.values(MemoryCategory).includes(memory.Category)) {
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
memoryRouter.get('/memories/category/:category', async (req: Request, res: Response) => {
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
memoryRouter.post('/memories/search', async (req: Request, res: Response) => {
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
memoryRouter.get('/memories/tags', async (req: Request, res: Response) => {
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
memoryRouter.put('/memories/:id', async (req: Request, res: Response) => {
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
memoryRouter.delete('/memories/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        await memorySystem.deleteMemory(id);
        res.json({ message: 'Memory deleted successfully' });
    } catch (error) {
        console.error('Error deleting memory:', error);
        res.status(500).json({ error: 'Failed to delete memory' });
    }
});


// GET /api/status - Get database status
memoryRouter.get('/status', async (req: Request, res: Response) => {
    try {
        const status = await memorySystem.getDatabaseStatus();
        res.json({
            vector: {
                active: status.vectorCount >= 0,
                count: Math.max(0, status.vectorCount)
            },
            graph: {
                active: status.graphCount >= 0,
                count: Math.max(0, status.graphCount)
            }
        });
    } catch (error) {
        console.error('Error getting status:', error);
        res.status(500).json({ error: 'Failed to get status' });
    }
});

// GET /api/status/vector - Get vector database status
memoryRouter.get('/status/vector', async (req: Request, res: Response) => {
    try {
        const count = await memorySystem.getVectorStatus();
        res.json({
            active: count >= 0,
            count: Math.max(0, count)
        });
    } catch (error) {
        console.error('Error getting vector status:', error);
        res.status(500).json({ error: 'Failed to get vector status' });
    }
});

// GET /api/status/graph - Get graph database status
memoryRouter.get('/status/graph', async (req: Request, res: Response) => {
    try {
        const count = await memorySystem.getGraphStatus();
        res.json({
            active: count >= 0,
            count: Math.max(0, count)
        });
    } catch (error) {
        console.error('Error getting graph status:', error);
        res.status(500).json({ error: 'Failed to get graph status' });
    }
});

// GET /api/memories/stats - Get statistics

memoryRouter.get('/memories/stats', async (req: Request, res: Response) => {
    try {
        const counts = await memorySystem.getCategoryCounts();
        res.json({ categoryCounts: counts });
    } catch (error) {
        console.error('Error getting stats:', error);
        res.status(500).json({ error: 'Failed to get statistics' });
    }
});

// GET /api/memories/:id - Retrieve a memory by ID
memoryRouter.get('/memories/:id', async (req: Request, res: Response) => {
    try {
        const { id } = req.params;
        const memory = await memorySystem.getMemoryById(id);
        if (!memory) {
            return res.status(404).json({ error: 'Memory not found' });
        }
        res.json(memory);
    } catch (error) {
        console.error('Error retrieving memory by id:', error);
        res.status(500).json({ error: 'Failed to retrieve memory by id' });
    }
});

// POST /api/memories/search-and-summarize - Semantic search and MCP summary
memoryRouter.post('/memories/search-and-summarize', async (req: Request, res: Response) => {
    try {
        const { query, category, limit, scoreThreshold, strategy, format } = req.body;
        if (!query) {
            return res.status(400).json({ error: 'Query is required' });
        }
        const options = {
            category,
            limit,
            scoreThreshold,
            strategy,
            format
        };
        const result = await memorySystem.searchAndSummarizeForMcp(query, options);
        res.json(result);
    } catch (error) {
        console.error('Error in search-and-summarize:', error);
        res.status(500).json({ error: 'Failed to search and summarize memories' });
    }
});

export { MemoryRAGSystem, memoryRouter, memorySystem };