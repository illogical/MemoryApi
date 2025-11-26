import { LLM } from '@lmstudio/sdk';
import { PromptTemplateService } from './promptTemplateService';
import { LoggingService } from './loggingService';

class MemoryTextProcessor {
    private model: LLM;
    private promptTemplateService: PromptTemplateService;
    private loggingService: LoggingService;

    constructor(model: LLM, promptTemplateService: PromptTemplateService, loggingService: LoggingService) {
        this.model = model;
        this.promptTemplateService = promptTemplateService;
        this.loggingService = loggingService;
    }

    async summarizeText(text: string): Promise<string> {
        this.loggingService.trace('[MemoryTextProcessor.summarizeText] Called');
        if (!this.model) throw new Error('[MemoryTextProcessor.summarizeText] Inference model not loaded');
        const prompt = `Summarize the following memory content for use as a description:\n\n${text}\n\nSummary:`;
        this.loggingService.debug(`[MemoryTextProcessor.summarizeText] Prompt: ${prompt}`);
        const response = await this.timeModelResponse(() => this.model.respond(prompt), 'summarizeText');
        this.loggingService.debug(`[MemoryTextProcessor.summarizeText] Response: ${response.content}`);
        return response.content.trim();
    }

    async classifyText(text: string): Promise<string> {
        this.loggingService.trace('[MemoryTextProcessor.classifyText] Called');
        if (!this.model) throw new Error('[MemoryTextProcessor.classifyText] Inference model not loaded');
        const prompt = this.promptTemplateService.renderClassification(text);
        this.loggingService.debug(`[MemoryTextProcessor.classifyText] Prompt: ${prompt}`);
        const response = await this.timeModelResponse(() => this.model.respond(prompt), 'classifyText');
        const raw = response.content.trim();
        this.loggingService.debug(`[MemoryTextProcessor.classifyText] Response: ${raw}`);
        return raw;
    }

    async tagText(text: string): Promise<string[]> {
        this.loggingService.trace('[MemoryTextProcessor.tagText] Called');
        if (!this.model) throw new Error('[MemoryTextProcessor.tagText] Inference model not loaded');
        const prompt = this.promptTemplateService.renderTagging(text);
        this.loggingService.debug(`[MemoryTextProcessor.tagText] Prompt: ${prompt}`);
        const response = await this.timeModelResponse(() => this.model.respond(prompt), 'tagText');
        const raw = response.content.trim();
        this.loggingService.debug(`[MemoryTextProcessor.tagText] Response: ${raw}`);
        return raw.split(',').map(t => t.trim()).filter(t => t.length > 0);
    }

    async summarizeClassifyAndTagTextParallel(text: string): Promise<{ summary: string, classification: string; tags: string[]; }> {
        this.loggingService.trace('[MemoryTextProcessor.summarizeClassifyAndTagTextParallel] Called');
        try {
            this.loggingService.info('[MemoryTextProcessor.summarizeClassifyAndTagTextParallel] Starting parallel summarize, classify, tag');
            const [summary, classification, tags] = await Promise.all([
                this.summarizeText(text),
                this.classifyText(text),
                this.tagText(text)
            ]);
            this.loggingService.info('[MemoryTextProcessor.summarizeClassifyAndTagTextParallel] Parallel summarize/classify/tag complete');
            return { summary, classification, tags };
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
