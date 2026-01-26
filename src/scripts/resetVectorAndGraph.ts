import { config } from '../services/configService';
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { SeedMemoryLoader } from '../services/seedMemoryLoader';
import { GraphService } from '../services/graphService';
import { Memory } from '../models/memory';
import * as path from 'path';
import { randomUUID } from 'crypto';

async function main() {
    const startTime = Date.now();
    console.log('=== Clean Slate Reset and Repopulate ===\n');

    // Initialize services
    const ragSystem = new MemoryRAGSystem();
    const graphService = new GraphService(
        config.NEO4J_URI,
        config.NEO4J_USER,
        config.NEO4J_PASSWORD
    );

    // ===== PHASE 1: CLEAR DATABASES =====
    console.log('Phase 1: Clearing databases...');
    
    try {
        console.log('  - Clearing vector database...');
        await ragSystem.deleteCollection();
        console.log('  ✓ Vector database cleared');
    } catch (error) {
        console.error('  ✗ Failed to clear vector database:', error);
        process.exit(1);
    }

    try {
        console.log('  - Clearing graph database...');
        await graphService.clearAllData();
        console.log('  ✓ Graph database cleared');
    } catch (error) {
        console.error('  ✗ Failed to clear graph database:', error);
        await graphService.close();
        process.exit(1);
    }

    // ===== PHASE 2: INITIALIZE DATABASES =====
    console.log('Phase 2: Initializing databases...');
    
    try {
        console.log('  - Initializing vector collection...');
        await ragSystem.initializeCollection();
        console.log('  ✓ Vector collection initialized');

        console.log('  - Initializing graph schema...');
        await graphService.initializeSchema();
        console.log('  ✓ Graph schema initialized');

        console.log('  - Loading inference model...');
        await ragSystem.loadInferenceModel();
        console.log('  ✓ Inference model loaded');
    } catch (error) {
        console.error('  ✗ Failed to initialize databases:', error);
        await graphService.close();
        process.exit(1);
    }

    // ===== PHASE 3: LOAD SEED DATA =====
    console.log('Phase 3: Loading seed data...');
    
    // Determine seed file path
    const seedFileArg = process.argv.slice(2).find(arg => !arg.startsWith('--'));
    const seedFilePath = seedFileArg 
        ? path.resolve(seedFileArg)
        : path.resolve(process.cwd(), 'src/samples/seedMemories.json');

    console.log(`  - Reading from: ${seedFilePath}`);

    const loader = new SeedMemoryLoader();
    let seedMemories: Memory[] = [];
    
    try {
        seedMemories = await loader.loadSeedMemoriesToMemoryObjects(seedFilePath);
        console.log(`  ✓ Loaded ${seedMemories.length} seed memories from file`);
    } catch (error) {
        console.error('  ✗ Failed to load seed memories:', error);
        await graphService.close();
        process.exit(1);
    }

    // ===== PHASE 4: PROCESS AND POPULATE =====
    console.log('Phase 4: Processing and populating databases...');
    console.log('  - Summarizing, classifying, and tagging memories...');
    
    const preparedMemories = await Promise.all(
        seedMemories.map(async (memory, index) => {
            try {
                const processStartTime = Date.now();
                const prepared = await ragSystem.summarizeClassifyAndPrepareMemory(memory);
                const processDuration = Date.now() - processStartTime;
                if ((index + 1) % 5 === 0 || index === seedMemories.length - 1) {
                    console.log(`    Processed ${index + 1}/${seedMemories.length} memories`);
                }
                return {
                    ...memory,
                    Description: prepared.description,
                    Category: prepared.category,
                    Tags: prepared.tagsList,
                    summary: prepared.summary,
                    classification: prepared.classification,
                    tags: prepared.tags,
                    processDuration: processDuration
                };
            } catch (error) {
                console.error(`    ✗ Error processing memory ${index + 1}:`, error);
                return null;
            }
        })
    );

    const validMemories = preparedMemories.filter(m => m !== null) as Array<Memory & { summary: string; classification: string; tags: string[] }>;
    console.log(`  ✓ Successfully processed ${validMemories.length}/${seedMemories.length} memories`);

    console.log('  - Generating embeddings and upserting to databases...');
    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < validMemories.length; i++) {
        const mem = validMemories[i] as any;
        try {
            const embedding = await ragSystem.generateEmbedding(mem.Content);
            await ragSystem.upsertMemory(mem, embedding);
            successCount++;
            
            if ((i + 1) % 5 === 0 || i === validMemories.length - 1) {
                console.log(`    Upserted ${i + 1}/${validMemories.length} memories`);
            }
        } catch (error) {
            console.error(`    ✗ Error upserting memory ${i + 1}:`, error);
            failCount++;
        }
    }

    console.log(`  ✓ Successfully upserted ${successCount} memories`);
    if (failCount > 0) {
        console.log(`  ✗ Failed to upsert ${failCount} memories`);
    }

    // ===== CLEANUP =====
    await graphService.close();

    // ===== SUMMARY =====
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    console.log('=== Reset Complete ===');
    console.log(`Total time: ${duration}s`);
    console.log(`Memories in databases: ${successCount}`);
}

main().catch((error) => {
    console.error('\n=== Fatal Error ===');
    console.error(error);
    process.exit(1);
});
