import { LMStudioClient } from '@lmstudio/sdk';

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ModelClient {
    load(modelName: string): Promise<void>;
    respond(messages: ChatMessage[], options: { temperature: number; maxTokens: number }): Promise<{ content: string }>;
}

export type ModelProvider = 'lmstudio' | 'ollama';

export class LMStudioModelClient implements ModelClient {
    private client: LMStudioClient;
    private model: any;
    constructor() {
        this.client = new LMStudioClient();
        this.model = null;
    }
    async load(modelName: string): Promise<void> {
        this.model = await this.client.llm.load(modelName);
    }
    async respond(messages: ChatMessage[], options: { temperature: number; maxTokens: number }): Promise<{ content: string }> {
        const response = await this.model.respond(messages, {
            temperature: options.temperature,
            maxTokens: options.maxTokens,
        });
        return { content: response.content };
    }
}

export class OllamaModelClient implements ModelClient {
    private modelName: string = '';
    async load(modelName: string): Promise<void> {
        this.modelName = modelName;
    }
    async respond(messages: ChatMessage[], options: { temperature: number; maxTokens: number }): Promise<{ content: string }> {
        const prompt = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
        const body = {
            model: this.modelName,
            prompt,
            options: {
                temperature: options.temperature,
                num_predict: options.maxTokens,
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
        const data = await res.json();
        const content = (data && (data.response || data.content || '')) as string;
        return { content };
    }
}
