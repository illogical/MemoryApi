/**
 * Tagging Evaluation Script
 * 
 * Purpose: Systematically evaluate the accuracy and quality of the tagging inference system.
 * This script compares model-generated tags against human-curated ground truth tags from
 * seedMemories.json to measure performance across different models or prompt variations.
 * 
 * Key Metrics:
 * - Precision: Of the tags predicted, how many were correct?
 * - Recall: Of the correct tags, how many were predicted?
 * - F1 Score: Harmonic mean of precision and recall
 * - Exact Match: Did the model predict the exact set of tags?
 * - Tag-level Analysis: Performance breakdown by individual tags
 * - Hallucination Rate: How often does the model generate invalid tags?
 * 
 * Usage:
 *   npm run eval:tagging
 *   npm run eval:tagging -- --model llama-3.2-3b-instruct --provider lmstudio
 *   npm run eval:tagging -- --output ./reports/tagging_eval.json
 */

import { BaseEvaluator, SeedMemory, BaseEvaluationReport } from '../services/baseEvaluator';
import { ModelProvider } from '../services/modelClients';
import { config } from '../services/configService';
import { assertTestEnvironment } from '../services/memoryEnvironmentService';
import * as fs from 'fs';
import * as path from 'path';

assertTestEnvironment('evaluateTagging');

// ==================== Type Definitions ====================

interface EvaluationCase {
    id: number;
    content: string;
    groundTruthTags: string[];
    predictedTags: string[];
    metrics: CaseMetrics;
    prompt: string;
}

interface CaseMetrics {
    precision: number;
    recall: number;
    f1Score: number;
    exactMatch: boolean;
    truePositives: string[];
    falsePositives: string[];
    falseNegatives: string[];
    hallucinatedTags: string[];  // Tags not in the allowed list
}

interface AggregateMetrics {
    averagePrecision: number;
    averageRecall: number;
    averageF1Score: number;
    exactMatchRate: number;
    totalCases: number;
    hallucinationRate: number;
    tagFrequency: Record<string, { predicted: number; correct: number; missed: number }>;
}

interface EvaluationReport extends BaseEvaluationReport {
    aggregateMetrics: AggregateMetrics;
    cases: EvaluationCase[];
    config: {
        temperature: number;
        maxTokens: number;
        seedMemoriesPath: string;
        averageTagGenTime?: number;
    };
}

// ==================== Evaluation Engine ====================

class TaggingEvaluator extends BaseEvaluator {
    private validTags: Set<string>;

    constructor(
        modelName: string = config.LLM_MODEL,
        promptBasePath: string = config.PROMPT_TEMPLATE_BASE_PATH,
        provider: ModelProvider = config.LLM_PROVIDER as ModelProvider
    ) {
        super(modelName, promptBasePath, provider, 0.3, 100);
        this.validTags = this.loadValidTags(promptBasePath);
    }

    /**
     * Load all valid tags from allTags.json to detect hallucinations
     */
    private loadValidTags(promptBasePath: string): Set<string> {
        const tagsPath = path.join(promptBasePath, '../samples/allTags.json');
        const tagsData = JSON.parse(fs.readFileSync(tagsPath, 'utf-8'));
        const tags = new Set<string>();

        tagsData.TagGroups.forEach((group: any) => {
            group.Tags.forEach((tag: string) => tags.add(tag));
        });

        this.logger.info(`Loaded ${tags.size} valid tags from allTags.json`);
        return tags;
    }

    /**
     * Generate tags for a given content using the current model and prompt
     */
    async generateTags(content: string): Promise<string[]> {
        const prompt = this.promptService.renderTagging(content);
        this.logger.debug(`Generating tags (${this.provider}) for content: ${content.substring(0, 50)}...`);
        const response = await this.modelClient.respond([
            { role: 'system', content: 'You are a precise tagging assistant. Output only comma-separated tags, nothing else.' },
            { role: 'user', content: prompt }
        ], {
            temperature: this.temperature,
            maxTokens: this.maxTokens
        });
        const responseText = (response.content || '').trim();
        this.logger.debug(`Raw model response: ${responseText}`);
        // Clean up the response and split into tags
        const tags = responseText
            .split(',')
            .map((tag: string) => tag.trim())
            .filter((tag: string) => tag.length > 0);
        return tags;
    }

    /**
     * Calculate metrics for a single evaluation case
     */
    calculateCaseMetrics(groundTruth: string[], predicted: string[]): CaseMetrics {
        const groundTruthSet = new Set(groundTruth);
        const predictedSet = new Set(predicted);

        // Calculate true positives (correct predictions)
        const truePositives = predicted.filter(tag => groundTruthSet.has(tag));

        // Calculate false positives (incorrect predictions - valid but not in ground truth)
        const falsePositives = predicted.filter(tag =>
            !groundTruthSet.has(tag) && this.validTags.has(tag)
        );

        // Calculate false negatives (missed tags)
        const falseNegatives = groundTruth.filter(tag => !predictedSet.has(tag));

        // Calculate hallucinations (predicted tags not in valid tag list)
        const hallucinatedTags = predicted.filter(tag => !this.validTags.has(tag));

        // Calculate precision: TP / (TP + FP + Hallucinations)
        const precision = predicted.length > 0
            ? truePositives.length / predicted.length
            : 0;

        // Calculate recall: TP / (TP + FN)
        const recall = groundTruth.length > 0
            ? truePositives.length / groundTruth.length
            : 0;

        // Calculate F1 score: harmonic mean of precision and recall
        const f1Score = (precision + recall) > 0
            ? 2 * (precision * recall) / (precision + recall)
            : 0;

        // Exact match: all ground truth tags present, no extra tags
        const exactMatch = truePositives.length === groundTruth.length &&
            predicted.length === groundTruth.length;

        return {
            precision,
            recall,
            f1Score,
            exactMatch,
            truePositives,
            falsePositives,
            falseNegatives,
            hallucinatedTags
        };
    }

    /**
     * Calculate aggregate metrics across all cases
     */
    calculateAggregateMetrics(cases: EvaluationCase[]): AggregateMetrics {
        const totalCases = cases.length;

        // Average metrics
        const averagePrecision = cases.reduce((sum, c) => sum + c.metrics.precision, 0) / totalCases;
        const averageRecall = cases.reduce((sum, c) => sum + c.metrics.recall, 0) / totalCases;
        const averageF1Score = cases.reduce((sum, c) => sum + c.metrics.f1Score, 0) / totalCases;

        // Exact match rate
        const exactMatches = cases.filter(c => c.metrics.exactMatch).length;
        const exactMatchRate = exactMatches / totalCases;

        // Hallucination rate
        const casesWithHallucinations = cases.filter(c => c.metrics.hallucinatedTags.length > 0).length;
        const hallucinationRate = casesWithHallucinations / totalCases;

        // Tag-level frequency analysis
        const tagFrequency: Record<string, { predicted: number; correct: number; missed: number }> = {};

        this.validTags.forEach(tag => {
            tagFrequency[tag] = { predicted: 0, correct: 0, missed: 0 };
        });

        cases.forEach(evalCase => {
            evalCase.predictedTags.forEach(tag => {
                if (tagFrequency[tag]) {
                    tagFrequency[tag].predicted++;
                }
            });

            evalCase.metrics.truePositives.forEach(tag => {
                if (tagFrequency[tag]) {
                    tagFrequency[tag].correct++;
                }
            });

            evalCase.metrics.falseNegatives.forEach(tag => {
                if (tagFrequency[tag]) {
                    tagFrequency[tag].missed++;
                }
            });
        });

        return {
            averagePrecision,
            averageRecall,
            averageF1Score,
            exactMatchRate,
            totalCases,
            hallucinationRate,
            tagFrequency
        };
    }

    /**
     * Run full evaluation on all seed memories
     */
    async runEvaluation(seedPath: string): Promise<EvaluationReport> {
        this.logger.log('========================================');
        this.logger.log('Starting Tagging Evaluation');
        this.logger.log('========================================');

        // Load model once before evaluation
        await this.initialize();

        const startTime = Date.now();
        const seedMemories = this.loadSeedMemories(seedPath);
        const cases: EvaluationCase[] = [];
        let totalTagGenTime = 0;

        this.logger.info(`Evaluating ${seedMemories.length} seed memories...`);

        // Evaluate each seed memory
        for (let i = 0; i < seedMemories.length; i++) {
            const memory = seedMemories[i];
            this.logger.info(`\n[${i + 1}/${seedMemories.length}] Evaluating: "${memory.content.substring(0, 50)}..."`);

            try {
                const prompt = this.promptService.renderTagging(memory.content);
                const tagGenStart = Date.now();
                const predictedTags = await this.generateTags(memory.content);
                const tagGenEnd = Date.now();
                const tagGenTime = tagGenEnd - tagGenStart;
                totalTagGenTime += tagGenTime;

                const metrics = this.calculateCaseMetrics(memory.tags, predictedTags);

                cases.push({
                    id: i + 1,
                    content: memory.content,
                    groundTruthTags: memory.tags,
                    predictedTags,
                    metrics,
                    prompt
                });

                // Log immediate feedback
                this.logger.info(`  Ground Truth: [${memory.tags.join(', ')}]`);
                this.logger.info(`  Predicted:    [${predictedTags.join(', ')}]`);
                this.logger.info(`  Precision: ${(metrics.precision * 100).toFixed(1)}% | Recall: ${(metrics.recall * 100).toFixed(1)}% | F1: ${(metrics.f1Score * 100).toFixed(1)}%`);
                this.logger.info(`  Tag Generation Time: ${(tagGenTime / 1000).toFixed(2)}s`);

                if (metrics.hallucinatedTags.length > 0) {
                    this.logger.error(`  ⚠️  Hallucinated tags: [${metrics.hallucinatedTags.join(', ')}]`);
                }

            } catch (error) {
                this.logger.error(`  Error evaluating case ${i + 1}: ${error}`);
            }
        }

        // Calculate aggregate metrics
        const aggregateMetrics = this.calculateAggregateMetrics(cases);
        const averageGenTime = cases.length > 0 ? totalTagGenTime / cases.length : 0;

        // Log evaluation summary using base class method
        this.logEvaluationSummary(
            startTime,
            aggregateMetrics,
            averageGenTime,
            { 'Hallucination Rate': aggregateMetrics.hallucinationRate }
        );

        // Generate report
        // Use the first prompt (all prompts are the same for this run)
        const firstPrompt = cases.length > 0 ? cases[0].prompt : '';
        const report: EvaluationReport = {
            timestamp: new Date().toISOString(),
            modelName: `${this.provider}:${this.modelName}`,
            promptVersion: '1.0', // You can increment this when you modify the prompt
            aggregateMetrics,
            cases,
            config: {
                temperature: this.temperature,
                maxTokens: this.maxTokens,
                seedMemoriesPath: seedPath,
                averageTagGenTime: Number((averageGenTime / 1000).toFixed(2))
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
        let markdown = this.generateMarkdownHeader(report, 'Tagging Evaluation Report');
        markdown += this.generateAggregateMetricsTable(aggregateMetrics, {
            'Hallucination Rate': aggregateMetrics.hallucinationRate
        });

        // Tag performance breakdown
        markdown += `## 🏷️ Tag Performance Analysis\n\n`;
        markdown += `| Tag | Predicted | Correct | Missed | Precision |\n`;
        markdown += `|-----|-----------|---------|--------|----------|\n`;

        const sortedTags = Object.entries(aggregateMetrics.tagFrequency)
            .filter(([_, stats]) => stats.predicted > 0 || stats.correct > 0 || stats.missed > 0)
            .sort((a, b) => b[1].predicted - a[1].predicted);

        sortedTags.forEach(([tag, stats]) => {
            const precision = stats.predicted > 0 ? (stats.correct / stats.predicted * 100).toFixed(0) : 'N/A';
            markdown += `| ${tag} | ${stats.predicted} | ${stats.correct} | ${stats.missed} | ${precision}% |\n`;
        });

        markdown += `\n## 📝 Detailed Case Results\n\n`;

        // Show cases with issues first
        const problemCases = cases.filter(c => !c.metrics.exactMatch || c.metrics.hallucinatedTags.length > 0);
        const perfectCases = cases.filter(c => c.metrics.exactMatch && c.metrics.hallucinatedTags.length === 0);

        if (problemCases.length > 0) {
            markdown += `### ⚠️ Cases with Issues (${problemCases.length})\n\n`;
            problemCases.forEach(evalCase => {
                markdown += this.formatCaseMarkdown(evalCase);
            });
        }

        if (perfectCases.length > 0) {
            markdown += `### ✅ Perfect Matches (${perfectCases.length})\n\n`;
            markdown += `<details>\n<summary>Click to expand perfect matches</summary>\n\n`;
            perfectCases.forEach(evalCase => {
                markdown += this.formatCaseMarkdown(evalCase);
            });
            markdown += `</details>\n\n`;
        }

        // Add prompt used for all cases (collapsed)
        if (report.prompt) {
            markdown += `<details>\n<summary>Show prompt used for all tag generations</summary>\n\n`;
            markdown += `\n\`\`\`\n${report.prompt}\n\`\`\`\n`;
            markdown += `</details>\n\n`;
        }

        return markdown;
    }

    /**
     * Format a single case for markdown report
     */
    private formatCaseMarkdown(evalCase: EvaluationCase): string {
        const { id, content, groundTruthTags, predictedTags, metrics } = evalCase;
        let md = `#### Case ${id}\n`;
        md += `**Content:** "${content}"\n\n`;
        md += `- **Ground Truth:** [${groundTruthTags.join(', ')}]\n`;
        md += `- **Predicted:** [${predictedTags.join(', ')}]\n`;
        md += `- **Metrics:** P=${(metrics.precision * 100).toFixed(0)}% | R=${(metrics.recall * 100).toFixed(0)}% | F1=${(metrics.f1Score * 100).toFixed(0)}%\n`;

        if (metrics.truePositives.length > 0) {
            md += `- ✅ **True Positives:** [${metrics.truePositives.join(', ')}]\n`;
        }
        if (metrics.falsePositives.length > 0) {
            md += `- ⚠️ **False Positives:** [${metrics.falsePositives.join(', ')}]\n`;
        }
        if (metrics.falseNegatives.length > 0) {
            md += `- ❌ **False Negatives:** [${metrics.falseNegatives.join(', ')}]\n`;
        }
        if (metrics.hallucinatedTags.length > 0) {
            md += `- 🚫 **Hallucinated:** [${metrics.hallucinatedTags.join(', ')}]\n`;
        }

        md += `\n`;
        return md;
    }
}

// ==================== CLI Entry Point ====================

async function main() {
    // Parse command line arguments
    const args = process.argv.slice(2);
    console.log('[Tagging Evaluation] Starting script...');
    const modelNameArg = args.find(arg => arg.startsWith('--model='));
    const outputArg = args.find(arg => arg.startsWith('--output='));
    const providerArg = args.find(arg => arg.startsWith('--provider='));

    const modelName = modelNameArg ? modelNameArg.split('=')[1] : undefined;
    if (!modelName) {
        console.error('Error: --model argument is required. Please provide a model name using --model=<modelName>.');
        process.exit(1);
    }
    console.log(`[Tagging Evaluation] Using model: ${modelName}`);
    const provider = providerArg ? (providerArg.split('=')[1] as ModelProvider) : 'lmstudio';
    if (provider !== 'lmstudio' && provider !== 'ollama') {
        console.error('Error: --provider must be either "lmstudio" or "ollama"');
        process.exit(1);
    }
    console.log(`[Tagging Evaluation] Provider: ${provider}`);
    const outputPath = outputArg
        ? outputArg.split('=')[1]
        : path.join(process.cwd(), 'reports', `tagging_eval_${new Date().toISOString().replace(/:/g, '-')}.json`);

    console.log(`[Tagging Evaluation] Output path: ${outputPath}`);

    const seedPath = path.join(process.cwd(), '/src/samples/seedMemories.json');
    console.log(`[Tagging Evaluation] Seed memories path: ${seedPath}`);

    // Create evaluator and run evaluation
    const evaluator = new TaggingEvaluator(modelName, config.PROMPT_TEMPLATE_BASE_PATH, provider);
    console.log('[Tagging Evaluation] Running evaluation...');
    const report = await evaluator.runEvaluation(seedPath);
    console.log('[Tagging Evaluation] Evaluation complete. Saving reports...');

    // Save JSON report
    evaluator.saveReport(report, outputPath);
    console.log(`[Tagging Evaluation] JSON report saved to: ${outputPath}`);

    // Save markdown report
    const markdownPath = outputPath.replace('.json', '.md');
    const markdown = evaluator.generateMarkdownReport(report);
    fs.writeFileSync(markdownPath, markdown);
    console.log(`[Tagging Evaluation] Markdown report saved to: ${markdownPath}`);
}

main();

//export { TaggingEvaluator, EvaluationReport, EvaluationCase, CaseMetrics, AggregateMetrics };
