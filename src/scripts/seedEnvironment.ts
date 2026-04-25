import { config } from '../services/configService';
import {
    assertCanWriteMemory,
    assertNotProduction,
    describeMemoryStorageTargets,
    getCurrentEnvironment
} from '../services/memoryEnvironmentService';
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { SeedMemoryLoader } from '../services/seedMemoryLoader';
import { MemoryStatus } from '../models/memoryStatus';
import path from 'path';
import fs from 'fs';

const SEED_FILE   = path.join(process.cwd(), 'src', 'samples', 'seedMemories.json');
const SAMPLE_FILE = path.join(process.cwd(), 'src', 'samples', 'sampleMemories.json');

/**
 * Seeds the current environment's storage targets.
 *
 * Fixture policy:
 *   production  → seedMemories.json only, inserted as 'stored'. Requires MEMORY_ALLOW_PRODUCTION_WRITES=true.
 *   development → seedMemories.json (stored) + sampleMemories.json (draft)
 *   test        → seedMemories.json (stored) + sampleMemories.json (draft)
 */
async function run(): Promise<void> {
    const env = getCurrentEnvironment();
    console.log(`[seedEnvironment] env=${env}`);
    console.log(`[seedEnvironment] Storage targets: ${describeMemoryStorageTargets()}`);

    if (env === 'production') {
        assertCanWriteMemory('seedEnvironment');
        console.log('[seedEnvironment] Production seed: loading seedMemories.json only (status=stored).');
    }

    const ragSystem = new MemoryRAGSystem();
    const loader = new SeedMemoryLoader();

    await ragSystem.initializeCollection();
    await ragSystem.loadInferenceModel();

    // All environments seed from seedMemories.json with status=stored
    if (!fs.existsSync(SEED_FILE)) {
        throw new Error(`Seed file not found: ${SEED_FILE}`);
    }
    console.log(`[seedEnvironment] Seeding from seedMemories.json (status=stored)...`);
    await loader.loadSeedMemoriesToDatabases(SEED_FILE, ragSystem, { defaultStatus: MemoryStatus.Stored });

    // Non-production environments also seed from sampleMemories.json with status=draft
    if (env !== 'production') {
        if (!fs.existsSync(SAMPLE_FILE)) {
            console.warn(`[seedEnvironment] Sample file not found: ${SAMPLE_FILE}. Skipping.`);
        } else {
            console.log(`[seedEnvironment] Seeding from sampleMemories.json (status=draft)...`);
            await loader.loadSeedMemoriesToDatabases(SAMPLE_FILE, ragSystem, { defaultStatus: MemoryStatus.Draft });
        }
    }

    console.log('[seedEnvironment] Done.');
}

run().catch((err) => {
    console.error('[seedEnvironment] Error:', err);
    process.exit(1);
});
