import { Router, Request, Response } from 'express';
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { MemoryCategory } from '../models/memoryCategory';
import { Memory } from '../models/memory';
import { logger } from '../utils/logger';
import path from 'path';
import { SeedMemoryLoader } from '../services/seedMemoryLoader';

// Memory system instance (shared)
const memorySystem = new MemoryRAGSystem();
const seedMemoryLoader = new SeedMemoryLoader();

// Initialization function to be called by the main entrypoint
export async function initializeMemorySystem() {
    logger.info('Initializing MemoryRAGSystem...');
    await memorySystem.initializeCollection();
    logger.info('MemoryRAGSystem initialization complete');
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
        logger.error(`Error adding memory: ${error}`);
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
        logger.error(`Error retrieving memories: ${error}`);
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
        logger.error(`Error searching memories: ${error}`);
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
        logger.error(`Error searching by tags: ${error}`);
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
        logger.error(`Error updating memory: ${error}`);
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
        logger.error(`Error deleting memory: ${error}`);
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
            },
            sql: {
                active: status.sqlCount >= 0,
                count: Math.max(0, status.sqlCount)
            }
        });
    } catch (error) {
        logger.error(`Error getting status: ${error}`);
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
        logger.error(`Error getting vector status: ${error}`);
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
        logger.error(`Error getting graph status: ${error}`);
        res.status(500).json({ error: 'Failed to get graph status' });
    }
});

// GET /api/status/sql - Get SQL database status
memoryRouter.get('/status/sql', async (req: Request, res: Response) => {
    try {
        const count = await memorySystem.getSqlStatus();
        res.json({
            active: count >= 0,
            count: Math.max(0, count)
        });
    } catch (error) {
        logger.error(`Error getting SQL status: ${error}`);
        res.status(500).json({ error: 'Failed to get SQL status' });
    }
});

// GET /api/status/model-provider - Get model provider status
memoryRouter.get('/status/model-provider', async (req: Request, res: Response) => {
    try {
        const status = await memorySystem.getModelProviderStatus();
        res.json(status);
    } catch (error) {
        logger.error(`Error getting model provider status: ${error}`);
        res.status(500).json({ error: 'Failed to get model provider status' });
    }
});

// GET /api/memories/stats - Get statistics
memoryRouter.get('/memories/stats', async (req: Request, res: Response) => {
    try {
        const counts = await memorySystem.getCategoryCounts();
        res.json({ categoryCounts: counts });
    } catch (error) {
        logger.error(`Error getting stats: ${error}`);
        res.status(500).json({ error: 'Failed to get statistics' });
    }
});

// GET /api/memories/suggested-tags - Get suggested tags from SQL
memoryRouter.get('/memories/suggested-tags', async (req: Request, res: Response) => {
    try {
        const threshold = parseInt(req.query.threshold as string) || 5;
        const tags = await memorySystem.getSqlService().getSuggestedTags(threshold);
        res.json(tags);
    } catch (error) {
        logger.error(`Error getting suggested tags: ${error}`);
        res.status(500).json({ error: 'Failed to get suggested tags' });
    }
});

// DELETE /api/memories/suggested-tags/:id - Dismiss a suggested tag
memoryRouter.delete('/memories/suggested-tags/:id', async (req: Request, res: Response) => {
    try {
        const id = parseInt(req.params.id);
        await memorySystem.getSqlService().dismissTagSuggestion(id);
        res.json({ message: 'Tag suggestion dismissed' });
    } catch (error) {
        logger.error(`Error dismissing suggested tag: ${error}`);
        res.status(500).json({ error: 'Failed to dismiss suggested tag' });
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
        logger.error(`Error retrieving memory by id: ${error}`);
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
        logger.error(`Error in search-and-summarize: ${error}`);
        res.status(500).json({ error: 'Failed to search and summarize memories' });
    }
});

// POST /api/seeds/memories - Append a memory to seedMemories.json
memoryRouter.post('/seeds/memories', async (req: Request, res: Response) => {
    try {
        const { content, description, category, tags } = req.body;

        // Validate required fields
        if (!content) {
            return res.status(400).json({ error: 'Content is required' });
        }

        // Construct seed memory object
        const seedMemory = {
            content,
            description: description || '',
            category: category || 'Note',
            tags: Array.isArray(tags) ? tags : []
        };

        const seedFilePath = path.join(__dirname, '..', 'samples', 'seedMemories.json');
        await seedMemoryLoader.appendSeedMemory(seedMemory, seedFilePath);

        logger.info(`Memory added to seedMemories.json: ${content.substring(0, 50)}...`);
        res.status(201).json({ message: 'Memory added to seed data successfully' });
    } catch (error) {
        logger.error(`Error adding memory to seed data: ${error}`);
        res.status(500).json({ error: 'Failed to add memory to seed data' });
    }
});

export { MemoryRAGSystem, memoryRouter, memorySystem };