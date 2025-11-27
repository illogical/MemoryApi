/*
    Purpose: Run semantic search queries from a JSON file against the Memory RAG system,
    summarize results, and generate a combined effectiveness report.

    Usages:
    npx tsx src/scripts/evaluateSemanticQueries.ts --model=phi-4 --provider=lmstudio
    npx tsx src/scripts/evaluateSemanticQueries.ts --queries=src/samples/semanticSearchQueries.json --strategy=hybrid --format=both --limit=12
*/

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { MemoryReportService } from '../services/MemoryReportService';

// Load environment variables
dotenv.config();

async function main() {
    const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
    const embeddingModel = process.env.EMBEDDING_MODEL || 'nomic-embed-text-v1.5';
    const modelName = process.env.AGGREGATION_MODEL || process.env.MODEL_NAME || 'llama-3.2-3b-instruct';

    // Instantiate RAG system and report service
    const rag = new MemoryRAGSystem(qdrantUrl, embeddingModel, modelName);
    const reportService = new MemoryReportService('reports');

    // Ensure collection exists (safe to call)
    try {
        await rag.initializeCollection();
    } catch (e) {
        // If collection exists, initialization may succeed silently or throw; ignore non-critical errors
    }

    // CLI overrides
    const args = process.argv.slice(2);
    const queriesArg = args.find(a => a.startsWith('--queries='));
    const strategyArg = args.find(a => a.startsWith('--strategy='));
    const formatArg = args.find(a => a.startsWith('--format='));
    const limitArg = args.find(a => a.startsWith('--limit='));

    // Load queries JSON
    const queriesPath = queriesArg ? queriesArg.split('=')[1] : path.join(process.cwd(), 'src', 'samples', 'semanticSearchQueries.json');
    const raw = fs.readFileSync(queriesPath, 'utf-8');
    const data = JSON.parse(raw);
    const queries: Array<{ query: string; options?: any }> = data.queries || [];

    console.log(`[RunSemanticQueries] Loaded ${queries.length} queries from ${queriesPath}`);

    // Run each query, collect results for a combined report
    const results: Array<{
        query: string;
        topMemories: any[];
        aggregateNarrative?: string;
        aggregateBullets?: string[];
        clusterSummaries?: Array<{ key: string; type: 'category' | 'tag'; narrative?: string; bullets?: string[] }>;
        parameters: any;
    }> = [];

    for (let i = 0; i < queries.length; i++) {
        const { query, options } = queries[i];
        const mergedOptions = {
            ...(options || {}),
            ...(strategyArg ? { strategy: strategyArg.split('=')[1] } : {}),
            ...(formatArg ? { format: formatArg.split('=')[1] } : {}),
            ...(limitArg ? { limit: Number(limitArg.split('=')[1]) } : {})
        };
        console.log(`\n[${i + 1}/${queries.length}] Query: ${query}`);
        try {
            const result = await rag.searchAndSummarizeForMcp(query, mergedOptions, false);
            const topCount = result.topMemories?.length || 0;
            console.log(`[RunSemanticQueries] Top memories: ${topCount}; strategy=${result.parameters?.strategy}; format=${result.parameters?.format}`);
            results.push(result as any);
        } catch (err) {
            console.error(`[RunSemanticQueries] Error running query: ${query}`);
            console.error(err);
        }
    }

    // Generate single combined report
    try {
        const filePath = await reportService.generateAndSaveCombinedPostSearchAggregationReport(
            results,
            embeddingModel
        );
        console.log(`[RunSemanticQueries] Combined report saved: ${filePath}`);
    } catch (err) {
        console.error('[RunSemanticQueries] Failed to save combined report:', err);
    }

    console.log('\n[RunSemanticQueries] Completed all queries.');
}

main().catch(err => {
    console.error('[RunSemanticQueries] Fatal error:', err);
    process.exit(1);
});
