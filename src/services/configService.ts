import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

class Config {
    public readonly QDRANT_URL: string = process.env.QDRANT_URL || 'http://localhost:6333';
    public readonly LLM_HOST: string = process.env.LLM_HOST || 'http://localhost:11434';
    public readonly LLM_MODEL: string = process.env.LLM_MODEL || 'phi4';
    public readonly LLM_PROVIDER: string = process.env.LLM_PROVIDER || 'ollama';
    public readonly EMBEDDING_MODEL: string = process.env.EMBEDDING_MODEL || 'nomic-embed-text-v1.5';

    public readonly NEO4J_URI: string = process.env.NEO4J_URI || 'bolt://localhost:7687';
    public readonly NEO4J_USER: string = process.env.NEO4J_USER || 'neo4j';
    public readonly NEO4J_PASSWORD: string = process.env.NEO4J_PASSWORD || 'password';

    public readonly PROMPT_TEMPLATE_BASE_PATH: string = process.env.PROMPT_TEMPLATE_BASE_PATH || path.join(process.cwd(), 'prompts');
    public readonly PORT: number = parseInt(process.env.PORT || '3000', 10);

    constructor() {
        // Validation could go here if needed
    }
}

export const config = new Config();
