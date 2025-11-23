
import { config } from 'dotenv';
config();
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { SeedMemoryLoader } from '../services/SeedMemoryLoader';
import { Memory } from '../models/memory';
import { MemoryCategory } from '../models/memoryCategory';

async function main() {
    // Load config from environment
    const qdrantUrl = process.env.QDRANT_URL;
    const embeddingModel = process.env.EMBEDDING_MODEL;
    if (!qdrantUrl || !embeddingModel) {
        console.error('Missing QDRANT_URL or EMBEDDING_MODEL in environment variables.');
        process.exit(1);
    }
    // Instantiate your MemoryRAGSystem with config
    const ragSystem = new MemoryRAGSystem(qdrantUrl, embeddingModel);
    try {
        await ragSystem.deleteCollection();
    } catch (error) {
        console.error('Failed to delete collection:', error);
        process.exit(1);
    }

    // Load seed file path from command-line argument
    const path = await import('path');
    if (!process.argv[2]) {
        throw new Error('Seed file path must be provided as a command-line argument.');
    }
    const seedFilePath = path.resolve(process.argv[2]);

    // Use SeedMemoryLoader to load and parse the JSON file
    const loader = new SeedMemoryLoader(ragSystem);
    let seedMemories: Memory[] = [];
    try {
        seedMemories = await loader.loadSeedMemoriesToMemoryObjects(seedFilePath);
    } catch (err) {
        console.error('Error loading seed memories from file:', err);
        process.exit(1);
    }

    // Efficiently add memories to Qdrant by first loading the inference model and initializing the collection to prepare for summarization/classification/tagging
    await ragSystem.initializeCollection();
    await ragSystem.loadInferenceModel();

    // Summarize/classify/tag all memories
    const preparedMemories = await Promise.all(
        seedMemories.map(async (memory) => {
            try {
                const prepared = await ragSystem.summarizeClassifyAndPrepareMemory(memory);
                return {
                    ...memory,
                    Description: prepared.description,
                    Category: prepared.category,
                    Tags: prepared.tagsList,
                    summary: prepared.summary,
                    classification: prepared.classification,
                    tags: prepared.tags
                };
            } catch (err) {
                console.error('Error summarizing/classifying/tagging:', err, memory);
                return null;
            }
        })
    );
    const validMemories = preparedMemories.filter(m => m !== null) as Array<Memory & { summary: string; classification: string; tags: string[] }>;

    // Load the embedding model once before generating embeddings for all memories
    await ragSystem.loadEmbeddingModel();

    // Generate embeddings and upsert all memories
    let loadedCount = 0;
    for (const mem of validMemories) {
        try {
            const embedding = await ragSystem.generateEmbedding(mem.Content);
            await ragSystem.upsertMemory(mem, embedding);
            loadedCount++;
        } catch (err) {
            console.error('Error upserting memory:', err, mem);
        }
    }
    console.log(`Loaded ${loadedCount} seed memories from ${seedFilePath}`);
}

main().catch((err) => {
    console.error('Error loading seed memories:', err);
    process.exit(1);
});
