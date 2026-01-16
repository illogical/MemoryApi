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

    public PROMPT_TEMPLATE_BASE_PATH: string = path.join(process.cwd(), 'prompts');
    public SQLITE_DB_PATH: string = path.join(process.cwd(), 'data', 'memory.db');
    public PORT: number = 3000;
    public TODOIST_API_KEY: string = 'your_todoist_api_token_here';

    constructor() {
        dotenv.config();

        const configProps = Object.keys(this);
        const missing: string[] = [];

        for (const key of configProps) {
            const envValue = process.env[key];
            if (envValue) {
                if (key === 'PORT') {
                    this.PORT = parseInt(envValue, 10);
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
