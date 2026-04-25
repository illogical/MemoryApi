import { PromptTemplateService } from './promptTemplateService';
import { LoggingService } from './loggingService';
import { ModelClient } from './modelClients';
import { SqlService } from './sqlService';
import { normalizeEntityNames } from '../utils/normalization';
import { MemoryCategory } from '../models/memoryCategory';

const MAX_LLM_ATTEMPTS = 3;

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
        const validCategories = this.promptTemplateService.getValidCategories();
        const prompt = this.promptTemplateService.renderClassification(text);
        this.loggingService.debug(`[MemoryTextProcessor.classifyText] Prompt: ${prompt}`);

        const call = () => this.timeModelResponse(() => this.modelClient.respond(
            [
                { role: 'system', content: 'You classify content into a single category. Output only the category.' },
                { role: 'user', content: prompt }
            ],
            { temperature: 0.3, maxTokens: 50 }
        ), 'classifyText').then(r => r.content.trim());

        const validate = (raw: string, attempt: number): string | null => {
            const matched = validCategories.find(c => c.toLowerCase() === raw.toLowerCase());
            if (!matched) {
                this.loggingService.info(`[classifyText] Attempt ${attempt}/${MAX_LLM_ATTEMPTS}: discarded invalid category "${raw}"`);
                return null;
            }
            if (attempt > 1) this.loggingService.info(`[classifyText] Valid category "${matched}" found on attempt ${attempt}`);
            return matched;
        };

        const result = await this.withLLMRetry(call, validate);
        if (result === null) this.loggingService.info(`[classifyText] All ${MAX_LLM_ATTEMPTS} attempts failed. Falling back to "${MemoryCategory.NOTE}"`);
        return result ?? MemoryCategory.NOTE;
    }

    async tagText(text: string): Promise<string[]> {
        this.loggingService.trace('[MemoryTextProcessor.tagText] Called');
        const validTagMap = new Map(
            this.promptTemplateService.getValidTags().map(t => [t.toLowerCase(), t])
        );
        const prompt = this.promptTemplateService.renderTagging(text);
        this.loggingService.debug(`[MemoryTextProcessor.tagText] Prompt: ${prompt}`);

        const call = () => this.timeModelResponse(() => this.modelClient.respond(
            [
                { role: 'system', content: 'Output only comma-separated tags, nothing else.' },
                { role: 'user', content: prompt }
            ],
            { temperature: 0.3, maxTokens: 100 }
        ), 'tagText').then(r => r.content.trim());

        const validate = (raw: string, attempt: number): string[] | null => {
            const { valid, discarded } = this.filterValidTags(raw, validTagMap);
            if (discarded.length > 0) {
                this.loggingService.info(`[tagText] Attempt ${attempt}/${MAX_LLM_ATTEMPTS}: discarded ${discarded.length} invalid tag(s): [${discarded.join(', ')}]`);
            }
            if (valid.length === 0) {
                this.loggingService.info(`[tagText] Attempt ${attempt}/${MAX_LLM_ATTEMPTS}: 0 valid tags remain. Retrying...`);
                return null;
            }
            return valid;
        };

        const result = await this.withLLMRetry(call, validate);
        if (result === null) this.loggingService.info(`[tagText] All ${MAX_LLM_ATTEMPTS} attempts failed. Returning empty tags.`);
        return result ?? [];
    }

    private filterValidTags(raw: string, validTagMap: Map<string, string>): { valid: string[]; discarded: string[] } {
        const valid: string[] = [];
        const discarded: string[] = [];
        for (const tag of raw.split(',').map(t => t.trim()).filter(t => t.length > 0)) {
            const canonical = validTagMap.get(tag.toLowerCase());
            if (canonical && !valid.includes(canonical)) {
                valid.push(canonical);
            } else if (!canonical) {
                discarded.push(tag);
            }
        }
        return { valid, discarded };
    }

    // Calls `call()` up to MAX_LLM_ATTEMPTS times, returning the first non-null result from `validate`.
    private async withLLMRetry<T>(
        call: () => Promise<string>,
        validate: (raw: string, attempt: number) => T | null
    ): Promise<T | null> {
        for (let attempt = 1; attempt <= MAX_LLM_ATTEMPTS; attempt++) {
            const result = validate(await call(), attempt);
            if (result !== null) return result;
        }
        return null;
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
            const parsed = JSON.parse(jsonStr);

            if (Array.isArray(parsed)) {
                const tags = parsed
                    .filter((t): t is string => typeof t === 'string')
                    .map(t => t.trim().toLowerCase())
                    .filter(t => t.length > 0);

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
        entities: { tools: string[]; projects: string[] };
    }> {
        this.loggingService.trace('[MemoryTextProcessor.summarizeClassifyAndTagTextParallel] Called');
        try {
            this.loggingService.info('[MemoryTextProcessor.summarizeClassifyAndTagTextParallel] Starting parallel summarize, classify, tag, suggestTags, and extractEntities');
            const entityPromise = skipEntityExtraction
                ? Promise.resolve({ tools: [], projects: [] })
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

    async extractEntities(content: string): Promise<{ tools: string[]; projects: string[] }> {
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
                projects: normalizeEntityNames(Array.isArray(parsed.projects) ? parsed.projects.filter((p: any) => typeof p === 'string') : [])
            };
        } catch (error) {
            this.loggingService.error(`[MemoryTextProcessor.extractEntities] Error parsing JSON response: ${error}`);
            return { tools: [], projects: [] };
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
