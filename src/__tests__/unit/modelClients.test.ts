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

const { LMStudioModelClient, OllamaModelClient, LMApiClient, ModelClientFactory } =
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
