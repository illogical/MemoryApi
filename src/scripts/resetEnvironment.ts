import * as path from 'path';
import * as fs from 'fs';
import { config } from '../services/configService';
import {
    assertNotProduction,
    describeMemoryStorageTargets,
    getCurrentEnvironment
} from '../services/memoryEnvironmentService';
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { GraphService } from '../services/graphService';
import { sqlService } from '../services/sqlService';

/**
 * Wipes all three stores (SQLite, Qdrant, Neo4j) for the current non-production environment.
 *
 * Usage:
 *   cross-env MEMORY_DATA_ENV=development npx tsx src/scripts/resetEnvironment.ts
 *   cross-env MEMORY_DATA_ENV=test npx tsx src/scripts/resetEnvironment.ts
 *
 * Production is always blocked.
 */
async function main(): Promise<void> {
    const env = getCurrentEnvironment();
    assertNotProduction('resetEnvironment');

    const startTime = Date.now();
    console.log(`=== Reset ${env} Environment ===`);
    console.log(`Storage targets: ${describeMemoryStorageTargets()}\n`);

    await sqlService.waitUntilReady();

    // Clear Qdrant
    const ragSystem = new MemoryRAGSystem();
    try {
        console.log('Clearing Qdrant collection...');
        await ragSystem.deleteCollection();
        console.log(`  ✓ Qdrant collection deleted: ${config.QDRANT_COLLECTION_NAME}`);
    } catch (error) {
        console.error('  ✗ Failed to clear Qdrant:', error);
        process.exit(1);
    }

    // Clear Neo4j
    const graphService = new GraphService(
        config.NEO4J_URI,
        config.NEO4J_USER,
        config.NEO4J_PASSWORD,
        config.NEO4J_DATABASE
    );
    try {
        console.log('Clearing Neo4j graph...');
        await graphService.clearAllData();
        await graphService.close();
        console.log(`  ✓ Neo4j cleared: ${config.NEO4J_DATABASE || 'default database'}`);
    } catch (error) {
        console.error('  ✗ Failed to clear Neo4j:', error);
        await graphService.close();
        process.exit(1);
    }

    // Delete and recreate SQLite
    try {
        console.log('Deleting SQLite database...');
        await sqlService.close();
        const dbPath = config.SQLITE_DB_PATH;
        try {
            fs.unlinkSync(dbPath);
            console.log(`  ✓ Deleted SQLite DB: ${dbPath}`);
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                console.log(`  - No SQLite DB found at ${dbPath} (skipping delete)`);
            } else {
                throw err;
            }
        }
        const dataDir = path.dirname(dbPath);
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir, { recursive: true });
            console.log(`  ✓ Created data directory: ${dataDir}`);
        }
        console.log('  ✓ SQLite will be re-initialized on next startup.');
    } catch (error) {
        console.error('  ✗ Failed to reset SQLite:', error);
        process.exit(1);
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n=== ${env} environment reset complete (${elapsed}s) ===`);
    console.log('Run seed:dev or seed:test to re-populate.');
}

main().catch((err) => {
    console.error('[resetEnvironment] Error:', err);
    process.exit(1);
});
