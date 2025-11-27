import { LMStudioClient, LLM } from '@lmstudio/sdk';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ModelClient {
    load(modelName: string): Promise<void>;
    respond(messages: ChatMessage[], options?: { temperature: number; maxTokens: number }): Promise<{ content: string }>;
}

export type ModelProvider = 'lmstudio' | 'ollama';

export class LMStudioModelClient implements ModelClient {
    private client: LMStudioClient;
    private model: LLM | null;

    private readonly maxTokensDefault = 1000;
    private readonly temperatureDefault = 0.7;

    constructor() {
        this.client = new LMStudioClient();
        this.model = null;
    }
    async load(modelName: string): Promise<void> {
        if(this.model == null)
        {
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
    private modelName: string = '';
    private readonly maxTokensDefault = 1000;
    private readonly temperatureDefault = 0.7;

    async load(modelName: string): Promise<void> {
        this.modelName = modelName;
    }
    async respond(messages: ChatMessage[], options?: { temperature: number; maxTokens: number }): Promise<{ content: string }> {
        const prompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
        const body = {
            model: this.modelName,
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
        // const data = await res.text();
        // console.log(`Ollama response data: ${data}`);
        //const content = (data && (data.response || data.content || '')) as string;
        return { content };
    }
}
