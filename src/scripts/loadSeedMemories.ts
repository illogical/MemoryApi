
import { config } from 'dotenv';
config();
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { SeedMemoryLoader } from '../services/SeedMemoryLoader';

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
    const loader = new SeedMemoryLoader(ragSystem);
    // Allow seed file path to be passed as a command-line argument
    const path = require('path');
    if (!process.argv[2]) {
        throw new Error('Seed file path must be provided as a command-line argument.');
    }
    const seedFilePath = path.resolve(process.argv[2]);
    await loader.loadSeedMemories(seedFilePath);
}

main().catch((err) => {
    console.error('Error loading seed memories:', err);
    process.exit(1);
});
