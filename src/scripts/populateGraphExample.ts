import { GraphService } from '../services/graphService';
import { MemoryCategory } from '../models/memoryCategory';
import { config } from '../services/configService';
import fs from 'fs';
import path from 'path';

async function main() {
    console.log(`Connecting to Neo4j at ${config.NEO4J_URI}...`);
    const graphService = new GraphService(config.NEO4J_URI, config.NEO4J_USER, config.NEO4J_PASSWORD, config.NEO4J_DATABASE);

    try {
        // 1. Initialize Schema
        console.log('Initializing schema...');
        await graphService.initializeSchema();

        // 2. Load Seed Data
        const seedPath = path.join(process.cwd(), 'src/samples/seedMemories.json');
        console.log(`Reading seed data from ${seedPath}`);
        const seedData = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
        const memories = seedData.memories;

        console.log(`Loading ${memories.length} seed memories...`);

        // 3. Seed Graph
        // We'll use a deterministic ID based on index for simplicity in this seed script, 
        // similar to how testGraphService did it, OR we can generate UUIDs if they don't exist.
        // For matching with vector db in a real scenario, we'd need shared IDs. 
        // For this task, we'll assume the system uses these 'seed-X' IDs or we just want to test graph topology.

        for (let i = 0; i < memories.length; i++) {
            const m = memories[i];
            const memoryWithId = {
                id: `seed-${i}`,
                Content: m.content,
                Description: m.description,
                LastUpdated: new Date().toISOString(),
                Category: m.category as MemoryCategory,
                Tags: m.tags
            };

            // In a real app, we would generate a real embedding. 
            // For graph topology testing, a dummy or empty embedding is fine if we aren't testing vector search *in Neo4j*.
            // The prompt implies we want to combine Vector (Qdrant) + Graph (Neo4j).
            // We'll pass a dummy embedding here.
            const fakeEmbedding = Array(1536).fill(0).map(() => Math.random());

            process.stdout.write(`\rUpserting memory ${i + 1}/${memories.length}`);
            await graphService.upsertMemory(memoryWithId, fakeEmbedding);
        }
        console.log('\nSeed initialization complete.');

    } catch (error) {
        console.error('Population failed:', error);
        process.exit(1);
    } finally {
        await graphService.close();
    }
}

main();
