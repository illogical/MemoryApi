/**
 * Base Evaluator Service
 * 
 * Purpose: Provide shared functionality for evaluation scripts (tagging, categorization, etc.)
 * following DRY principles. Contains common logic for:
 * - Model initialization and management
 * - Seed memory loading
 * - Generic metrics calculation
 * - Report generation and saving
 * - Markdown formatting utilities
 * 
 * This abstract base class should be extended by specific evaluators (e.g., TaggingEvaluator,
 * CategorizationEvaluator) that implement domain-specific logic.
 */

import { PromptTemplateService } from './promptTemplateService';
import { LoggingService } from './loggingService';
import { ModelClient, LMStudioModelClient, OllamaModelClient, ModelProvider } from './modelClients';
import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config();

// ==================== Shared Type Definitions ====================

export interface SeedMemory {
    content: string;
    description: string;
    category: string;
    tags: string[];
}

export interface BaseCaseMetrics {
    precision: number;
    recall: number;
    f1Score: number;
    exactMatch: boolean;
}

export interface BaseAggregateMetrics {
    averagePrecision: number;
    averageRecall: number;
    averageF1Score: number;
    exactMatchRate: number;
    totalCases: number;
}

export interface BaseEvaluationReport {
    timestamp: string;
    modelName: string;
    promptVersion: string;
    aggregateMetrics: BaseAggregateMetrics;
    cases: any[];
    config: {
        temperature: number;
        maxTokens: number;
        seedMemoriesPath: string;
        averageGenTime?: number;
    };
    prompt?: string;
}

// ==================== Base Evaluator Class ====================

export abstract class BaseEvaluator {
    protected promptService: PromptTemplateService;
    protected logger: LoggingService;
    protected modelName: string;
    protected modelClient: ModelClient;
    protected provider: ModelProvider;
    protected temperature: number;
    protected maxTokens: number;

    constructor(
        modelName: string = (process.env.LLM_MODEL || 'llama-3.2-3b-instruct'),
        promptBasePath: string = (process.env.PROMPT_TEMPLATE_BASE_PATH || path.join(process.cwd(), '/src/prompts')),
        provider: ModelProvider = ((process.env.LLM_PROVIDER as ModelProvider) || 'lmstudio'),
        temperature: number = 0.3,
        maxTokens: number = 100
    ) {
        this.promptService = new PromptTemplateService(promptBasePath);
        this.logger = new LoggingService(path.join(process.cwd(), 'logs'), 'debug', 'info');
        this.modelName = modelName;
        this.provider = provider;
        const baseUrl = process.env.LLM_HOST || 'http://localhost:11434';
        this.modelClient = provider === 'ollama' ? new OllamaModelClient(baseUrl) : new LMStudioModelClient(baseUrl);
        this.temperature = temperature;
        this.maxTokens = maxTokens;
    }

    /**
     * Initialize the model client (load model once)
     */
    async initialize(): Promise<void> {
        this.logger.info(`Loading model: ${this.modelName} (provider: ${this.provider})`);
        await this.modelClient.load(this.modelName);
        this.logger.info('Model loaded successfully');
    }

    /**
     * Load seed memories from JSON file
     */
    loadSeedMemories(seedPath: string): SeedMemory[] {
        this.logger.info(`Loading seed memories from: ${seedPath}`);
        const data = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
        return data.memories;
    }

    /**
     * Calculate basic precision, recall, and F1 for single-value predictions
     * (e.g., category classification where there's only one ground truth)
     */
    protected calculateSingleValueMetrics(groundTruth: string, predicted: string): BaseCaseMetrics {
        const exactMatch = groundTruth === predicted;
        const precision = exactMatch ? 1.0 : 0.0;
        const recall = exactMatch ? 1.0 : 0.0;
        const f1Score = exactMatch ? 1.0 : 0.0;

        return {
            precision,
            recall,
            f1Score,
            exactMatch
        };
    }

    /**
     * Calculate basic precision, recall, and F1 for multi-value predictions
     * (e.g., tags where there are multiple ground truths)
     */
    protected calculateMultiValueMetrics(groundTruth: string[], predicted: string[]): BaseCaseMetrics {
        const groundTruthSet = new Set(groundTruth);
        const predictedSet = new Set(predicted);
        
        // Calculate true positives (correct predictions)
        const truePositives = predicted.filter(item => groundTruthSet.has(item));
        
        // Calculate precision: TP / Total Predicted
        const precision = predicted.length > 0 
            ? truePositives.length / predicted.length 
            : 0;
        
        // Calculate recall: TP / Total Ground Truth
        const recall = groundTruth.length > 0 
            ? truePositives.length / groundTruth.length 
            : 0;
        
        // Calculate F1 score: harmonic mean of precision and recall
        const f1Score = (precision + recall) > 0 
            ? 2 * (precision * recall) / (precision + recall) 
            : 0;
        
        // Exact match: all ground truth items present, no extra items
        const exactMatch = truePositives.length === groundTruth.length && 
                          predicted.length === groundTruth.length;
        
        return {
            precision,
            recall,
            f1Score,
            exactMatch
        };
    }

    /**
     * Calculate aggregate metrics across all cases
     */
    calculateAggregateMetrics(cases: any[]): BaseAggregateMetrics {
        const totalCases = cases.length;
        
        if (totalCases === 0) {
            return {
                averagePrecision: 0,
                averageRecall: 0,
                averageF1Score: 0,
                exactMatchRate: 0,
                totalCases: 0
            };
        }
        
        // Average metrics
        const averagePrecision = cases.reduce((sum, c) => sum + c.metrics.precision, 0) / totalCases;
        const averageRecall = cases.reduce((sum, c) => sum + c.metrics.recall, 0) / totalCases;
        const averageF1Score = cases.reduce((sum, c) => sum + c.metrics.f1Score, 0) / totalCases;
        
        // Exact match rate
        const exactMatches = cases.filter(c => c.metrics.exactMatch).length;
        const exactMatchRate = exactMatches / totalCases;
        
        return {
            averagePrecision,
            averageRecall,
            averageF1Score,
            exactMatchRate,
            totalCases
        };
    }

    /**
     * Save evaluation report to file
     */
    saveReport(report: BaseEvaluationReport, outputPath: string): void {
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
        this.logger.log(`\nReport saved to: ${outputPath}`);
    }

    /**
     * Generate markdown header for reports
     */
    protected generateMarkdownHeader(report: BaseEvaluationReport, title: string): string {
        const { modelName, promptVersion, timestamp, config } = report;
        
        let markdown = `# ${title}\n\n`;
        markdown += `**Date:** ${new Date(timestamp).toLocaleString()}\n\n`;
        markdown += `**Prompt Version:** ${promptVersion}\n`;
        markdown += `**Model:** ${modelName}\n\n`;
        markdown += `**Configuration:**\n`;
        markdown += `- Temperature: ${config.temperature}\n`;
        markdown += `- Max Tokens: ${config.maxTokens}\n`;
        markdown += `- Seed Memories: ${config.seedMemoriesPath}\n`;
        if (config.averageGenTime !== undefined) {
            markdown += `- Average Generation Time: ${config.averageGenTime}s\n`;
        }
        markdown += `\n`;
        
        return markdown;
    }

    /**
     * Generate aggregate metrics table for markdown
     */
    protected generateAggregateMetricsTable(aggregateMetrics: BaseAggregateMetrics, additionalMetrics?: Record<string, number>): string {
        let markdown = `## 📊 Aggregate Metrics\n\n`;
        markdown += `| Metric | Score |\n`;
        markdown += `|--------|-------|\n`;
        markdown += `| **Average Precision** | ${(aggregateMetrics.averagePrecision * 100).toFixed(2)}% |\n`;
        markdown += `| **Average Recall** | ${(aggregateMetrics.averageRecall * 100).toFixed(2)}% |\n`;
        markdown += `| **Average F1 Score** | ${(aggregateMetrics.averageF1Score * 100).toFixed(2)}% |\n`;
        markdown += `| **Exact Match Rate** | ${(aggregateMetrics.exactMatchRate * 100).toFixed(2)}% |\n`;
        
        // Add any additional metrics passed in
        if (additionalMetrics) {
            for (const [key, value] of Object.entries(additionalMetrics)) {
                markdown += `| **${key}** | ${(value * 100).toFixed(2)}% |\n`;
            }
        }
        
        markdown += `| **Total Cases** | ${aggregateMetrics.totalCases} |\n\n`;
        
        return markdown;
    }

    /**
     * Log evaluation summary to console
     */
    protected logEvaluationSummary(
        startTime: number,
        aggregateMetrics: BaseAggregateMetrics,
        averageGenTime: number,
        additionalMetrics?: Record<string, number>
    ): void {
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        this.logger.log('\n========================================');
        this.logger.log('Evaluation Complete');
        this.logger.log('========================================');
        this.logger.log(`Total Time: ${elapsedTime}s`);
        this.logger.log(`Average Precision: ${(aggregateMetrics.averagePrecision * 100).toFixed(2)}%`);
        this.logger.log(`Average Recall: ${(aggregateMetrics.averageRecall * 100).toFixed(2)}%`);
        this.logger.log(`Average F1 Score: ${(aggregateMetrics.averageF1Score * 100).toFixed(2)}%`);
        this.logger.log(`Exact Match Rate: ${(aggregateMetrics.exactMatchRate * 100).toFixed(2)}%`);
        
        if (additionalMetrics) {
            for (const [key, value] of Object.entries(additionalMetrics)) {
                this.logger.log(`${key}: ${(value * 100).toFixed(2)}%`);
            }
        }
        
        this.logger.log(`Average Generation Time: ${(averageGenTime / 1000).toFixed(2)}s`);
    }

    /**
     * Abstract method: Each evaluator must implement its own evaluation logic
     */
    abstract runEvaluation(seedPath: string): Promise<BaseEvaluationReport>;

    /**
     * Abstract method: Each evaluator must implement its own markdown report generation
     */
    abstract generateMarkdownReport(report: BaseEvaluationReport): string;
}
