import { LMStudioClient, LLM } from '@lmstudio/sdk';
import { TransportProvenance } from '../models/ingestionTask';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export type ModelProvider = 'lmstudio' | 'ollama' | 'lmapi';

export function isModelProvider(value: string): value is ModelProvider {
    return value === 'lmstudio' || value === 'ollama' || value === 'lmapi';
}

export interface ModelClient {
    readonly modelName: string;
    readonly provider: ModelProvider;
    readonly baseUrl: string;
    readonly transport: TransportProvenance;
    load(modelName: string): Promise<void>;
    respond(messages: ChatMessage[], options?: { temperature: number; maxTokens: number }): Promise<{ content: string; finishReason?: string }>;
    listModels(): Promise<string[]>;
    listAvailableModels?(): Promise<string[]>;
}

export interface EmbeddingClient {
    readonly modelName: string;
    readonly baseUrl: string;
    load(modelName: string): Promise<void>;
    embed(text: string): Promise<number[]>;
}

export class LMStudioModelClient implements ModelClient {
    private client: LMStudioClient;
    private model: LLM | null;
    private _modelName: string = '';
    private _baseUrl: string;

    private readonly maxTokensDefault = 1000;
    private readonly temperatureDefault = 0.7;

    constructor(baseUrl: string) {
        this.client = new LMStudioClient();
        this.model = null;
        this._baseUrl = baseUrl;
    }

    get modelName(): string {
        return this._modelName;
    }

    get provider(): ModelProvider {
        return 'lmstudio';
    }

    get baseUrl(): string {
        return this._baseUrl;
    }

    get transport(): TransportProvenance {
        return { endpoint: 'lmstudio-sdk', messageShape: 'chat-messages' };
    }

    async load(modelName: string): Promise<void> {
        if (this.model == null || this._modelName !== modelName) {
            this._modelName = modelName;
            this.model = await this.client.llm.load(modelName);
        }
    }
    async respond(messages: ChatMessage[], options?: { temperature: number; maxTokens: number }): Promise<{ content: string }> {
        if (!this.model) {
            throw new Error('Model not loaded');
        }
        const response = await this.model.respond(messages, {
            temperature: options?.temperature ?? this.temperatureDefault,
            maxTokens: options?.maxTokens ?? this.maxTokensDefault,
        });
        return { content: response.content };
    }

    async listModels(): Promise<string[]> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
            const res = await fetch(`${this._baseUrl}/v1/models`, {
                signal: controller.signal
            });
            if (!res.ok) {
                throw new Error(`LM Studio request failed: ${res.status}`);
            }
            const data = await res.json();
            return data.data.map((m: any) => m.id);
        } finally {
            clearTimeout(timeoutId);
        }
    }
}

export class OllamaModelClient implements ModelClient {
    private _modelName: string = '';
    private _baseUrl: string;
    private readonly maxTokensDefault = 1000;
    private readonly temperatureDefault = 0.7;

    get modelName(): string {
        return this._modelName;
    }

    get provider(): ModelProvider {
        return 'ollama';
    }

    constructor(baseUrl: string) {
        this._baseUrl = baseUrl;
    }

    get baseUrl(): string {
        return this._baseUrl;
    }

    get transport(): TransportProvenance {
        return { endpoint: '/api/generate', messageShape: 'flattened-prompt' };
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
        const res = await fetch(`${this._baseUrl}/api/generate`, {
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

    async listModels(): Promise<string[]> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);

        try {
            const res = await fetch(`${this._baseUrl}/api/tags`, {
                signal: controller.signal
            });
            if (!res.ok) {
                throw new Error(`Ollama request failed: ${res.status}`);
            }
            const data = await res.json();
            return data.models.map((m: any) => m.name);
        } finally {
            clearTimeout(timeoutId);
        }
    }
}


export class OllamaEmbeddingClient implements EmbeddingClient {
    private _modelName: string = '';
    private _baseUrl: string;

    get modelName(): string {
        return this._modelName;
    }

    constructor(baseUrl: string) {
        this._baseUrl = baseUrl;
    }

    get baseUrl(): string {
        return this._baseUrl;
    }

    async load(modelName: string): Promise<void> {
        this._modelName = modelName;
    }

    async embed(text: string): Promise<number[]> {
        const body = {
            model: this._modelName,
            prompt: text
        };
        const res = await fetch(`${this._baseUrl}/api/embeddings`, {
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

export class LMApiClient implements ModelClient {
    private _modelName: string = '';
    private _baseUrl: string;
    private readonly maxTokensDefault = 16000;
    private readonly temperatureDefault = 0.3;

    get modelName(): string {
        return this._modelName;
    }

    get provider(): ModelProvider {
        return 'lmapi';
    }

    constructor(baseUrl: string) {
        this._baseUrl = baseUrl;
    }

    get baseUrl(): string {
        return this._baseUrl;
    }

    get transport(): TransportProvenance {
        return { endpoint: '/api/chat/completions/any', messageShape: 'chat-messages' };
    }

    async load(modelName: string): Promise<void> {
        this._modelName = modelName;
    }

    async respond(messages: ChatMessage[], options?: { temperature: number; maxTokens: number }): Promise<{ content: string; finishReason?: string }> {
        const body = {
            model: this._modelName,
            messages,
            stream: false,
            temperature: options?.temperature ?? this.temperatureDefault,
            max_tokens: options?.maxTokens ?? this.maxTokensDefault,
        };

        const res = await fetch(`${this._baseUrl}${this.transport.endpoint}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`LMApi request failed: ${res.status} ${text}`);
        }
        const data = await res.json();
        const choice = data?.choices?.[0];
        if (typeof choice?.message?.content !== 'string') {
            throw new Error('LMApi response invalid: expected choices[0].message.content');
        }
        return {
            content: choice.message.content,
            ...(typeof choice.finish_reason === 'string' && { finishReason: choice.finish_reason }),
        };
    }

    async listModels(): Promise<string[]> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        try {
            const res = await fetch(`${this._baseUrl}/api/models`, { signal: controller.signal });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`LMApi request failed: ${res.status} ${text}`);
            }
            const data = await res.json();
            if (!Array.isArray(data?.models) || !data.models.every((model: unknown) => typeof model === 'string')) {
                throw new Error('LMApi models response invalid: expected a string array in "models"');
            }
            return data.models;
        } finally {
            clearTimeout(timeoutId);
        }
    }

    async listAvailableModels(): Promise<string[]> {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        try {
            const res = await fetch(`${this._baseUrl}/api/models/by-server`, { signal: controller.signal });
            if (!res.ok) {
                const text = await res.text();
                throw new Error(`LMApi request failed: ${res.status} ${text}`);
            }
            const data = await res.json();
            if (!Array.isArray(data?.servers) || !data.servers.every((server: unknown) => {
                const candidate = server as { models?: unknown };
                return Array.isArray(candidate?.models)
                    && candidate.models.every((model: unknown) => typeof model === 'string');
            })) {
                throw new Error('LMApi available-models response invalid: expected servers[].models string arrays');
            }
            return [...new Set<string>(data.servers.flatMap((server: { models: string[] }) => server.models))]
                .sort((a, b) => a.localeCompare(b));
        } finally {
            clearTimeout(timeoutId);
        }
    }
}

export class LMApiEmbeddingClient implements EmbeddingClient {
    private _modelName: string = '';
    private _baseUrl: string;

    get modelName(): string {
        return this._modelName;
    }

    constructor(baseUrl: string) {
        this._baseUrl = baseUrl;
    }

    get baseUrl(): string {
        return this._baseUrl;
    }

    async load(modelName: string): Promise<void> {
        this._modelName = modelName;
    }

    async embed(text: string): Promise<number[]> {
        const body = {
            model: this._modelName,
            prompt: text // Using 'prompt' to match generation endpoint pattern
        };
        const res = await fetch(`${this._baseUrl}/api/embed`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
        });
        if (!res.ok) {
            const text = await res.text();
            throw new Error(`LMApi embedding request failed: ${res.status} ${text}`);
        }
        const data = await res.json();
        const embedding = data.embedding || data.response;

        if (!embedding || !Array.isArray(embedding)) {
            throw new Error(`LMApi embedding response invalid. Expected array, got ${typeof embedding}`);
        }
        return embedding;
    }
}

export class ModelClientFactory {
    static createModelClient(provider: string, baseUrl: string): ModelClient {
        switch (provider) {
            case 'lmstudio':
                return new LMStudioModelClient(baseUrl);
            case 'ollama':
                return new OllamaModelClient(baseUrl);
            case 'lmapi':
                return new LMApiClient(baseUrl);
            default:
                throw new Error(`Unsupported model provider: ${provider}`);
        }
    }

    static createEmbeddingClient(provider: string, baseUrl: string): EmbeddingClient {
        if (provider === 'lmapi') {
            return new LMApiEmbeddingClient(baseUrl);
        }
        // Default to Ollama for embeddings if not explicitly lmapi (as per previous logic)
        return new OllamaEmbeddingClient(baseUrl);
    }
}

