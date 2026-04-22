import dotenv from 'dotenv';
import path from 'path';

class Config {
    public QDRANT_URL: string = 'http://localhost:6333';
    public LLM_HOST: string = 'http://localhost:11434';
    public LLM_MODEL: string = 'granite-3.3';
    public LLM_PROVIDER: string = 'ollama';
    public EMBEDDING_MODEL: string = 'nomic-embed-text:v1.5';

    public NEO4J_URI: string = 'bolt://localhost:7687';
    public NEO4J_USER: string = 'neo4j';
    public NEO4J_PASSWORD: string = 'password';

    public PROMPT_TEMPLATE_BASE_PATH: string = path.join(process.cwd(), 'src', 'prompts');
    public SQLITE_DB_PATH: string = path.join(process.cwd(), 'data', 'memory.db');
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

    constructor() {
        dotenv.config();

        const configProps = Object.keys(this);
        const missing: string[] = [];

        for (const key of configProps) {
            const envValue = process.env[key];
            if (envValue) {
                if (typeof (this as any)[key] === 'number') {
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

export const config = new Config();
