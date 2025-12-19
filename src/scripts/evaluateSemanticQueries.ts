/*
    Purpose: Run semantic search queries from a JSON file against the Memory RAG system,
    summarize results, and generate a combined effectiveness report.
    
    This script optimizes model loading by:
    1. Loading the embedding model once
    2. Embedding and searching all queries
    3. Loading the LLM model once
    4. Running post-search aggregation on all results

    Usages:
    npx tsx src/scripts/evaluateSemanticQueries.ts --model=phi-4 --provider=lmstudio
    npx tsx src/scripts/evaluateSemanticQueries.ts --queries=src/samples/semanticSearchQueries.json --strategy=hybrid --format=both --limit=12
*/

import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { MemoryReportService } from '../services/memoryReportService';

// Load environment variables
dotenv.config();

async function main() {
    const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
    const embeddingModel = process.env.EMBEDDING_MODEL || 'nomic-embed-text-v1.5';
    const modelName = process.env.LLM_MODEL || 'llama-3.2-3b-instruct';
    const provider = process.env.LLM_PROVIDER || 'lmstudio';

    // Instantiate RAG system and report service
    const rag = new MemoryRAGSystem(qdrantUrl, modelName, provider, embeddingModel);
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

    // ====================================
    // PHASE 1: Load embedding model and run all searches
    // ====================================
    console.log('\n[RunSemanticQueries] Phase 1: Loading embedding model and running searches...');

    interface SearchResult {
        query: string;
        memories: any[];
        mergedOptions: any;
    }

    const searchResults: SearchResult[] = [];

    for (let i = 0; i < queries.length; i++) {
        const { query, options } = queries[i];
        const mergedOptions = {
            ...(options || {}),
            ...(strategyArg ? { strategy: strategyArg.split('=')[1] } : {}),
            ...(formatArg ? { format: formatArg.split('=')[1] } : {}),
            ...(limitArg ? { limit: Number(limitArg.split('=')[1]) } : {})
        };

        console.log(`\n[${i + 1}/${queries.length}] Embedding and searching: ${query}`);
        try {
            // Generate embedding for the query
            const queryEmbedding = await rag.generateEmbedding(query);

            // Search with pre-computed embedding (no need to reload embedding model)
            const limit = mergedOptions.limit ?? 10;
            const memories = await rag.searchMemoriesWithEmbedding(
                queryEmbedding,
                mergedOptions.category,
                limit * 2  // Get more results for filtering
            );

            console.log(`[RunSemanticQueries] Found ${memories.length} memories for query: ${query}`);
            searchResults.push({ query, memories, mergedOptions });
        } catch (err) {
            console.error(`[RunSemanticQueries] Error searching query: ${query}`);
            console.error(err);
        }
    }

    // ====================================
    // PHASE 2: Load LLM model and run all aggregations
    // ====================================
    console.log('\n[RunSemanticQueries] Phase 2: Loading LLM model and running aggregations...');
    await rag.loadInferenceModel();

    const results: Array<{
        query: string;
        topMemories: any[];
        aggregateNarrative?: string;
        aggregateBullets?: string[];
        clusterSummaries?: Array<{ key: string; type: 'category' | 'tag'; narrative?: string; bullets?: string[] }>;
        parameters: any;
    }> = [];

    for (let i = 0; i < searchResults.length; i++) {
        const { query, memories, mergedOptions } = searchResults[i];
        console.log(`\n[${i + 1}/${searchResults.length}] Aggregating results for: ${query}`);
        try {
            // Run aggregation on pre-fetched memories (LLM already loaded)
            const result = await rag.aggregateSearchResults(query, memories, mergedOptions);
            const topCount = result.topMemories?.length || 0;
            console.log(`[RunSemanticQueries] Top memories: ${topCount}; strategy=${result.parameters?.strategy}; format=${result.parameters?.format}`);
            results.push(result as any);
        } catch (err) {
            console.error(`[RunSemanticQueries] Error aggregating query: ${query}`);
            console.error(err);
        }
    }

    const reportFormatArg = args.find(a => a.startsWith('--report-format='));
    const reportFormat = reportFormatArg ? reportFormatArg.split('=')[1] as 'html' | 'markdown' : 'markdown';

    // Generate single combined report
    try {
        const filePath = await reportService.generateAndSaveCombinedPostSearchAggregationReport(
            results,
            embeddingModel,
            reportFormat
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
