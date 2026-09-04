import { jest } from '@jest/globals';
import { ModelClient } from '../../services/modelClients.js';
import { TaskModelRuntimeRegistry } from '../../services/taskModelRuntime.js';

function modelClient(availableModels: string[]): ModelClient & {
    load: jest.MockedFunction<ModelClient['load']>;
} {
    return {
        modelName: '',
        provider: 'lmapi',
        baseUrl: 'http://localhost:8080',
        transport: { endpoint: '/api/chat/completions/any', messageShape: 'chat-messages' },
        load: jest.fn(async () => undefined),
        respond: jest.fn(async () => ({ content: '' })),
        listModels: jest.fn(async () => availableModels)
    };
}

const taskConfigs = {
    classification: { model: 'shared', temperature: 0.3, maxTokens: 50 },
    tagging: { model: 'tagger', temperature: 0.3, maxTokens: 100 },
    summary: { model: 'shared', temperature: 0.3, maxTokens: 150 }
} as const;

describe('TaskModelRuntimeRegistry', () => {
    test('reuses clients by model and keeps distinct task models isolated', async () => {
        const base = modelClient(['shared', 'tagger']);
        const tagger = modelClient(['shared', 'tagger']);
        const createClient = jest.fn(() => tagger);
        const registry = new TaskModelRuntimeRegistry('shared', base, taskConfigs, createClient);

        expect(registry.getRuntime('classification').client).toBe(base);
        expect(registry.getRuntime('summary').client).toBe(base);
        expect(registry.getRuntime('tagging').client).toBe(tagger);
        expect(createClient).toHaveBeenCalledTimes(1);

        await registry.initialize();
        expect(base.load).toHaveBeenCalledWith('shared');
        expect(tagger.load).toHaveBeenCalledWith('tagger');
        expect(registry.getStatus().active).toBe(true);
    });

    test('rejects unavailable configured models without loading or substituting', async () => {
        const base = modelClient(['shared']);
        const tagger = modelClient(['shared']);
        const registry = new TaskModelRuntimeRegistry('shared', base, taskConfigs, () => tagger);

        await expect(registry.initialize()).rejects.toThrow('Configured inference model(s) unavailable: tagger');
        expect(base.load).not.toHaveBeenCalled();
        expect(tagger.load).not.toHaveBeenCalled();
        expect(registry.getStatus()).toMatchObject({ active: false, error: expect.stringContaining('tagger') });
    });

    test('prefers provider-reported routable models over the broader catalogue', async () => {
        const base = modelClient(['shared', 'tagger']);
        base.listAvailableModels = jest.fn(async () => ['shared']);
        const tagger = modelClient(['shared', 'tagger']);
        const registry = new TaskModelRuntimeRegistry('shared', base, taskConfigs, () => tagger);

        await expect(registry.initialize()).rejects.toThrow('Configured inference model(s) unavailable: tagger');
        expect(base.listModels).not.toHaveBeenCalled();
        expect(base.listAvailableModels).toHaveBeenCalledTimes(1);
    });

    test('deduplicates concurrent initialization', async () => {
        const base = modelClient(['shared']);
        const sharedConfigs = {
            classification: { model: 'shared', temperature: 0.3, maxTokens: 50 },
            tagging: { model: 'shared', temperature: 0.3, maxTokens: 100 },
            summary: { model: 'shared', temperature: 0.3, maxTokens: 150 }
        };
        const registry = new TaskModelRuntimeRegistry('shared', base, sharedConfigs, () => modelClient(['shared']));

        await Promise.all([registry.initialize(), registry.initialize()]);
        expect(base.listModels).toHaveBeenCalledTimes(1);
        expect(base.load).toHaveBeenCalledTimes(1);
    });
});
