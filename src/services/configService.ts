import dotenv from 'dotenv';
import path from 'path';

// Load .env once at module load time so constructor only reads process.env
dotenv.config();

type MemoryDataEnvironment = 'production' | 'development' | 'test';
type Neo4jIsolationMode = 'community-instances' | 'enterprise-databases';

const ENVIRONMENT_STORAGE_TARGETS: Record<MemoryDataEnvironment, {
    SQLITE_DB_PATH: string;
    QDRANT_COLLECTION_NAME: string;
}> = {
    production: {
        SQLITE_DB_PATH: path.join(process.cwd(), 'data', 'prod', 'memory.db'),
        QDRANT_COLLECTION_NAME: 'memoryapi_prod_memories',
    },
    development: {
        SQLITE_DB_PATH: path.join(process.cwd(), 'data', 'dev', 'memory.db'),
        QDRANT_COLLECTION_NAME: 'memoryapi_dev_memories',
    },
    test: {
        SQLITE_DB_PATH: path.join(process.cwd(), 'data', 'test', 'memory.db'),
        QDRANT_COLLECTION_NAME: 'memoryapi_test_memories',
    },
};

function isMemoryDataEnvironment(value: string): value is MemoryDataEnvironment {
    return value === 'production' || value === 'development' || value === 'test';
}

function isNeo4jIsolationMode(value: string): value is Neo4jIsolationMode {
    return value === 'community-instances' || value === 'enterprise-databases';
}

export interface ConfigValues {
    QDRANT_URL: string;
    LLM_HOST: string;
    LLM_MODEL: string;
    LLM_PROVIDER: string;
    EMBEDDING_MODEL: string;
    NEO4J_URI: string;
    NEO4J_PROD_URI: string;
    NEO4J_DEV_URI: string;
    NEO4J_TEST_URI: string;
    NEO4J_USER: string;
    NEO4J_PASSWORD: string;
    NEO4J_ISOLATION_MODE: string;
    PROMPT_TEMPLATE_BASE_PATH: string;
    SQLITE_DB_PATH: string;
    PORT: number;
    TODOIST_API_KEY: string;
    AGGREGATION_MAX_MEMORIES: number;
    AGGREGATION_MAX_CLUSTERS: number;
    AGGREGATION_MAX_MEMORIES_PER_CLUSTER: number;
    AGGREGATION_DEFAULT_SCORE_THRESHOLD: number;
    AGGREGATION_OVERFLOW_THRESHOLD_CHARS: number;
    AGGREGATION_CONDENSATION_BATCH_SIZE: number;
    AGGREGATION_CONTENT_MAX_CHARS: number;
    // Data environment and isolation
    MEMORY_DATA_ENV: string;
    MEMORY_ALLOW_PRODUCTION_WRITES: boolean;
    MEMORY_TEST_RUN_ID: string;
    MEMORY_TEST_RUN_TYPE: string;
    // Storage targets (one per environment)
    QDRANT_COLLECTION_NAME: string;
    NEO4J_DATABASE: string;
}

class Config implements ConfigValues {
    public QDRANT_URL: string = 'http://localhost:6333';
    public LLM_HOST: string = 'http://localhost:11434';
    public LLM_MODEL: string = 'granite-3.3';
    public LLM_PROVIDER: string = 'ollama';
    public EMBEDDING_MODEL: string = 'nomic-embed-text:v1.5';

    public NEO4J_URI: string = 'bolt://localhost:7687';
    public NEO4J_PROD_URI: string = 'bolt://localhost:7687';
    public NEO4J_DEV_URI: string = 'bolt://localhost:7688';
    public NEO4J_TEST_URI: string = 'bolt://localhost:7689';
    public NEO4J_USER: string = 'neo4j';
    public NEO4J_PASSWORD: string = 'password';
    public NEO4J_ISOLATION_MODE: string = 'community-instances';

    // Data environment and isolation
    public MEMORY_DATA_ENV: string = 'development';
    public MEMORY_ALLOW_PRODUCTION_WRITES: boolean = false;
    public MEMORY_TEST_RUN_ID: string = '';
    public MEMORY_TEST_RUN_TYPE: string = 'manual';

    // Storage targets (derived from MEMORY_DATA_ENV)
    public QDRANT_COLLECTION_NAME: string = 'memoryapi_dev_memories';
    public NEO4J_DATABASE: string = 'neo4j';

    public PROMPT_TEMPLATE_BASE_PATH: string = path.join(process.cwd(), 'src', 'prompts');
    public SQLITE_DB_PATH: string = path.join(process.cwd(), 'data', 'dev', 'memory.db');
    public PORT: number = 3000;
    public TODOIST_API_KEY: string = 'your_todoist_api_token_here';

    // Aggregation pipeline tuning
    public AGGREGATION_MAX_MEMORIES: number = 25;
    public AGGREGATION_MAX_CLUSTERS: number = 5;
    public AGGREGATION_MAX_MEMORIES_PER_CLUSTER: number = 8;
    public AGGREGATION_DEFAULT_SCORE_THRESHOLD: number = 0.6;
    public AGGREGATION_OVERFLOW_THRESHOLD_CHARS: number = 15000;
    public AGGREGATION_CONDENSATION_BATCH_SIZE: number = 1;
    public AGGREGATION_CONTENT_MAX_CHARS: number = 800;

    constructor(overrides: Partial<ConfigValues> = {}) {
        const configProps = Object.keys(this);
        const missing: string[] = [];

        for (const key of configProps) {
            // Constructor overrides take highest precedence
            if (key in overrides) {
                (this as any)[key] = (overrides as any)[key];
                continue;
            }
            const envValue = process.env[key];
            if (envValue) {
                if (typeof (this as any)[key] === 'boolean') {
                    (this as any)[key] = envValue === 'true';
                } else if (typeof (this as any)[key] === 'number') {
                    (this as any)[key] = parseFloat(envValue);
                } else {
                    (this as any)[key] = envValue;
                }
            } else {
                missing.push(key);
            }
        }

        this.applyEnvironmentStorageTargets(overrides);

        if (missing.length > 0) {
            console.warn(`[Config] WARNING: The following env variables were not provided. Using defaults: ${missing.join(', ')}`);
        }
    }

    private applyEnvironmentStorageTargets(overrides: Partial<ConfigValues>): void {
        if (!isMemoryDataEnvironment(this.MEMORY_DATA_ENV)) {
            return;
        }

        const targets = ENVIRONMENT_STORAGE_TARGETS[this.MEMORY_DATA_ENV];
        const storageKeys = Object.keys(targets) as Array<keyof typeof targets>;

        for (const key of storageKeys) {
            if (key in overrides) {
                continue;
            }
            (this as any)[key] = targets[key];
        }

        if (isNeo4jIsolationMode(this.NEO4J_ISOLATION_MODE)) {
            this.applyNeo4jEnvironmentTargets(overrides, this.MEMORY_DATA_ENV, this.NEO4J_ISOLATION_MODE);
        }
    }

    private applyNeo4jEnvironmentTargets(
        overrides: Partial<ConfigValues>,
        env: MemoryDataEnvironment,
        mode: Neo4jIsolationMode
    ): void {
        if (mode === 'enterprise-databases') {
            const envSlug = env === 'production' ? 'prod' : env === 'development' ? 'dev' : env;
            if (!('NEO4J_DATABASE' in overrides)) {
                this.NEO4J_DATABASE = `memoryapi_${envSlug}`;
            }
            return;
        }

        const uriByEnv: Record<MemoryDataEnvironment, string> = {
            production: this.NEO4J_PROD_URI,
            development: this.NEO4J_DEV_URI,
            test: this.NEO4J_TEST_URI,
        };

        if (!('NEO4J_URI' in overrides)) {
            this.NEO4J_URI = uriByEnv[env];
        }
        if (!('NEO4J_DATABASE' in overrides)) {
            this.NEO4J_DATABASE = 'neo4j';
        }
    }
}

export { Config };
export const config = new Config();
