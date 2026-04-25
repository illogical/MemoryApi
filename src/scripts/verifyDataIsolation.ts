import path from 'path';
import { Config } from '../services/configService';
import {
    assertCanWriteMemoryForEnvironment,
    parseMemoryDataEnvironment
} from '../services/memoryEnvironmentService';

/**
 * Verifies that the data isolation model is correctly configured.
 * Checks that each environment maps to a distinct SQLite path, Qdrant collection, and Neo4j target.
 * Neo4j can be isolated by per-environment Community instances or Enterprise databases.
 * Verifies that the production write guard throws when MEMORY_ALLOW_PRODUCTION_WRITES is false.
 *
 * Note: Config is a module singleton, so this script verifies the expected mapping
 * by simulating env var changes. For full integration verification, run reset/seed
 * for each environment and compare record counts.
 *
 * Usage: npx tsx src/scripts/verifyDataIsolation.ts
 */

interface EnvExpectation {
    env: string;
    sqlite: string;
    qdrant: string;
}

const EXPECTATIONS: EnvExpectation[] = [
    {
        env: 'production',
        sqlite: path.join('data', 'prod', 'memory.db'),
        qdrant: 'memoryapi_prod_memories',
    },
    {
        env: 'development',
        sqlite: path.join('data', 'dev', 'memory.db'),
        qdrant: 'memoryapi_dev_memories',
    },
    {
        env: 'test',
        sqlite: path.join('data', 'test', 'memory.db'),
        qdrant: 'memoryapi_test_memories',
    },
];

function pass(label: string) {
    console.log(`  ✓ ${label}: PASS`);
    return true;
}

function fail(label: string, got: string, expected: string) {
    console.error(`  ✗ ${label}: FAIL (got "${got}", expected "${expected}")`);
    return false;
}

async function verifyEnvMapping(): Promise<boolean> {
    console.log('\n--- Environment → Storage Target Mapping ---\n');
    let allOk = true;

    for (const exp of EXPECTATIONS) {
        const cfg = new Config({ MEMORY_DATA_ENV: exp.env });
        const sqliteActual = path.normalize(cfg.SQLITE_DB_PATH);
        const qdrantActual = cfg.QDRANT_COLLECTION_NAME;
        const neo4jTarget = `${cfg.NEO4J_URI}/${cfg.NEO4J_DATABASE}`;
        const envSlug = exp.env === 'production' ? 'prod' : exp.env === 'development' ? 'dev' : exp.env;
        const sqliteExpected = `data/${envSlug}/memory.db`;
        const qdrantExpected = `memoryapi_${envSlug}_memories`;
        const neo4jExpectedDatabase = cfg.NEO4J_ISOLATION_MODE === 'enterprise-databases'
            ? `memoryapi_${envSlug}`
            : 'neo4j';

        const sqliteOk = sqliteActual.replace(/\\/g, '/').endsWith(sqliteExpected);
        const qdrantOk = qdrantActual === qdrantExpected;
        const neo4jOk  = cfg.NEO4J_DATABASE === neo4jExpectedDatabase && cfg.NEO4J_URI.trim().length > 0;

        console.log(`${exp.env}:`);
        sqliteOk ? pass(`sqlite  → ${sqliteActual}`) : fail('sqlite', sqliteActual, sqliteExpected);
        qdrantOk ? pass(`qdrant  → ${qdrantActual}`) : fail('qdrant', qdrantActual, qdrantExpected);
        neo4jOk  ? pass(`neo4j   → ${neo4jTarget}`)  : fail('neo4j',  neo4jTarget,  `*/${neo4jExpectedDatabase}`);

        allOk = allOk && sqliteOk && qdrantOk && neo4jOk;
    }

    return allOk;
}

async function verifyStorageTargetsAreDistinct(): Promise<boolean> {
    console.log('\n--- Storage Targets Are Distinct ---\n');
    const configs = EXPECTATIONS.map(e => new Config({ MEMORY_DATA_ENV: e.env }));
    const sqlitePaths  = configs.map(c => c.SQLITE_DB_PATH);
    const qdrantNames  = configs.map(c => c.QDRANT_COLLECTION_NAME);
    const neo4jTargets = configs.map(c => `${c.NEO4J_URI}/${c.NEO4J_DATABASE}`);

    const sqliteDistinct = new Set(sqlitePaths).size === sqlitePaths.length;
    const qdrantDistinct = new Set(qdrantNames).size === qdrantNames.length;
    const neo4jDistinct  = new Set(neo4jTargets).size  === neo4jTargets.length;

    sqliteDistinct ? pass('All SQLite paths are distinct')  : fail('SQLite paths', 'duplicates found', 'all unique');
    qdrantDistinct ? pass('All Qdrant collections are distinct') : fail('Qdrant collections', 'duplicates found', 'all unique');
    neo4jDistinct  ? pass('All Neo4j targets are distinct') : fail('Neo4j targets', 'duplicates found', 'all unique');

    return sqliteDistinct && qdrantDistinct && neo4jDistinct;
}

async function verifyProductionWriteGuard(): Promise<boolean> {
    console.log('\n--- Production Write Guard ---\n');

    try {
        assertCanWriteMemoryForEnvironment('verifyDataIsolation', parseMemoryDataEnvironment('production'), false);
        fail('Production write guard', 'allowed', 'blocked');
        return false;
    } catch (error) {
        pass('Production + ALLOW=false blocks writes');
    }

    try {
        assertCanWriteMemoryForEnvironment('verifyDataIsolation', parseMemoryDataEnvironment('production'), true);
        pass('Production + ALLOW=true permits intentional writes');
        return true;
    } catch (error) {
        fail('Production write opt-in', 'blocked', 'allowed');
        return false;
    }
}

async function main(): Promise<void> {
    console.log('\n=== MemoryAPI Data Isolation Verification ===');

    const mappingOk  = await verifyEnvMapping();
    const distinctOk = await verifyStorageTargetsAreDistinct();
    const guardOk    = await verifyProductionWriteGuard();

    const allPassed = mappingOk && distinctOk && guardOk;
    console.log(`\n=== Result: ${allPassed ? 'ALL PASS ✓' : 'SOME FAILURES ✗'} ===\n`);

    if (!allPassed) {
        console.log('Next steps:');
        console.log('  - Update .env so MEMORY_DATA_ENV derives distinct SQLite, Qdrant, and Neo4j targets.');
        console.log('  - For Neo4j Community Edition, set NEO4J_PROD_URI, NEO4J_DEV_URI, and NEO4J_TEST_URI.');
        console.log('  - For Neo4j Enterprise, set NEO4J_ISOLATION_MODE=enterprise-databases.');
        console.log('  - Run "npm run seed:dev" to populate the development environment.');
        process.exit(1);
    }
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
