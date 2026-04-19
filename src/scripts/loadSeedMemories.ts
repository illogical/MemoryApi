import { config } from '../services/configService';
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { SeedMemoryLoader } from '../services/seedMemoryLoader';
import { Memory } from '../models/memory';
import { MemoryReportService, ReportStats } from '../services/memoryReportService';
import { randomUUID } from 'crypto';

async function main() {
    const startTime = Date.now();
    // Instantiate your MemoryRAGSystem
    console.warn('WARNING: This script does not clear Neo4j or SQLite state. Use reset:full for a true clean slate.');
    const ragSystem = new MemoryRAGSystem();
    try {
        await ragSystem.deleteCollection();
    } catch (error) {
        console.error('Failed to delete collection:', error);
        process.exit(1);
    }

    // Load seed file path from command-line argument
    const path = await import('path');
    // Find the first argument that doesn't start with --
    const seedFileArg = process.argv.slice(2).find(arg => !arg.startsWith('--'));

    if (!seedFileArg) {
        throw new Error('Seed file path must be provided as a command-line argument.');
    }
    const seedFilePath = path.resolve(seedFileArg);

    // Use SeedMemoryLoader to load and parse the JSON file
    const loader = new SeedMemoryLoader();
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
                const processStartTime = Date.now();
                const prepared = await ragSystem.summarizeClassifyAndPrepareMemory(memory);
                const processDuration = Date.now() - processStartTime;
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
            } catch (err) {
                console.error('Error summarizing/classifying/tagging:', err, memory);
                return null;
            }
        })
    );
    const validMemories = preparedMemories.filter(m => m !== null) as Array<Memory & { summary: string; classification: string; tags: string[] }>;

    // Generate embeddings and upsert all memories
    let loadedCount = 0;
    for (const mem of validMemories) {
        try {
            const embedding = await ragSystem.generateEmbedding(mem.Content);
            const id = await ragSystem.upsertMemory(mem, embedding);
            (mem as any).id = id;
            loadedCount++;
        } catch (err) {
            console.error('Error upserting memory:', err, mem);
        }
    }
    console.log(`Loaded ${loadedCount} seed memories from ${seedFilePath}`);

    // Generate Report
    const reportService = new MemoryReportService();
    const reportStats: ReportStats = {
        totalProcessed: seedMemories.length,
        successCount: loadedCount,
        durationMs: Date.now() - startTime,
        timestamp: new Date(),
        embeddingModel: config.EMBEDDING_MODEL
    };
    // Parse report format from args
    const reportFormatArg = process.argv.find(arg => arg.startsWith('--report-format='));
    const reportFormat = reportFormatArg ? reportFormatArg.split('=')[1] as 'html' | 'markdown' : 'markdown';

    const reportPath = await reportService.generateIngestionReport(validMemories, reportStats, reportFormat);
    console.log(`Report generated at: ${reportPath}`);
}

main().catch((err) => {
    console.error('Error loading seed memories:', err);
    process.exit(1);
});
