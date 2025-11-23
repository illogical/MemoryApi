import express, { Request, Response } from 'express';
import dotenv from 'dotenv';
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { MemoryCategory } from '../models/memoryCategory';
import { Memory } from '../models/memory';

dotenv.config();

const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text-v1.5';

// Express API Setup
const app = express();
app.use(express.json());

const memorySystem = new MemoryRAGSystem(
    process.env.QDRANT_URL || 'http://localhost:6333',
    process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL
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
    console.log(`Using embedding model: ${process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL}`);
});

export { MemoryRAGSystem, app };