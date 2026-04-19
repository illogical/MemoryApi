/**
 * Entity Extraction Evaluation Script
 *
 * Compares LLM-extracted entities (tools, projects, topics) against the
 * hand-curated ground-truth values in seedMemories.json.
 *
 * Key Metrics:
 * - Precision: Of the entities predicted, how many were in ground truth?
 * - Recall: Of the ground-truth entities, how many were predicted?
 * - F1 Score: Harmonic mean of precision and recall
 * - Per-entity-type breakdown (tools / projects / topics)
 *
 * Usage:
 *   npx tsx src/scripts/evaluateEntityExtraction.ts
 *   npx tsx src/scripts/evaluateEntityExtraction.ts --model=phi-4 --provider=lmstudio
 */

import { BaseEvaluator } from '../services/baseEvaluator';
import { ModelProvider } from '../services/modelClients';
import { config } from '../services/configService';
import { normalizeEntityNames } from '../utils/normalization';
import * as fs from 'fs';
import * as path from 'path';

// ==================== Types ====================

interface EntityGroundTruth {
    tools: string[];
    projects: string[];
    topics: string[];
}

interface EntityMetrics {
    precision: number;
    recall: number;
    f1Score: number;
    truePositives: string[];
    falsePositives: string[];
    falseNegatives: string[];
}

interface EntityEvalCase {
    id: number;
    content: string;
    groundTruth: EntityGroundTruth;
    predicted: EntityGroundTruth;
    metrics: {
        tools: EntityMetrics;
        projects: EntityMetrics;
        topics: EntityMetrics;
    };
    durationMs: number;
}

interface AggregateEntityMetrics {
    averagePrecision: number;
    averageRecall: number;
    averageF1Score: number;
    totalCases: number;
}

interface EntityEvalReport {
    timestamp: string;
    modelName: string;
    provider: string;
    tools: AggregateEntityMetrics;
    projects: AggregateEntityMetrics;
    topics: AggregateEntityMetrics;
    cases: EntityEvalCase[];
    averageDurationMs: number;
}

// ==================== Evaluator ====================

class EntityExtractionEvaluator extends BaseEvaluator {
    constructor(
        modelName: string = config.LLM_MODEL,
        promptBasePath: string = config.PROMPT_TEMPLATE_BASE_PATH,
        provider: ModelProvider = config.LLM_PROVIDER as ModelProvider
    ) {
        super(modelName, promptBasePath, provider, 0.1, 200);
    }

    async extractEntities(content: string): Promise<EntityGroundTruth> {
        const prompt = this.promptService.renderEntityExtraction(content);
        const response = await this.modelClient.respond([
            { role: 'system', content: 'You are an entity extractor. Output only valid JSON.' },
            { role: 'user', content: prompt }
        ], { temperature: this.temperature, maxTokens: this.maxTokens });

        const raw = (response.content || '').trim();
        try {
            const jsonMatch = raw.match(/\{.*\}/s);
            const jsonStr = jsonMatch ? jsonMatch[0] : raw;
            const parsed = JSON.parse(jsonStr);
            return {
                tools: normalizeEntityNames(Array.isArray(parsed.tools) ? parsed.tools.filter((t: any) => typeof t === 'string') : []),
                projects: normalizeEntityNames(Array.isArray(parsed.projects) ? parsed.projects.filter((p: any) => typeof p === 'string') : []),
                topics: normalizeEntityNames(Array.isArray(parsed.topics) ? parsed.topics.filter((t: any) => typeof t === 'string') : [])
            };
        } catch {
            return { tools: [], projects: [], topics: [] };
        }
    }

    calcMetrics(groundTruth: string[], predicted: string[]): EntityMetrics {
        const gtSet = new Set(groundTruth.map(s => s.toLowerCase()));
        const predSet = new Set(predicted.map(s => s.toLowerCase()));

        const truePositives = predicted.filter(p => gtSet.has(p.toLowerCase()));
        const falsePositives = predicted.filter(p => !gtSet.has(p.toLowerCase()));
        const falseNegatives = groundTruth.filter(g => !predSet.has(g.toLowerCase()));

        const precision = predicted.length > 0 ? truePositives.length / predicted.length : 0;
        const recall = groundTruth.length > 0 ? truePositives.length / groundTruth.length : 0;
        const f1Score = precision + recall > 0 ? 2 * precision * recall / (precision + recall) : 0;

        return { precision, recall, f1Score, truePositives, falsePositives, falseNegatives };
    }

    aggregate(cases: EntityEvalCase[], type: keyof EntityEvalCase['metrics']): AggregateEntityMetrics {
        const relevant = cases.filter(c => c.groundTruth[type].length > 0);
        const totalCases = relevant.length;
        if (totalCases === 0) return { averagePrecision: 0, averageRecall: 0, averageF1Score: 0, totalCases: 0 };

        return {
            averagePrecision: relevant.reduce((s, c) => s + c.metrics[type].precision, 0) / totalCases,
            averageRecall: relevant.reduce((s, c) => s + c.metrics[type].recall, 0) / totalCases,
            averageF1Score: relevant.reduce((s, c) => s + c.metrics[type].f1Score, 0) / totalCases,
            totalCases
        };
    }
}

// ==================== Main ====================

function parseArgs() {
    const args = process.argv.slice(2);
    const get = (prefix: string) => args.find(a => a.startsWith(prefix))?.split('=')[1];
    return {
        model: get('--model') || config.LLM_MODEL,
        provider: (get('--provider') || config.LLM_PROVIDER) as ModelProvider
    };
}

async function main() {
    const { model, provider } = parseArgs();
    const seedsPath = path.join(process.cwd(), 'src/samples/seedMemories.json');
    const seedsRaw = JSON.parse(fs.readFileSync(seedsPath, 'utf-8'));

    // Only evaluate entries that have explicit ground-truth entity values
    const fixtures = (seedsRaw.memories as any[]).filter(
        m => (m.tools?.length || m.projects?.length || m.topics?.length)
    );

    console.log(`\n=== Entity Extraction Evaluation ===`);
    console.log(`Model: ${model} (${provider})`);
    console.log(`Fixtures: ${fixtures.length} seed entries with ground-truth entities\n`);

    const evaluator = new EntityExtractionEvaluator(model, config.PROMPT_TEMPLATE_BASE_PATH, provider);
    await evaluator.initialize();

    const cases: EntityEvalCase[] = [];

    for (let i = 0; i < fixtures.length; i++) {
        const seed = fixtures[i];
        const groundTruth: EntityGroundTruth = {
            tools: normalizeEntityNames(seed.tools || []),
            projects: normalizeEntityNames(seed.projects || []),
            topics: normalizeEntityNames(seed.topics || [])
        };

        const start = Date.now();
        const predicted = await evaluator.extractEntities(seed.content);
        const durationMs = Date.now() - start;

        const evalCase: EntityEvalCase = {
            id: i + 1,
            content: seed.content.substring(0, 80) + (seed.content.length > 80 ? '...' : ''),
            groundTruth,
            predicted,
            metrics: {
                tools: evaluator.calcMetrics(groundTruth.tools, predicted.tools),
                projects: evaluator.calcMetrics(groundTruth.projects, predicted.projects),
                topics: evaluator.calcMetrics(groundTruth.topics, predicted.topics)
            },
            durationMs
        };

        cases.push(evalCase);
        console.log(`  [${i + 1}/${fixtures.length}] Tools F1=${evalCase.metrics.tools.f1Score.toFixed(2)}, Topics F1=${evalCase.metrics.topics.f1Score.toFixed(2)} (${durationMs}ms)`);
    }

    const report: EntityEvalReport = {
        timestamp: new Date().toISOString(),
        modelName: model,
        provider,
        tools: evaluator.aggregate(cases, 'tools'),
        projects: evaluator.aggregate(cases, 'projects'),
        topics: evaluator.aggregate(cases, 'topics'),
        cases,
        averageDurationMs: cases.reduce((s, c) => s + c.durationMs, 0) / cases.length
    };

    console.log('\n--- Aggregate Results ---');
    for (const type of ['tools', 'projects', 'topics'] as const) {
        const m = report[type];
        if (m.totalCases === 0) continue;
        console.log(`${type.padEnd(10)}: P=${m.averagePrecision.toFixed(3)}  R=${m.averageRecall.toFixed(3)}  F1=${m.averageF1Score.toFixed(3)}  (n=${m.totalCases})`);
    }
    console.log(`Avg latency: ${report.averageDurationMs.toFixed(0)}ms`);

    // Save report
    const reportsDir = path.join(process.cwd(), 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const reportPath = path.join(reportsDir, `entity_eval_${ts}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`\nReport saved to: ${reportPath}`);
}

main().catch(err => {
    console.error('Error in evaluateEntityExtraction:', err);
    process.exit(1);
});
