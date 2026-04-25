import { config } from './configService';

export type MemoryDataEnvironment = 'production' | 'development' | 'test';
export type TestRunType = 'unit' | 'integration' | 'eval' | 'manual';

const VALID_ENVIRONMENTS: MemoryDataEnvironment[] = ['production', 'development', 'test'];

export function getCurrentEnvironment(): MemoryDataEnvironment {
    const env = config.MEMORY_DATA_ENV;
    if (!VALID_ENVIRONMENTS.includes(env as MemoryDataEnvironment)) {
        throw new Error(
            `Invalid MEMORY_DATA_ENV="${env}". Must be one of: ${VALID_ENVIRONMENTS.join(', ')}`
        );
    }
    return env as MemoryDataEnvironment;
}

export function assertCanWriteMemory(operation: string): void {
    if (getCurrentEnvironment() === 'production' && !config.MEMORY_ALLOW_PRODUCTION_WRITES) {
        throw new Error(
            `[MemoryEnvironment] Refusing production memory write for "${operation}". ` +
            `Set MEMORY_ALLOW_PRODUCTION_WRITES=true to allow intentional production writes.`
        );
    }
}

export function assertNotProduction(operation: string): void {
    if (getCurrentEnvironment() === 'production') {
        throw new Error(
            `[MemoryEnvironment] Refusing to run "${operation}" against production storage. ` +
            `This operation is not safe for production environments.`
        );
    }
}

export function describeMemoryStorageTargets(): string {
    return [
        `env=${config.MEMORY_DATA_ENV}`,
        `sqlite=${config.SQLITE_DB_PATH}`,
        `qdrantCollection=${config.QDRANT_COLLECTION_NAME}`,
        `neo4jDatabase=${config.NEO4J_DATABASE}`,
        `productionWrites=${config.MEMORY_ALLOW_PRODUCTION_WRITES}`,
    ].join(' | ');
}
