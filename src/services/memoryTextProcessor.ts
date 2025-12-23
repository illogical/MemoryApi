import { PromptTemplateService } from './promptTemplateService';
import { LoggingService } from './loggingService';
import { ModelClient } from './modelClients';
import { SqlService } from './sqlService';

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
        return raw.split(',').map(t => t.trim()).filter(t => t.length > 0);
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

    async summarizeClassifyAndTagTextParallel(text: string): Promise<{ summary: string, classification: string; tags: string[]; suggestedTags: string[]; }> {
        this.loggingService.trace('[MemoryTextProcessor.summarizeClassifyAndTagTextParallel] Called');
        try {
            this.loggingService.info('[MemoryTextProcessor.summarizeClassifyAndTagTextParallel] Starting parallel summarize, classify, tag, and suggestTags');
            const [summary, classification, tags, suggestedTags] = await Promise.all([
                this.summarizeText(text),
                this.classifyText(text),
                this.tagText(text),
                this.suggestTags(text)
            ]);
            this.loggingService.info('[MemoryTextProcessor.summarizeClassifyAndTagTextParallel] Parallel summarize/classify/tag/suggestTags complete');
            return { summary, classification, tags, suggestedTags };
        } catch (error) {
            this.loggingService.error(`[MemoryTextProcessor.summarizeClassifyAndTagTextParallel] Error: ${error}`);
            throw new Error('Failed to classify, tag, and summarize text in parallel');
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
