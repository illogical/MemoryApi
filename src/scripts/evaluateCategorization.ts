/**
 * Categorization Evaluation Script
 * 
 * Purpose: Systematically evaluate the accuracy and quality of the categorization inference system.
 * This script compares model-generated categories against human-curated ground truth categories from
 * seedMemories.json to measure performance across different models or prompt variations.
 * 
 * Key Metrics:
 * - Accuracy: Percentage of correctly classified memories
 * - Precision/Recall/F1: Per-category performance metrics
 * - Confusion Matrix: Shows which categories are confused with each other
 * - Category-level Analysis: Performance breakdown by individual categories
 * 
 * Usage:
 *   npm run eval:categorization
 *   npm run eval:categorization -- --model llama-3.2-3b-instruct --provider lmstudio
 *   npm run eval:categorization -- --output ./reports/categorization_eval.json
 */

import { BaseEvaluator, BaseEvaluationReport } from '../services/baseEvaluator';
import { ModelProvider } from '../services/modelClients';
import { config } from '../services/configService';
import { assertTestEnvironment } from '../services/memoryEnvironmentService';
import * as fs from 'fs';
import * as path from 'path';

assertTestEnvironment('evaluateCategorization');

// ==================== Type Definitions ====================

interface EvaluationCase {
    id: number;
    content: string;
    groundTruthCategory: string;
    predictedCategory: string;
    metrics: CaseMetrics;
    prompt: string;
}

interface CaseMetrics {
    precision: number;
    recall: number;
    f1Score: number;
    exactMatch: boolean;
}

interface AggregateMetrics {
    averagePrecision: number;
    averageRecall: number;
    averageF1Score: number;
    exactMatchRate: number;
    totalCases: number;
    accuracy: number;
    confusionMatrix: Record<string, Record<string, number>>;
    categoryPerformance: Record<string, { correct: number; total: number; accuracy: number }>;
}

interface EvaluationReport extends BaseEvaluationReport {
    aggregateMetrics: AggregateMetrics;
    cases: EvaluationCase[];
    config: {
        temperature: number;
        maxTokens: number;
        seedMemoriesPath: string;
        averageCategoryGenTime?: number;
    };
}

// ==================== Evaluation Engine ====================

class CategorizationEvaluator extends BaseEvaluator {
    private validCategories: Set<string>;

    constructor(
        modelName: string = config.LLM_MODEL,
        promptBasePath: string = config.PROMPT_TEMPLATE_BASE_PATH,
        provider: ModelProvider = config.LLM_PROVIDER as ModelProvider
    ) {
        super(modelName, promptBasePath, provider, 0.3, 50);
        this.validCategories = this.loadValidCategories();
    }

    /**
     * Load all valid categories from the classification prompt
     */
    private loadValidCategories(): Set<string> {
        const categories = new Set<string>([
            'Preference',
            'Reminder',
            'Code snippet',
            'Event',
            'Note',
            'Prompt',
            'Idea'
        ]);

        this.logger.info(`Loaded ${categories.size} valid categories`);
        return categories;
    }

    /**
     * Generate category for a given content using the current model and prompt
     */
    async generateCategory(content: string): Promise<string> {
        const prompt = this.promptService.renderClassification(content);
        this.logger.debug(`Generating category (${this.provider}) for content: ${content.substring(0, 50)}...`);
        const response = await this.modelClient.respond([
            { role: 'system', content: 'You are a precise classification assistant. Output only the single most relevant category name, nothing else.' },
            { role: 'user', content: prompt }
        ], {
            temperature: this.temperature,
            maxTokens: this.maxTokens
        });
        const responseText = (response.content || '').trim();
        this.logger.debug(`Raw model response: ${responseText}`);

        // Clean up the response - remove quotes, extra whitespace, etc.
        let category = responseText
            .replace(/^["']|["']$/g, '')  // Remove surrounding quotes
            .replace(/^Category:\s*/i, '')  // Remove "Category:" prefix if present
            .trim();

        return category;
    }

    /**
     * Calculate metrics for a single evaluation case
     */
    calculateCaseMetrics(groundTruth: string, predicted: string): CaseMetrics {
        return this.calculateSingleValueMetrics(groundTruth, predicted);
    }

    /**
     * Calculate aggregate metrics across all cases including confusion matrix
     */
    calculateAggregateMetrics(cases: EvaluationCase[]): AggregateMetrics {
        const baseMetrics = super.calculateAggregateMetrics(cases);
        const totalCases = cases.length;

        // Calculate accuracy (same as exactMatchRate for single-value classification)
        const accuracy = baseMetrics.exactMatchRate;

        // Build confusion matrix
        const confusionMatrix: Record<string, Record<string, number>> = {};
        this.validCategories.forEach(cat => {
            confusionMatrix[cat] = {};
            this.validCategories.forEach(pred => {
                confusionMatrix[cat][pred] = 0;
            });
        });

        // Build category performance stats
        const categoryPerformance: Record<string, { correct: number; total: number; accuracy: number }> = {};
        this.validCategories.forEach(cat => {
            categoryPerformance[cat] = { correct: 0, total: 0, accuracy: 0 };
        });

        // Populate matrices
        cases.forEach(evalCase => {
            const gt = evalCase.groundTruthCategory;
            const pred = evalCase.predictedCategory;

            // Update confusion matrix
            if (confusionMatrix[gt] && confusionMatrix[gt][pred] !== undefined) {
                confusionMatrix[gt][pred]++;
            }

            // Update category performance
            if (categoryPerformance[gt]) {
                categoryPerformance[gt].total++;
                if (evalCase.metrics.exactMatch) {
                    categoryPerformance[gt].correct++;
                }
            }
        });

        // Calculate accuracy for each category
        Object.keys(categoryPerformance).forEach(cat => {
            const perf = categoryPerformance[cat];
            perf.accuracy = perf.total > 0 ? perf.correct / perf.total : 0;
        });

        return {
            ...baseMetrics,
            accuracy,
            confusionMatrix,
            categoryPerformance
        };
    }

    /**
     * Run full evaluation on all seed memories
     */
    async runEvaluation(seedPath: string): Promise<EvaluationReport> {
        this.logger.log('========================================');
        this.logger.log('Starting Categorization Evaluation');
        this.logger.log('========================================');

        // Load model once before evaluation
        await this.initialize();

        const startTime = Date.now();
        const seedMemories = this.loadSeedMemories(seedPath);
        const cases: EvaluationCase[] = [];
        let totalCategoryGenTime = 0;

        this.logger.info(`Evaluating ${seedMemories.length} seed memories...`);

        // Evaluate each seed memory
        for (let i = 0; i < seedMemories.length; i++) {
            const memory = seedMemories[i];
            this.logger.info(`\n[${i + 1}/${seedMemories.length}] Evaluating: "${memory.content.substring(0, 50)}..."`);

            try {
                const prompt = this.promptService.renderClassification(memory.content);
                const categoryGenStart = Date.now();
                const predictedCategory = await this.generateCategory(memory.content);
                const categoryGenEnd = Date.now();
                const categoryGenTime = categoryGenEnd - categoryGenStart;
                totalCategoryGenTime += categoryGenTime;

                const metrics = this.calculateCaseMetrics(memory.category, predictedCategory);

                cases.push({
                    id: i + 1,
                    content: memory.content,
                    groundTruthCategory: memory.category,
                    predictedCategory,
                    metrics,
                    prompt
                });

                // Log immediate feedback
                this.logger.info(`  Ground Truth: ${memory.category}`);
                this.logger.info(`  Predicted:    ${predictedCategory}`);
                this.logger.info(`  Match: ${metrics.exactMatch ? '✓' : '✗'} | Precision: ${(metrics.precision * 100).toFixed(1)}% | Recall: ${(metrics.recall * 100).toFixed(1)}% | F1: ${(metrics.f1Score * 100).toFixed(1)}%`);
                this.logger.info(`  Category Generation Time: ${(categoryGenTime / 1000).toFixed(2)}s`);

            } catch (error) {
                this.logger.error(`  Error evaluating case ${i + 1}: ${error}`);
            }
        }

        // Calculate aggregate metrics
        const aggregateMetrics = this.calculateAggregateMetrics(cases);
        const averageGenTime = cases.length > 0 ? totalCategoryGenTime / cases.length : 0;

        // Log evaluation summary using base class method
        this.logEvaluationSummary(
            startTime,
            aggregateMetrics,
            averageGenTime,
            { 'Accuracy': aggregateMetrics.accuracy }
        );

        // Generate report
        const firstPrompt = cases.length > 0 ? cases[0].prompt : '';
        const report: EvaluationReport = {
            timestamp: new Date().toISOString(),
            modelName: `${this.provider}:${this.modelName}`,
            promptVersion: '1.0',
            aggregateMetrics,
            cases,
            config: {
                temperature: this.temperature,
                maxTokens: this.maxTokens,
                seedMemoriesPath: seedPath,
                averageCategoryGenTime: Number((averageGenTime / 1000).toFixed(2))
            },
            prompt: firstPrompt
        };

        return report;
    }

    /**
     * Generate a human-readable markdown report
     */
    generateMarkdownReport(report: EvaluationReport): string {
        const { aggregateMetrics, cases } = report;

        // Use base class methods for common markdown sections
        let markdown = this.generateMarkdownHeader(report, 'Categorization Evaluation Report');
        markdown += this.generateAggregateMetricsTable(aggregateMetrics, {
            'Accuracy': aggregateMetrics.accuracy
        });

        // Category performance breakdown
        markdown += `## 📂 Category Performance Analysis\n\n`;
        markdown += `| Category | Total | Correct | Accuracy |\n`;
        markdown += `|----------|-------|---------|----------|\n`;

        const sortedCategories = Object.entries(aggregateMetrics.categoryPerformance)
            .filter(([_, stats]) => stats.total > 0)
            .sort((a, b) => b[1].accuracy - a[1].accuracy);

        sortedCategories.forEach(([category, stats]) => {
            markdown += `| ${category} | ${stats.total} | ${stats.correct} | ${(stats.accuracy * 100).toFixed(0)}% |\n`;
        });

        // Confusion Matrix
        markdown += `\n## 🔀 Confusion Matrix\n\n`;
        markdown += `Rows represent ground truth categories, columns represent predicted categories.\n\n`;

        // Build confusion matrix table
        const categoriesWithData = Object.keys(aggregateMetrics.categoryPerformance)
            .filter(cat => aggregateMetrics.categoryPerformance[cat].total > 0);

        markdown += `| Ground Truth \\ Predicted | ${categoriesWithData.join(' | ')} |\n`;
        markdown += `|${'-'.repeat(25)}|${categoriesWithData.map(() => '---').join('|')}|\n`;

        categoriesWithData.forEach(gtCat => {
            const row = categoriesWithData.map(predCat => {
                const count = aggregateMetrics.confusionMatrix[gtCat]?.[predCat] || 0;
                return count > 0 ? `**${count}**` : '0';
            });
            markdown += `| **${gtCat}** | ${row.join(' | ')} |\n`;
        });

        markdown += `\n## 📝 Detailed Case Results\n\n`;

        // Show incorrect cases first
        const incorrectCases = cases.filter(c => !c.metrics.exactMatch);
        const correctCases = cases.filter(c => c.metrics.exactMatch);

        if (incorrectCases.length > 0) {
            markdown += `### ❌ Incorrect Classifications (${incorrectCases.length})\n\n`;
            incorrectCases.forEach(evalCase => {
                markdown += this.formatCaseMarkdown(evalCase);
            });
        }

        if (correctCases.length > 0) {
            markdown += `### ✅ Correct Classifications (${correctCases.length})\n\n`;
            markdown += `<details>\n<summary>Click to expand correct classifications</summary>\n\n`;
            correctCases.forEach(evalCase => {
                markdown += this.formatCaseMarkdown(evalCase);
            });
            markdown += `</details>\n\n`;
        }

        // Add prompt used for all cases (collapsed)
        if (report.prompt) {
            markdown += `<details>\n<summary>Show prompt used for all category classifications</summary>\n\n`;
            markdown += `\n\`\`\`\n${report.prompt}\n\`\`\`\n`;
            markdown += `</details>\n\n`;
        }

        return markdown;
    }

    /**
     * Format a single case for markdown report
     */
    private formatCaseMarkdown(evalCase: EvaluationCase): string {
        const { id, content, groundTruthCategory, predictedCategory, metrics } = evalCase;
        let md = `#### Case ${id}\n`;
        md += `**Content:** "${content}"\n\n`;
        md += `- **Ground Truth:** ${groundTruthCategory}\n`;
        md += `- **Predicted:** ${predictedCategory}\n`;
        md += `- **Match:** ${metrics.exactMatch ? '✓ Correct' : '✗ Incorrect'}\n`;
        md += `\n`;
        return md;
    }
}

// ==================== CLI Entry Point ====================

async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);
    console.log('[Categorization Evaluation] Starting script...');
    const modelNameArg = args.find(arg => arg.startsWith('--model='));
    const outputArg = args.find(arg => arg.startsWith('--output='));
    const providerArg = args.find(arg => arg.startsWith('--provider='));

    const modelName = modelNameArg ? modelNameArg.split('=')[1] : undefined;
    if (!modelName) {
        console.error('Error: --model argument is required. Please provide a model name using --model=<modelName>.');
        process.exit(1);
    }
    console.log(`[Categorization Evaluation] Using model: ${modelName}`);

    const provider = providerArg ? (providerArg.split('=')[1] as ModelProvider) : 'lmstudio';
    if (provider !== 'lmstudio' && provider !== 'ollama') {
        console.error('Error: --provider must be either "lmstudio" or "ollama"');
        process.exit(1);
    }
    console.log(`[Categorization Evaluation] Provider: ${provider}`);

    const outputPath = outputArg
        ? outputArg.split('=')[1]
        : path.join(process.cwd(), 'reports', `categorization_eval_${new Date().toISOString().replace(/:/g, '-')}.json`);

    console.log(`[Categorization Evaluation] Output path: ${outputPath}`);

    const seedPath = path.join(process.cwd(), '/src/samples/seedMemories.json');
    console.log(`[Categorization Evaluation] Seed memories path: ${seedPath}`);

    // Create evaluator and run evaluation
    const evaluator = new CategorizationEvaluator(modelName, config.PROMPT_TEMPLATE_BASE_PATH, provider);
    console.log('[Categorization Evaluation] Running evaluation...');
    const report = await evaluator.runEvaluation(seedPath);
    console.log('[Categorization Evaluation] Evaluation complete. Saving reports...');

    // Save JSON report
    evaluator.saveReport(report, outputPath);
    console.log(`[Categorization Evaluation] JSON report saved to: ${outputPath}`);

    // Save markdown report
    const markdownPath = outputPath.replace('.json', '.md');
    const markdown = evaluator.generateMarkdownReport(report);
    fs.writeFileSync(markdownPath, markdown);
    console.log(`[Categorization Evaluation] Markdown report saved to: ${markdownPath}`);
}

main();
