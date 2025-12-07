import { GraphService } from '../services/graphService';
import { MemoryCategory } from '../models/memoryCategory';
import dotenv from 'dotenv';

dotenv.config();

const NEO4J_URI = process.env.NEO4J_URI || 'bolt://localhost:7687';
const NEO4J_USER = process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || 'password';

async function main() {
    console.log(`Connecting to Neo4j at ${NEO4J_URI}...`);
    const graphService = new GraphService(NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD);

    try {
        // 1. Initialize Schema
        console.log('Initializing schema...');
        await graphService.initializeSchema();

        // 2. Create a dummy memory
        const dummyMemory = {
            id: 'test-mem-001',
            Content: 'Graph databases are powerful for traversing relationships.',
            LastUpdated: new Date().toISOString(),
            Category: MemoryCategory.NOTE,
            Tags: ['graph', 'database', 'neo4j', 'test'],
            Description: 'A test memory for graph service.'
        };

        // Fake embedding (random 1536 dim vector)
        const fakeEmbedding = Array(1536).fill(0).map(() => Math.random());

        // 3. Upsert
        console.log('Upserting memory...');
        await graphService.upsertMemory(dummyMemory, fakeEmbedding);

        // 4. Test Related
        console.log('Getting related memories...');
        // We might not find any if it's the only one, but we can check if it runs.
        const related = await graphService.getRelatedMemories('test-mem-001');
        console.log('Related memories:', related);

        // 5. Test Vector Search
        console.log('Testing vector search...');
        const searchResults = await graphService.vectorSearch(fakeEmbedding, 1);
        console.log('Search results (should find itself):', searchResults.map(r => ({ id: r.memory.id, score: r.score })));

        if (searchResults.length > 0 && searchResults[0].memory.id === 'test-mem-001') {
            console.log('SUCCESS: GraphService verification passed.');
        } else {
            console.warn('WARNING: Vector search did not return the expected memory.');
        }

    } catch (error) {
        console.error('Test failed:', error);
    } finally {
        await graphService.close();
    }
}

main();
