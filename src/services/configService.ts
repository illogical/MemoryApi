import dotenv from 'dotenv';
import path from 'path';

// Load .env once at module load time so constructor only reads process.env
dotenv.config();

export interface ConfigValues {
    QDRANT_URL: string;
    LLM_HOST: string;
    LLM_MODEL: string;
    LLM_PROVIDER: string;
    EMBEDDING_MODEL: string;
    NEO4J_URI: string;
    NEO4J_USER: string;
    NEO4J_PASSWORD: string;
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
    public NEO4J_USER: string = 'neo4j';
    public NEO4J_PASSWORD: string = 'password';

    // Data environment and isolation
    public MEMORY_DATA_ENV: string = 'development';
    public MEMORY_ALLOW_PRODUCTION_WRITES: boolean = false;
    public MEMORY_TEST_RUN_ID: string = '';
    public MEMORY_TEST_RUN_TYPE: string = 'manual';

    // Storage targets (change these to match MEMORY_DATA_ENV)
    public QDRANT_COLLECTION_NAME: string = 'memoryapi_dev_memories';
    public NEO4J_DATABASE: string = 'memoryapi_dev';

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

        if (missing.length > 0) {
            console.warn(`[Config] WARNING: The following env variables were not provided. Using defaults: ${missing.join(', ')}`);
        }
    }
}

export { Config };
export const config = new Config();
