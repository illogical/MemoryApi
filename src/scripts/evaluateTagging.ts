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
 *   npm run eval:tagging -- --model llama-3.2-3b-instruct
 *   npm run eval:tagging -- --output ./reports/tagging_eval.json
 */

import { LMStudioClient } from '@lmstudio/sdk';
import { PromptTemplateService } from '../services/promptTemplateService';
import { LoggingService } from '../services/loggingService';
import * as fs from 'fs';
import * as path from 'path';

// ==================== Type Definitions ====================

interface SeedMemory {
    content: string;
    description: string;
    category: string;
    tags: string[];
}

interface EvaluationCase {
    id: number;
    content: string;
    groundTruthTags: string[];
    predictedTags: string[];
    metrics: CaseMetrics;
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

interface EvaluationReport {
    timestamp: string;
    modelName: string;
    promptVersion: string;
    aggregateMetrics: AggregateMetrics;
    cases: EvaluationCase[];
    config: {
        temperature: number;
        maxTokens: number;
        seedMemoriesPath: string;
    };
}

// ==================== Evaluation Engine ====================

class TaggingEvaluator {
    private lmStudio: LMStudioClient;
    private promptService: PromptTemplateService;
    private logger: LoggingService;
    private modelName: string;
    private validTags: Set<string>;
    private model: any;

    constructor(
        modelName: string = (process.env.MODEL_NAME || 'llama-3.2-3b-instruct'),
        promptBasePath: string = (process.env.PROMPT_TEMPLATE_BASE_PATH || path.join(process.cwd(), '/src/prompts'))
    ) {
        this.lmStudio = new LMStudioClient();
        this.promptService = new PromptTemplateService(promptBasePath);
        this.logger = new LoggingService(path.join(process.cwd(), 'logs'), 'debug', 'info');
        this.modelName = modelName;
        this.validTags = this.loadValidTags(promptBasePath);
        this.model = null;
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
     * Load seed memories from JSON file
     */
    loadSeedMemories(seedPath: string): SeedMemory[] {
        this.logger.info(`Loading seed memories from: ${seedPath}`);
        const data = JSON.parse(fs.readFileSync(seedPath, 'utf-8'));
        return data.memories;
    }

    /**
     * Generate tags for a given content using the current model and prompt
     */
    async generateTags(content: string): Promise<string[]> {
        if (!this.model) {
            this.model = await this.lmStudio.llm.load(this.modelName);
        }
        const prompt = this.promptService.renderTagging(content);
        this.logger.debug(`Generating tags for content: ${content.substring(0, 50)}...`);
        const response = await this.model.respond([
            { role: 'system', content: 'You are a precise tagging assistant. Output only comma-separated tags, nothing else.' },
            { role: 'user', content: prompt }
        ], {
            temperature: 0.3,  // Lower temperature for more deterministic output
            maxTokens: 100
        });
        // Parse the response - expecting comma-separated tags
        const responseText = response.content.trim();
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
        
        const startTime = Date.now();
        const seedMemories = this.loadSeedMemories(seedPath);
        const cases: EvaluationCase[] = [];
        
        this.logger.info(`Evaluating ${seedMemories.length} seed memories...`);
        
        // Evaluate each seed memory
        for (let i = 0; i < seedMemories.length; i++) {
            const memory = seedMemories[i];
            this.logger.info(`\n[${i + 1}/${seedMemories.length}] Evaluating: "${memory.content.substring(0, 50)}..."`);
            
            try {
                const predictedTags = await this.generateTags(memory.content);
                const metrics = this.calculateCaseMetrics(memory.tags, predictedTags);
                
                cases.push({
                    id: i + 1,
                    content: memory.content,
                    groundTruthTags: memory.tags,
                    predictedTags,
                    metrics
                });
                
                // Log immediate feedback
                this.logger.info(`  Ground Truth: [${memory.tags.join(', ')}]`);
                this.logger.info(`  Predicted:    [${predictedTags.join(', ')}]`);
                this.logger.info(`  Precision: ${(metrics.precision * 100).toFixed(1)}% | Recall: ${(metrics.recall * 100).toFixed(1)}% | F1: ${(metrics.f1Score * 100).toFixed(1)}%`);
                
                if (metrics.hallucinatedTags.length > 0) {
                    this.logger.error(`  ⚠️  Hallucinated tags: [${metrics.hallucinatedTags.join(', ')}]`);
                }
                
            } catch (error) {
                this.logger.error(`  Error evaluating case ${i + 1}: ${error}`);
            }
        }
        
        // Calculate aggregate metrics
        const aggregateMetrics = this.calculateAggregateMetrics(cases);
        
        const elapsedTime = ((Date.now() - startTime) / 1000).toFixed(2);
        this.logger.log('\n========================================');
        this.logger.log('Evaluation Complete');
        this.logger.log('========================================');
        this.logger.log(`Total Time: ${elapsedTime}s`);
        this.logger.log(`Average Precision: ${(aggregateMetrics.averagePrecision * 100).toFixed(2)}%`);
        this.logger.log(`Average Recall: ${(aggregateMetrics.averageRecall * 100).toFixed(2)}%`);
        this.logger.log(`Average F1 Score: ${(aggregateMetrics.averageF1Score * 100).toFixed(2)}%`);
        this.logger.log(`Exact Match Rate: ${(aggregateMetrics.exactMatchRate * 100).toFixed(2)}%`);
        this.logger.log(`Hallucination Rate: ${(aggregateMetrics.hallucinationRate * 100).toFixed(2)}%`);
        
        // Generate report
        const report: EvaluationReport = {
            timestamp: new Date().toISOString(),
            modelName: this.modelName,
            promptVersion: '1.0', // You can increment this when you modify the prompt
            aggregateMetrics,
            cases,
            config: {
                temperature: 0.3,
                maxTokens: 100,
                seedMemoriesPath: seedPath
            }
        };
        
        return report;
    }

    /**
     * Save evaluation report to file
     */
    saveReport(report: EvaluationReport, outputPath: string): void {
        const dir = path.dirname(outputPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        
        fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
        this.logger.log(`\nReport saved to: ${outputPath}`);
    }

    /**
     * Generate a human-readable markdown report
     */
    generateMarkdownReport(report: EvaluationReport): string {
        const { aggregateMetrics, cases, config, modelName, promptVersion, timestamp } = report;
        
        let markdown = `# Tagging Evaluation Report\n\n`;
        markdown += `**Date:** ${new Date(timestamp).toLocaleString()}\n\n`;
        markdown += `**Model:** ${modelName}\n\n`;
        markdown += `**Prompt Version:** ${promptVersion}\n\n`;
        markdown += `**Configuration:**\n`;
        markdown += `- Temperature: ${config.temperature}\n`;
        markdown += `- Max Tokens: ${config.maxTokens}\n`;
        markdown += `- Seed Memories: ${config.seedMemoriesPath}\n\n`;
        
        markdown += `## 📊 Aggregate Metrics\n\n`;
        markdown += `| Metric | Score |\n`;
        markdown += `|--------|-------|\n`;
        markdown += `| **Average Precision** | ${(aggregateMetrics.averagePrecision * 100).toFixed(2)}% |\n`;
        markdown += `| **Average Recall** | ${(aggregateMetrics.averageRecall * 100).toFixed(2)}% |\n`;
        markdown += `| **Average F1 Score** | ${(aggregateMetrics.averageF1Score * 100).toFixed(2)}% |\n`;
        markdown += `| **Exact Match Rate** | ${(aggregateMetrics.exactMatchRate * 100).toFixed(2)}% |\n`;
        markdown += `| **Hallucination Rate** | ${(aggregateMetrics.hallucinationRate * 100).toFixed(2)}% |\n`;
        markdown += `| **Total Cases** | ${aggregateMetrics.totalCases} |\n\n`;
        
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

    const modelName = modelNameArg ? modelNameArg.split('=')[1] : undefined;
    if (!modelName) {
        console.error('Error: --model argument is required. Please provide a model name using --model=<modelName>.');
        process.exit(1);
    }
    console.log(`[Tagging Evaluation] Using model: ${modelName}`);
    const outputPath = outputArg 
        ? outputArg.split('=')[1] 
        : path.join(process.cwd(), 'reports', `tagging_eval_${new Date().toISOString().replace(/:/g, '-')}.json`);

    console.log(`[Tagging Evaluation] Output path: ${outputPath}`);

    const seedPath = path.join(process.cwd(), '/src/samples/seedMemories.json');
    console.log(`[Tagging Evaluation] Seed memories path: ${seedPath}`);

    // Create evaluator and run evaluation
    const evaluator = new TaggingEvaluator(modelName);
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
