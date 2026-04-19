/**
 * resetAllAndLoadSeeds.ts
 *
 * Full 3-store clean reset + seed reload:
 *   1. Purge Qdrant collection
 *   2. Purge Neo4j graph data
 *   3. Delete + recreate SQLite database
 *   4. Re-initialize vector + graph schemas
 *   5. Load inference model
 *   6. Ingest seedMemories.json with ingestionContext
 *   7. Print verification report
 *
 * Usage:
 *   npx tsx src/scripts/resetAllAndLoadSeeds.ts [path/to/seeds.json]
 */

import * as path from 'path';
import * as fs from 'fs';
import { config } from '../services/configService';
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { GraphService } from '../services/graphService';
import { VectorService } from '../services/vectorService';
import { sqlService } from '../services/sqlService';
import { SeedMemoryLoader } from '../services/seedMemoryLoader';
import { MemoryReportService } from '../services/memoryReportService';
import { LoggingService } from '../services/loggingService';
import { IngestionContext } from '../models/ingestionContext';
import { MemorySourceType } from '../models/memorySourceType';
import { MemoryDataset } from '../models/memoryDataset';
import { Memory } from '../models/memory';

async function deleteSqliteDb(): Promise<void> {
    const dbPath = config.SQLITE_DB_PATH;
    try {
        fs.unlinkSync(dbPath);
        console.log(`  ✓ Deleted SQLite database at ${dbPath}`);
    } catch (err: any) {
        if (err.code === 'ENOENT') {
            console.log(`  - No SQLite database found at ${dbPath} (skipping delete)`);
        } else {
            throw err;
        }
    }
}

async function recreateSqliteDb(): Promise<void> {
    // Ensure data directory exists before SqlService tries to open the DB
    const dbPath = config.SQLITE_DB_PATH;
    const dataDir = path.dirname(dbPath);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
        console.log(`  ✓ Created data directory at ${dataDir}`);
    }
    // SqlService constructor will initialize the schema when next instantiated
}

async function main() {
    const startTime = Date.now();
    const batchId = `${new Date().toISOString().slice(0, 10)}-reset-${Date.now().toString().slice(-4)}`;

    console.log('=== Full Clean Slate Reset + Seed Reload ===');
    console.log(`Batch ID: ${batchId}\n`);

    const loggingService = new LoggingService();
    await sqlService.waitUntilReady();

    // ===== PHASE 1: CLEAR ALL STORES =====
    console.log('Phase 1: Clearing all stores...');

    // Use a temporary ragSystem only for Qdrant clearing. We will re-create it after
    // deleting the SQLite DB so the fresh instance gets a writable connection.
    const tempRagSystem = new MemoryRAGSystem();

    try {
        console.log('  - Clearing Qdrant collection...');
        await tempRagSystem.deleteCollection();
        console.log('  ✓ Qdrant cleared');
    } catch (error) {
        console.error('  ✗ Failed to clear Qdrant:', error);
        process.exit(1);
    }

    const graphService = new GraphService(
        config.NEO4J_URI,
        config.NEO4J_USER,
        config.NEO4J_PASSWORD
    );

    try {
        console.log('  - Clearing Neo4j graph...');
        await graphService.clearAllData();
        console.log('  ✓ Neo4j cleared');
    } catch (error) {
        console.error('  ✗ Failed to clear Neo4j:', error);
        await graphService.close();
        process.exit(1);
    }

    try {
        console.log('  - Deleting SQLite database...');
        await sqlService.close();
        await deleteSqliteDb();
        await recreateSqliteDb(); // Ensure data dir exists before new connections open
        await sqlService.reconnect();
        console.log('  ✓ SQLite connection reset and schema recreated');
    } catch (error) {
        console.error('  ✗ Failed to delete/recreate SQLite database:', error);
        await graphService.close();
        process.exit(1);
    }

    // Re-create ragSystem AFTER db deletion so its internal SqlService gets a fresh,
    // writable connection to the newly-created database file.
    const ragSystem = new MemoryRAGSystem();
    await sqlService.waitUntilReady();

    // ===== PHASE 2: INITIALIZE SCHEMAS =====
    console.log('\nPhase 2: Initializing schemas...');

    try {
        console.log('  - Initializing vector collection...');
        await ragSystem.initializeCollection(); // Initializes Qdrant + graph schema via orchestrator
        console.log('  ✓ Vector + graph schemas initialized');

        console.log('  - Re-initializing graph schema with new node types...');
        await graphService.initializeSchema();
        console.log('  ✓ Graph schema (Tool/Project/Topic) initialized');
    } catch (error) {
        console.error('  ✗ Failed to initialize schemas:', error);
        await graphService.close();
        process.exit(1);
    }

    try {
        console.log('  - Loading inference model...');
        await ragSystem.loadInferenceModel();
        console.log('  ✓ Inference model loaded');
    } catch (error) {
        console.error('  ✗ Failed to load inference model:', error);
        await graphService.close();
        process.exit(1);
    }

    // ===== PHASE 3: LOAD SEED DATA =====
    console.log('\nPhase 3: Loading seed data...');

    const seedFileArg = process.argv.slice(2).find(arg => !arg.startsWith('--'));
    const seedFilePath = seedFileArg
        ? path.resolve(seedFileArg)
        : path.resolve(process.cwd(), 'src/samples/seedMemories.json');

    console.log(`  - Reading from: ${seedFilePath}`);

    const ingestionContext: IngestionContext = {
        batchId,
        sourceType: MemorySourceType.SeedImport,
        dataset: MemoryDataset.Dev
    };

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

    // ===== PHASE 4: INGEST =====
    console.log('\nPhase 4: Processing and ingesting memories...');

    let successCount = 0;
    let failCount = 0;

    for (let i = 0; i < seedMemories.length; i++) {
        const memory = seedMemories[i];
        try {
            const prepared = await ragSystem.summarizeClassifyAndPrepareMemory(memory);
            const memoryToUpsert: Memory = {
                ...memory,
                Description: prepared.description,
                Category: prepared.category,
                Tags: prepared.tagsList,
                Tools: prepared.tools,
                Projects: prepared.projects,
                Topics: prepared.topics,
                LastUpdated: new Date().toISOString()
            };
            const embedding = await ragSystem.generateEmbedding(memoryToUpsert.Content);
            await ragSystem.upsertMemory(memoryToUpsert, embedding, undefined, ingestionContext);
            successCount++;
            if ((i + 1) % 5 === 0 || i === seedMemories.length - 1) {
                console.log(`    Ingested ${i + 1}/${seedMemories.length} memories`);
            }
        } catch (error) {
            failCount++;
            console.error(`  ✗ Failed to ingest memory ${i + 1}:`, error);
        }
    }

    console.log(`\n  ✓ Ingestion complete: ${successCount} succeeded, ${failCount} failed`);

    // ===== PHASE 5: VERIFICATION REPORT =====
    console.log('\nPhase 5: Generating verification report...');

    const vectorService = new VectorService(config.QDRANT_URL, loggingService);
    const reportService = new MemoryReportService();
    let sqlValidationPassed = false;

    try {
        await reportService.generateVerificationReport(vectorService, graphService, sqlService);

        const sqlValidation = await sqlService.validateMemoryPopulation(
            {
                sourceType: MemorySourceType.SeedImport,
                dataset: MemoryDataset.Dev
            },
            seedMemories.length
        );

        console.log('SQL reseed validation:');
        console.log(`  Expected rows:    ${sqlValidation.expectedCount}`);
        console.log(`  Seed rows found:  ${sqlValidation.totalCount}`);
        console.log(`  Missing GraphId:  ${sqlValidation.missingGraphIds}`);
        console.log(`  Missing VectorId: ${sqlValidation.missingVectorIds}`);
        console.log(`  Mismatched IDs:   ${sqlValidation.mismatchedRelationIds}`);
        console.log(`  Missing relation: ${sqlValidation.missingRelationRows}`);

        if (!sqlValidation.isValid) {
            const sampleIds = sqlValidation.invalidMemoryIds.slice(0, 10).join(', ');
            throw new Error(
                `SQL reseed validation failed.${sampleIds ? ` Invalid memory IDs: ${sampleIds}` : ''}`
            );
        }

        sqlValidationPassed = true;
        console.log('  ✓ SQL reseed validation passed');
    } catch (error) {
        console.error('  ✗ Failed to generate verification report:', error);
    }

    const totalMs = Date.now() - startTime;
    console.log(`Total duration: ${(totalMs / 1000).toFixed(1)}s`);

    // Close all open handles so the process exits cleanly
    await graphService.close();
    await sqlService.close();
    process.exit(failCount > 0 || !sqlValidationPassed ? 1 : 0);
}

main().catch(err => {
    console.error('Fatal error in resetAllAndLoadSeeds:', err);
    process.exit(1);
});
