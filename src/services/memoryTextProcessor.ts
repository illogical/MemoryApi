import { PromptTemplateService } from './promptTemplateService';
import { LoggingService } from './loggingService';
import { ModelClient } from './modelClients';
import { SqlService } from './sqlService';
import { normalizeTags, normalizeEntityNames } from '../utils/normalization';

class MemoryTextProcessor {
    private modelClient: ModelClient;
    private promptTemplateService: PromptTemplateService;
    private loggingService: LoggingService;
    private sqlService: SqlService;

    constructor(modelClient: ModelClient, promptTemplateService: PromptTemplateService, loggingService: LoggingService, sqlService: SqlService) {
        this.modelClient = modelClient;
        this.promptTemplateService = promptTemplateService;
        this.loggingService = loggingService;
        this.sqlService = sqlService;
    }

    async summarizeText(text: string): Promise<string> {
        this.loggingService.trace('[MemoryTextProcessor.summarizeText] Called');
        const prompt = this.promptTemplateService.renderMemorySummary(text);
        this.loggingService.debug(`[MemoryTextProcessor.summarizeText] Prompt: ${prompt}`);
        const response = await this.timeModelResponse(() => this.modelClient.respond([
            { role: 'system', content: 'You are a concise memory summarizer. Output only the summary.' },
            { role: 'user', content: prompt }
        ], { temperature: 0.3, maxTokens: 150 }), 'summarizeText');
        this.loggingService.debug(`[MemoryTextProcessor.summarizeText] Response: ${response.content}`);
        return response.content.trim();
    }

    async classifyText(text: string): Promise<string> {
        this.loggingService.trace('[MemoryTextProcessor.classifyText] Called');
        const prompt = this.promptTemplateService.renderClassification(text);
        this.loggingService.debug(`[MemoryTextProcessor.classifyText] Prompt: ${prompt}`);
        const response = await this.timeModelResponse(() => this.modelClient.respond([
            { role: 'system', content: 'You classify content into a single category. Output only the category.' },
            { role: 'user', content: prompt }
        ], { temperature: 0.3, maxTokens: 50 }), 'classifyText');
        const raw = response.content.trim();
        this.loggingService.debug(`[MemoryTextProcessor.classifyText] Response: ${raw}`);
        return raw;
    }

    async tagText(text: string): Promise<string[]> {
        this.loggingService.trace('[MemoryTextProcessor.tagText] Called');
        const prompt = this.promptTemplateService.renderTagging(text);
        this.loggingService.debug(`[MemoryTextProcessor.tagText] Prompt: ${prompt}`);
        const response = await this.timeModelResponse(() => this.modelClient.respond([
            { role: 'system', content: 'Output only comma-separated tags, nothing else.' },
            { role: 'user', content: prompt }
        ], { temperature: 0.3, maxTokens: 100 }), 'tagText');
        const raw = response.content.trim();
        this.loggingService.debug(`[MemoryTextProcessor.tagText] Response: ${raw}`);
        const rawTags = raw.split(',').map(t => t.trim()).filter(t => t.length > 0);
        return normalizeTags(rawTags);
    }

    async suggestTags(text: string): Promise<string[]> {
        this.loggingService.trace('[MemoryTextProcessor.suggestTags] Called');
        const prompt = this.promptTemplateService.renderTagSuggestion(text);
        this.loggingService.debug(`[MemoryTextProcessor.suggestTags] Prompt: ${prompt}`);
        
        const response = await this.timeModelResponse(() => this.modelClient.respond([
            { role: 'system', content: 'You are a tag suggestion assistant. Output only a JSON array of strings.' },
            { role: 'user', content: prompt }
        ], { temperature: 0.3, maxTokens: 150 }), 'suggestTags');

        const raw = response.content.trim();
        this.loggingService.debug(`[MemoryTextProcessor.suggestTags] Response: ${raw}`);

        try {
            // Extract JSON if there's any markdown wrapping
            const jsonMatch = raw.match(/\[.*\]/s);
            const jsonStr = jsonMatch ? jsonMatch[0] : raw;
            const tags = JSON.parse(jsonStr);
            
            if (Array.isArray(tags)) {
                // Store/increase count for each tag in SQL
                for (const tag of tags) {
                    try {
                        await this.sqlService.addTagSuggestion(tag);
                    } catch (sqlError) {
                        this.loggingService.error(`[MemoryTextProcessor.suggestTags] Error saving tag "${tag}" to SQL: ${sqlError}`);
                    }
                }
                return tags;
            }
            return [];
        } catch (error) {
            this.loggingService.error(`[MemoryTextProcessor.suggestTags] Error parsing JSON response: ${error}`);
            return [];
        }
    }

    async summarizeClassifyAndTagTextParallel(
        text: string,
        skipEntityExtraction: boolean = false
    ): Promise<{
        summary: string;
        classification: string;
        tags: string[];
        suggestedTags: string[];
        entities: { tools: string[]; projects: string[]; topics: string[] };
    }> {
        this.loggingService.trace('[MemoryTextProcessor.summarizeClassifyAndTagTextParallel] Called');
        try {
            this.loggingService.info('[MemoryTextProcessor.summarizeClassifyAndTagTextParallel] Starting parallel summarize, classify, tag, suggestTags, and extractEntities');
            const entityPromise = skipEntityExtraction
                ? Promise.resolve({ tools: [], projects: [], topics: [] })
                : this.extractEntities(text);

            const [summary, classification, tags, suggestedTags, entities] = await Promise.all([
                this.summarizeText(text),
                this.classifyText(text),
                this.tagText(text),
                this.suggestTags(text),
                entityPromise
            ]);
            this.loggingService.info('[MemoryTextProcessor.summarizeClassifyAndTagTextParallel] Parallel operations complete');
            return { summary, classification, tags, suggestedTags, entities };
        } catch (error) {
            this.loggingService.error(`[MemoryTextProcessor.summarizeClassifyAndTagTextParallel] Error: ${error}`);
            throw new Error('Failed to classify, tag, and summarize text in parallel');
        }
    }

    async extractEntities(content: string): Promise<{ tools: string[]; projects: string[]; topics: string[] }> {
        this.loggingService.trace('[MemoryTextProcessor.extractEntities] Called');
        const prompt = this.promptTemplateService.renderEntityExtraction(content);
        this.loggingService.debug(`[MemoryTextProcessor.extractEntities] Prompt: ${prompt}`);
        const response = await this.timeModelResponse(() => this.modelClient.respond([
            { role: 'system', content: 'You are an entity extractor. Output only valid JSON.' },
            { role: 'user', content: prompt }
        ], { temperature: 0.1, maxTokens: 200 }), 'extractEntities');
        const raw = response.content.trim();
        this.loggingService.debug(`[MemoryTextProcessor.extractEntities] Response: ${raw}`);

        try {
            const jsonMatch = raw.match(/\{.*\}/s);
            const jsonStr = jsonMatch ? jsonMatch[0] : raw;
            const parsed = JSON.parse(jsonStr);

            return {
                tools: normalizeEntityNames(Array.isArray(parsed.tools) ? parsed.tools.filter((t: any) => typeof t === 'string') : []),
                projects: normalizeEntityNames(Array.isArray(parsed.projects) ? parsed.projects.filter((p: any) => typeof p === 'string') : []),
                topics: normalizeEntityNames(Array.isArray(parsed.topics) ? parsed.topics.filter((t: any) => typeof t === 'string') : [])
            };
        } catch (error) {
            this.loggingService.error(`[MemoryTextProcessor.extractEntities] Error parsing JSON response: ${error}`);
            return { tools: [], projects: [], topics: [] };
        }
    }

    // Helper to time and log model responses
    private async timeModelResponse<T>(fn: () => Promise<T>, caller: string): Promise<T> {
        const start = Date.now();
        const result = await fn();
        const duration = Date.now() - start;
        this.loggingService.info(`[MemoryTextProcessor.${caller}] Model response time: ${duration}ms`);
        return result;
    }
}

export { MemoryTextProcessor };
