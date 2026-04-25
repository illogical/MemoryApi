import { assertNotProduction, describeMemoryStorageTargets, getCurrentEnvironment } from '../services/memoryEnvironmentService';
import { execSync } from 'child_process';

/**
 * Convenience wrapper: resets then seeds the current non-production environment.
 *
 * Usage:
 *   cross-env MEMORY_DATA_ENV=development npx tsx src/scripts/refreshEnvironment.ts
 *   cross-env MEMORY_DATA_ENV=test npx tsx src/scripts/refreshEnvironment.ts
 */
async function main(): Promise<void> {
    const env = getCurrentEnvironment();
    assertNotProduction('refreshEnvironment');

    console.log(`=== Refresh ${env} Environment ===`);
    console.log(`Storage targets: ${describeMemoryStorageTargets()}\n`);

    console.log('Step 1/2: Resetting...');
    execSync('npx tsx src/scripts/resetEnvironment.ts', { stdio: 'inherit', env: process.env });

    console.log('\nStep 2/2: Seeding...');
    execSync('npx tsx src/scripts/seedEnvironment.ts', { stdio: 'inherit', env: process.env });

    console.log(`\n=== ${env} environment refresh complete ===`);
}

main().catch((err) => {
    console.error('[refreshEnvironment] Error:', err);
    process.exit(1);
});
