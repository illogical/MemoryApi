import { LMStudioClient, LLM } from '@lmstudio/sdk';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export type ModelProvider = 'lmstudio' | 'ollama';

export interface ModelClient {
    readonly modelName: string;
    readonly provider: ModelProvider;
    load(modelName: string): Promise<void>;
    respond(messages: ChatMessage[], options?: { temperature: number; maxTokens: number }): Promise<{ content: string }>;
}

export interface EmbeddingClient {
    readonly modelName: string;
    load(modelName: string): Promise<void>;
    embed(text: string): Promise<number[]>;
}

export class LMStudioModelClient implements ModelClient {
    private client: LMStudioClient;
    private model: LLM | null;
    private _modelName: string = '';

    private readonly maxTokensDefault = 1000;
    private readonly temperatureDefault = 0.7;

    constructor() {
        this.client = new LMStudioClient();
        this.model = null;
    }

    get modelName(): string {
        return this._modelName;
    }

    get provider(): ModelProvider {
        return 'lmstudio';
    }

    async load(modelName: string): Promise<void> {
        if (this.model == null || this._modelName !== modelName) {
            this._modelName = modelName;
            this.model = await this.client.llm.load(modelName);
        }
    }
    async respond(messages: ChatMessage[], options: { temperature: number; maxTokens: number }): Promise<{ content: string }> {
        if (!this.model) {
            throw new Error('Model not loaded');
        }
        const response = await this.model.respond(messages, {
            temperature: options?.temperature ?? this.temperatureDefault,
            maxTokens: options?.maxTokens ?? this.maxTokensDefault,
        });
        return { content: response.content };
    }
}

export class OllamaModelClient implements ModelClient {
    private _modelName: string = '';
    private readonly maxTokensDefault = 1000;
    private readonly temperatureDefault = 0.7;

    get modelName(): string {
        return this._modelName;
    }

    get provider(): ModelProvider {
        return 'ollama';
    }

    async load(modelName: string): Promise<void> {
        this._modelName = modelName;
    }
    async respond(messages: ChatMessage[], options?: { temperature: number; maxTokens: number }): Promise<{ content: string }> {
        const prompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
        const body = {
            model: this._modelName,
            prompt,
            stream: false,
            options: {
                temperature: options?.temperature ?? this.temperatureDefault,
                num_predict: options?.maxTokens ?? this.maxTokensDefault,
            }
        };
        const res = await fetch('http://localhost:11434/api/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Ollama request failed: ${res.status} ${text}`);
        }
        console.log(`Ollama response received ${res.status}`);
        const content = await res.json().then(d => d.response || d.content || '');
        return { content };
    }
}

export class OllamaEmbeddingClient implements EmbeddingClient {
    private _modelName: string = '';

    get modelName(): string {
        return this._modelName;
    }

    async load(modelName: string): Promise<void> {
        this._modelName = modelName;
    }

    async embed(text: string): Promise<number[]> {
        const body = {
            model: this._modelName,
            prompt: text
        };
        const res = await fetch('http://localhost:11434/api/embeddings', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`Ollama embedding request failed: ${res.status} ${text}`);
        }
        const data = await res.json();
        if (!data.embedding) {
            throw new Error('Ollama embedding response missing embedding data');
        }
        return data.embedding;
    }
}
