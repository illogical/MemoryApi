// Mock LMStudio SDK before importing model clients to prevent real WebSocket connections
// jest.unstable_mockModule must come before dynamic imports in ESM
import { jest } from '@jest/globals';

jest.unstable_mockModule('@lmstudio/sdk', () => ({
    LMStudioClient: jest.fn().mockImplementation(() => ({
        llm: {
            load: async () => ({
                respond: async () => ({ content: '' })
            })
        }
    }))
}));

const { LMStudioModelClient, OllamaModelClient, LMApiClient, ModelClientFactory, isModelProvider } =
    await import('../../services/modelClients.js');

describe('ModelClientFactory.createModelClient', () => {
    test('provider "lmstudio" returns LMStudioModelClient', () => {
        const client = ModelClientFactory.createModelClient('lmstudio', 'http://localhost:1234');
        expect(client).toBeInstanceOf(LMStudioModelClient);
        expect(client.provider).toBe('lmstudio');
    });

    test('provider "ollama" returns OllamaModelClient', () => {
        const client = ModelClientFactory.createModelClient('ollama', 'http://localhost:11434');
        expect(client).toBeInstanceOf(OllamaModelClient);
        expect(client.provider).toBe('ollama');
    });

    test('provider "lmapi" returns LMApiClient', () => {
        const client = ModelClientFactory.createModelClient('lmapi', 'http://localhost:8080');
        expect(client).toBeInstanceOf(LMApiClient);
        expect(client.provider).toBe('lmapi');
    });

    test('unknown provider throws descriptive error', () => {
        expect(() =>
            ModelClientFactory.createModelClient('unknown-provider', 'http://localhost')
        ).toThrow('unknown-provider');
    });

    test('baseUrl is stored on the returned client', () => {
        const url = 'http://localhost:5000';
        const client = ModelClientFactory.createModelClient('ollama', url);
        expect(client.baseUrl).toBe(url);
    });
});

describe('isModelProvider', () => {
    test.each(['lmstudio', 'ollama', 'lmapi'])('accepts %s', provider => {
        expect(isModelProvider(provider)).toBe(true);
    });

    test('rejects unsupported providers', () => {
        expect(isModelProvider('other')).toBe(false);
    });
});

describe('model client transport provenance', () => {
    test('LM Studio declares structured chat messages', () => {
        expect(new LMStudioModelClient('http://localhost:1234').transport).toEqual({
            endpoint: 'lmstudio-sdk', messageShape: 'chat-messages'
        });
    });

    test('Ollama declares its legacy flattened prompt transport', () => {
        expect(new OllamaModelClient('http://localhost:11434').transport).toEqual({
            endpoint: '/api/generate', messageShape: 'flattened-prompt'
        });
    });
});

describe('LMApiClient', () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    test('posts structured messages and inference parameters to chat completions', async () => {
        const fetchMock = jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'Note' }, finish_reason: 'stop' }]
        }), { status: 200 }));
        globalThis.fetch = fetchMock as typeof fetch;
        const client = new LMApiClient('http://localhost:8080');
        await client.load('model-a');
        const messages = [
            { role: 'system' as const, content: 'system prompt' },
            { role: 'user' as const, content: '<memory>\nhello\n</memory>' }
        ];

        await expect(client.respond(messages, { temperature: 0.3, maxTokens: 50 })).resolves.toEqual({
            content: 'Note', finishReason: 'stop'
        });

        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('http://localhost:8080/api/chat/completions/any');
        expect(JSON.parse(String(init?.body))).toEqual({
            model: 'model-a', messages, stream: false, temperature: 0.3, max_tokens: 50
        });
        expect(client.transport).toEqual({
            endpoint: '/api/chat/completions/any', messageShape: 'chat-messages'
        });
    });

    test('lists models through the LMApi model endpoint', async () => {
        const fetchMock = jest.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify({ models: ['a', 'b'] }), { status: 200 }));
        globalThis.fetch = fetchMock as typeof fetch;
        const client = new LMApiClient('http://localhost:8080');

        await expect(client.listModels()).resolves.toEqual(['a', 'b']);
        expect(fetchMock).toHaveBeenCalledWith(
            'http://localhost:8080/api/models',
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
    });

    test('lists only models routed by online, enabled LMApi servers', async () => {
        const fetchMock = jest.fn(async () => new Response(JSON.stringify({
            servers: [
                { name: 'one', models: ['b', 'a'] },
                { name: 'two', models: ['a', 'c'] },
            ]
        }), { status: 200 }));
        globalThis.fetch = fetchMock as typeof fetch;
        const client = new LMApiClient('http://localhost:8080');

        await expect(client.listAvailableModels()).resolves.toEqual(['a', 'b', 'c']);
        expect(fetchMock).toHaveBeenCalledWith(
            'http://localhost:8080/api/models/by-server',
            expect.objectContaining({ signal: expect.any(AbortSignal) })
        );
    });

    test('rejects malformed chat-completion responses', async () => {
        globalThis.fetch = jest.fn(async () => new Response(JSON.stringify({ content: 'legacy' }), { status: 200 })) as typeof fetch;
        const client = new LMApiClient('http://localhost:8080');

        await expect(client.respond([], { temperature: 0.3, maxTokens: 50 }))
            .rejects.toThrow('choices[0].message.content');
    });

    test('includes LMApi error status and response text', async () => {
        globalThis.fetch = jest.fn(async () => new Response('unavailable', { status: 503 })) as typeof fetch;
        const client = new LMApiClient('http://localhost:8080');

        await expect(client.respond([], { temperature: 0.3, maxTokens: 50 }))
            .rejects.toThrow('LMApi request failed: 503 unavailable');
    });
});
