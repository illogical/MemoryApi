import path from 'path';
import { jest } from '@jest/globals';
import { LoggingService } from '../../services/loggingService.js';
import { MemoryTextProcessor } from '../../services/memoryTextProcessor.js';
import { ModelClient } from '../../services/modelClients.js';
import { PromptTemplateService } from '../../services/promptTemplateService.js';
import { SqlService } from '../../services/sqlService.js';

function client(responses: string[]): ModelClient & {
    respond: jest.MockedFunction<ModelClient['respond']>;
} {
    return {
        modelName: 'test-model',
        provider: 'lmapi',
        baseUrl: 'http://localhost:8080',
        transport: { endpoint: '/api/chat/completions/any', messageShape: 'chat-messages' },
        load: jest.fn(async () => undefined),
        listModels: jest.fn(async () => ['test-model']),
        respond: jest.fn(async () => ({ content: responses.shift() ?? '' }))
    };
}

function logger(): LoggingService {
    return {
        trace: jest.fn(), debug: jest.fn(), info: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn()
    } as unknown as LoggingService;
}

function sql(): SqlService {
    return { addTagSuggestion: jest.fn(async () => undefined) } as unknown as SqlService;
}

describe('MemoryTextProcessor task runtimes', () => {
    const promptService = new PromptTemplateService(path.join(process.cwd(), 'src', 'prompts'));

    test('routes ingestion tasks with exact messages and configured parameters', async () => {
        const base = client([]);
        const classifier = client(['Note']);
        const tagger = client(['Work']);
        const summarizer = client(['A summary']);
        const runtimes = {
            classification: { client: classifier, config: { model: 'classifier', temperature: 0.3, maxTokens: 50 } },
            tagging: { client: tagger, config: { model: 'tagger', temperature: 0.3, maxTokens: 100 } },
            summary: { client: summarizer, config: { model: 'summarizer', temperature: 0.3, maxTokens: 150 } }
        } as const;
        const processor = new MemoryTextProcessor(base, promptService, logger(), sql(), task => runtimes[task]);

        await expect(processor.classifyText('hello')).resolves.toBe('Note');
        await expect(processor.tagText('hello')).resolves.toEqual(['Work']);
        await expect(processor.summarizeText('hello')).resolves.toBe('A summary');

        expect(classifier.respond).toHaveBeenCalledWith([
            { role: 'system', content: expect.any(String) },
            { role: 'user', content: '<memory>\nhello\n</memory>' }
        ], { temperature: 0.3, maxTokens: 50 });
        expect(tagger.respond).toHaveBeenCalledWith(expect.any(Array), { temperature: 0.3, maxTokens: 100 });
        expect(summarizer.respond).toHaveBeenCalledWith(expect.any(Array), { temperature: 0.3, maxTokens: 150 });
        expect(base.respond).not.toHaveBeenCalled();
    });

    test('classification retries remain on the configured task client', async () => {
        const base = client([]);
        const classifier = client(['not-valid', 'Note']);
        const processor = new MemoryTextProcessor(
            base,
            promptService,
            logger(),
            sql(),
            () => ({ client: classifier, config: { model: 'classifier', temperature: 0.3, maxTokens: 50 } })
        );

        await expect(processor.classifyText('hello')).resolves.toBe('Note');
        expect(classifier.respond).toHaveBeenCalledTimes(2);
        expect(base.respond).not.toHaveBeenCalled();
    });

    test('suggestions and entity extraction remain on the base client', async () => {
        const base = client(['["custom"]', '{"tools":[],"projects":[]}']);
        const task = client([]);
        const processor = new MemoryTextProcessor(
            base,
            promptService,
            logger(),
            sql(),
            () => ({ client: task, config: { model: 'task', temperature: 0.3, maxTokens: 50 } })
        );

        await expect(processor.suggestTags('hello')).resolves.toEqual(['custom']);
        await expect(processor.extractEntities('hello')).resolves.toEqual({ tools: [], projects: [] });
        expect(base.respond).toHaveBeenCalledTimes(2);
        expect(task.respond).not.toHaveBeenCalled();
    });
});
