export type IngestionTask = 'classification' | 'tagging' | 'summary';

export interface TaskModelConfig {
    model: string;
    temperature: number;
    maxTokens: number;
}

export interface RenderedTaskPrompt {
    system: string;
    user: string;
    promptId: 'classification' | 'tagging' | 'memory-summary';
    promptVersion: string;
    taxonomySha256?: string;
}

export function renderedTaskMessages(prompt: RenderedTaskPrompt): Array<{
    role: 'system' | 'user';
    content: string;
}> {
    return [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
    ];
}

export interface TransportProvenance {
    endpoint: string;
    messageShape: 'chat-messages' | 'flattened-prompt';
}
