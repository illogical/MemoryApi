import { GraphService } from '../../services/graphService';
import { MemoryCategory } from '../../models/memoryCategory';
import { config } from '../../services/configService';
import fs from 'fs';
import path from 'path';

async function main() {
    console.log(`Connecting to Neo4j at ${config.NEO4J_URI}...`);
    const graphService = new GraphService(config.NEO4J_URI, config.NEO4J_USER, config.NEO4J_PASSWORD);

    try {
        // 1. Initialize Schema
        console.log('Initializing schema...');
        await graphService.initializeSchema();

        // 2. Load Seed Data
        const seedPath = path.join(__dirname, '../samples/seedMemories.json');
        const seedData = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
        const memories = seedData.memories;

        console.log(`Loading ${memories.length} seed memories...`);

        // 3. Seed Graph
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
            // Fake embedding
            const fakeEmbedding = Array(1536).fill(0).map(() => Math.random());
            await graphService.upsertMemory(memoryWithId, fakeEmbedding);
        }
        console.log('Seed initialization complete.');

        // 4. Verify Relationships
        console.log('\n--- Verifying Relationships ---');

        // Test Case A: Get Related for "Code Snippet" (should find other code snippets/programming)
        // Finding a code snippet memory ID
        const codeMemoryIndex = memories.findIndex((m: any) => m.category === 'Code snippet');
        if (codeMemoryIndex !== -1) {
            const codeMemoryId = `seed-${codeMemoryIndex}`;
            console.log(`\nFinding related for Memory ${codeMemoryId} (${memories[codeMemoryIndex].content.slice(0, 30)}...):`);
            const related = await graphService.getRelatedMemories(codeMemoryId, 3);
            related.forEach(r => {
                // r: { memory: any, score: number }
                console.log(` - [Score: ${r.score}] ${r.memory.content.substring(0, 50)}... (Cat: ${r.memory.category})`);
            });
        }

        // Test Case B: Find by Tag "Project"
        console.log('\nFinding memories with tag "Project":');
        const projectMemories = await graphService.getMemoriesByTags(['Project']);
        projectMemories.forEach(m => {
            console.log(` - ${m.content.substring(0, 50)}...`);
        });

    } catch (error) {
        console.error('Test failed:', error);
    } finally {
        await graphService.close();
    }
}

main();
