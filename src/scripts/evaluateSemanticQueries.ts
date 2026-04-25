/*
    Purpose: Run semantic search queries from a JSON file against the Memory RAG system,
    with dual vector+graph search, summarize results, and generate comprehensive effectiveness reports.
    
    This script optimizes model loading by:
    1. Loading the embedding model once
    2. Embedding and searching all queries with both vector and graph modalities
    3. Loading the LLM model once
    4. Running post-search aggregation on all results
    5. Optionally comparing multiple merge strategies

    Usages:
    npx tsx src/scripts/evaluateSemanticQueries.ts --model=phi-4 --provider=lmstudio
    npx tsx src/scripts/evaluateSemanticQueries.ts --queries=src/samples/semanticSearchQueries.json --strategy=hybrid --format=both --limit=12
    npx tsx src/scripts/evaluateSemanticQueries.ts --compare-strategies --report-format=html
    
    New Features:
    - Dual vector+graph search for all queries
    - Comparison mode: tests multiple merge strategies (vector-only, graph-only, 50-50, 70-30, 30-70)
    - Metrics: overlap analysis, diversity scores, source distribution
    - Enhanced reports with comparative insights
*/

import path from 'path';
import fs from 'fs';
import { config } from '../services/configService';
import { assertTestEnvironment } from '../services/memoryEnvironmentService';
import { MemoryRAGSystem } from '../services/memoryRAGSystem';

assertTestEnvironment('evaluateSemanticQueries');
import { MemoryReportService } from '../services/memoryReportService';

// Load environment variables
async function main() {
    // Instantiate RAG system and report service
    const rag = new MemoryRAGSystem();
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

    // Check for comparison mode flag
    const compareStrategiesFlag = args.includes('--compare-strategies');

    interface MergeStrategy {
        name: string;
        description: string;
        vectorWeight: number;
        graphWeight: number;
    }

    const mergeStrategies: MergeStrategy[] = compareStrategiesFlag ? [
        { name: 'vector-only', description: 'Vector search only (semantic)', vectorWeight: 1.0, graphWeight: 0.0 },
        { name: 'graph-only', description: 'Graph search only (relationships)', vectorWeight: 0.0, graphWeight: 1.0 },
        { name: 'balanced', description: 'Equal weight (50-50)', vectorWeight: 0.5, graphWeight: 0.5 },
        { name: 'semantic-heavy', description: 'Favor semantic (70-30)', vectorWeight: 0.7, graphWeight: 0.3 },
        { name: 'relationship-heavy', description: 'Favor relationships (30-70)', vectorWeight: 0.3, graphWeight: 0.7 }
    ] : [
        { name: 'default', description: 'Default strategy (50-50)', vectorWeight: 0.5, graphWeight: 0.5 }
    ];

    console.log(`\n[RunSemanticQueries] Testing ${mergeStrategies.length} merge ${compareStrategiesFlag ? 'strategies' : 'strategy'}`);

    // ====================================
    // PHASE 1: Load embedding model and run dual vector+graph searches
    // ====================================
    console.log('\n[RunSemanticQueries] Phase 1: Loading embedding model and running dual searches...');

    interface DualSearchResult {
        query: string;
        vectorResults: any[];
        graphResults: any[];
        mergedOptions: any;
        metrics: {
            vectorCount: number;
            graphCount: number;
            overlap: number;
            vectorOnlyCount: number;
            graphOnlyCount: number;
        };
    }

    const searchResults: DualSearchResult[] = [];

    for (let i = 0; i < queries.length; i++) {
        const { query, options } = queries[i];
        const mergedOptions = {
            ...(options || {}),
            ...(strategyArg ? { strategy: strategyArg.split('=')[1] } : {}),
            ...(formatArg ? { format: formatArg.split('=')[1] } : {}),
            ...(limitArg ? { limit: Number(limitArg.split('=')[1]) } : {})
        };

        console.log(`\n[${i + 1}/${queries.length}] Dual search: ${query}`);
        try {
            // Generate embedding for the query
            const queryEmbedding = await rag.generateEmbedding(query);
            const limit = mergedOptions.limit ?? 10;

            // Use the new dual search from orchestrator
            const { vectorResults, graphResults } = await (rag as any)['orchestrator'].searchVectorAndGraphParallel(
                queryEmbedding,
                mergedOptions.category,
                limit * 2
            );

            // Calculate overlap metrics
            const vectorIds = new Set(vectorResults.map((m: any) => m.id));
            const graphIds = new Set(graphResults.map((m: any) => m.id));
            const overlap = vectorResults.filter((m: any) => graphIds.has(m.id)).length;
            const vectorOnlyCount = vectorResults.filter((m: any) => !graphIds.has(m.id)).length;
            const graphOnlyCount = graphResults.filter((m: any) => !vectorIds.has(m.id)).length;

            const metrics = {
                vectorCount: vectorResults.length,
                graphCount: graphResults.length,
                overlap,
                vectorOnlyCount,
                graphOnlyCount
            };

            const overlapPct = metrics.vectorCount > 0 ? (overlap / metrics.vectorCount * 100).toFixed(1) : '0.0';
            console.log(`  Vector: ${metrics.vectorCount}, Graph: ${metrics.graphCount}, Overlap: ${overlap} (${overlapPct}%)`);
            
            searchResults.push({ 
                query, 
                vectorResults, 
                graphResults, 
                mergedOptions,
                metrics 
            });
        } catch (err) {
            console.error(`[RunSemanticQueries] Error searching query: ${query}`);
            console.error(err);
        }
    }

    // Helper function for custom merge with different weight strategies
    function applyCustomMerge(
        vectorResults: any[], 
        graphResults: any[], 
        vectorWeight: number, 
        graphWeight: number,
        limit: number,
        scoreThreshold: number
    ): any[] {
        const memoryMap = new Map<string, any>();

        // Add vector results
        for (const mem of vectorResults) {
            const score = typeof mem.score === 'number' ? mem.score : 0;
            memoryMap.set(mem.id, {
                ...mem,
                vectorScore: score,
                graphScore: undefined,
                mergedScore: score * vectorWeight,
                sources: ['vector']
            });
        }

        // Merge graph results
        const maxGraphScore = graphResults.length > 0 
            ? Math.max(...graphResults.map((g: any) => (g.score || 0))) 
            : 1;

        for (const graphMem of graphResults) {
            const graphScore = graphMem.score || 0;
            const normalizedGraphScore = graphScore / Math.max(maxGraphScore, 1);

            if (memoryMap.has(graphMem.id)) {
                // Merge with existing
                const existing = memoryMap.get(graphMem.id);
                existing.graphScore = graphScore;
                existing.sources.push('graph');
                existing.mergedScore = (existing.vectorScore * vectorWeight) + (normalizedGraphScore * graphWeight);
            } else {
                // New from graph
                memoryMap.set(graphMem.id, {
                    ...graphMem,
                    vectorScore: undefined,
                    graphScore,
                    mergedScore: normalizedGraphScore * graphWeight,
                    sources: ['graph']
                });
            }
        }

        // Filter, sort, and limit
        return Array.from(memoryMap.values())
            .filter(m => m.mergedScore >= scoreThreshold)
            .sort((a, b) => b.mergedScore - a.mergedScore)
            .slice(0, limit)
            .map(m => ({ ...m, score: m.mergedScore }));
    }

    // ====================================
    // PHASE 2: Load LLM model and run all aggregations with strategy variations
    // ====================================
    console.log('\n[RunSemanticQueries] Phase 2: Loading LLM model and running aggregations...');
    await rag.loadInferenceModel();

    interface StrategyResult {
        strategy: MergeStrategy;
        queryResults: Array<{
            query: string;
            topMemories: any[];
            aggregateNarrative?: string;
            aggregateBullets?: string[];
            clusterSummaries?: any[];
            parameters: any;
            vectorResultCount?: number;
            graphResultCount?: number;
        }>;
    }

    const strategyResults: StrategyResult[] = [];

    for (const strategy of mergeStrategies) {
        console.log(`\n[RunSemanticQueries] === Testing Strategy: ${strategy.name} (${strategy.description}) ===`);
        const queryResults = [];

        for (let i = 0; i < searchResults.length; i++) {
            const { query, vectorResults, graphResults, mergedOptions } = searchResults[i];
            console.log(`\n[${i + 1}/${searchResults.length}] Aggregating with ${strategy.name}: ${query}`);
            
            try {
                // Apply custom merge based on strategy
                const customMergedResults = applyCustomMerge(
                    vectorResults, 
                    graphResults, 
                    strategy.vectorWeight, 
                    strategy.graphWeight,
                    mergedOptions.limit ?? 10,
                    mergedOptions.scoreThreshold ?? 0.7
                );

                // Run aggregation on custom-merged memories
                const result = await rag.aggregateSearchResults(query, customMergedResults, mergedOptions);
                
                const topCount = result.topMemories?.length || 0;
                console.log(`  Top memories: ${topCount}; strategy=${result.parameters?.strategy}; format=${result.parameters?.format}`);
                
                queryResults.push({
                    ...result as any,
                    vectorResultCount: vectorResults.length,
                    graphResultCount: graphResults.length
                });
            } catch (err) {
                console.error(`  Error aggregating query: ${query}`);
                console.error(err);
            }
        }

        strategyResults.push({ strategy, queryResults });
    }

    const reportFormatArg = args.find(a => a.startsWith('--report-format='));
    const reportFormat = reportFormatArg ? reportFormatArg.split('=')[1] as 'html' | 'markdown' : 'markdown';

    // Helper function to generate comparison report
    function generateComparisonReport(strategyResults: StrategyResult[], searchResults: DualSearchResult[]): string {
        let report = '# Semantic Query Evaluation - Strategy Comparison\n\n';
        report += `**Generated:** ${new Date().toISOString()}\n\n`;
        report += `**Queries Evaluated:** ${searchResults.length}\n`;
        report += `**Strategies Tested:** ${strategyResults.length}\n\n`;

        // Overall metrics
        report += '## Overall Metrics\n\n';
        report += '| Metric | Value |\n';
        report += '|--------|-------|\n';
        
        const avgVectorCount = searchResults.reduce((sum, r) => sum + r.metrics.vectorCount, 0) / searchResults.length;
        const avgGraphCount = searchResults.reduce((sum, r) => sum + r.metrics.graphCount, 0) / searchResults.length;
        const avgOverlap = searchResults.reduce((sum, r) => sum + r.metrics.overlap, 0) / searchResults.length;
        
        report += `| Avg Vector Results | ${avgVectorCount.toFixed(1)} |\n`;
        report += `| Avg Graph Results | ${avgGraphCount.toFixed(1)} |\n`;
        report += `| Avg Overlap | ${avgOverlap.toFixed(1)} (${(avgOverlap/Math.max(avgVectorCount,1)*100).toFixed(1)}%) |\n\n`;

        // Strategy comparison table
        report += '## Strategy Performance\n\n';
        report += '| Strategy | Description | Avg Results | Avg Sources |\n';
        report += '|----------|-------------|-------------|-------------|\n';
        
        for (const stratResult of strategyResults) {
            const avgResultCount = stratResult.queryResults.reduce((sum, r) => sum + r.topMemories.length, 0) / stratResult.queryResults.length;
            
            // Calculate source distribution
            const sourceCounts = { vector: 0, graph: 0, both: 0 };
            stratResult.queryResults.forEach(qr => {
                qr.topMemories.forEach((mem: any) => {
                    if (mem.sources) {
                        if (mem.sources.length > 1) sourceCounts.both++;
                        else if (mem.sources[0] === 'vector') sourceCounts.vector++;
                        else if (mem.sources[0] === 'graph') sourceCounts.graph++;
                    }
                });
            });
            
            const totalSources = sourceCounts.vector + sourceCounts.graph + sourceCounts.both;
            const distribution = totalSources > 0 
                ? `V:${((sourceCounts.vector/totalSources)*100).toFixed(0)}% G:${((sourceCounts.graph/totalSources)*100).toFixed(0)}% Both:${((sourceCounts.both/totalSources)*100).toFixed(0)}%`
                : 'N/A';
            
            report += `| ${stratResult.strategy.name} | ${stratResult.strategy.description} | ${avgResultCount.toFixed(1)} | ${distribution} |\n`;
        }
        report += '\n';

        // Per-query breakdown
        report += '## Per-Query Results\n\n';
        for (let i = 0; i < searchResults.length; i++) {
            const searchResult = searchResults[i];
            report += `### Query ${i + 1}: "${searchResult.query}"\n\n`;
            report += `**Metrics:** Vector=${searchResult.metrics.vectorCount}, Graph=${searchResult.metrics.graphCount}, Overlap=${searchResult.metrics.overlap}\n\n`;
            
            report += '| Strategy | Results | Top Memory IDs |\n';
            report += '|----------|---------|----------------|\n';
            
            for (const stratResult of strategyResults) {
                const qr = stratResult.queryResults[i];
                const topIds = qr.topMemories.slice(0, 5).map((m: any) => m.id.substring(0, 8)).join(', ');
                report += `| ${stratResult.strategy.name} | ${qr.topMemories.length} | ${topIds} |\n`;
            }
            report += '\n';
        }

        return report;
    }

    // Generate reports based on mode
    if (compareStrategiesFlag) {
        // Generate comparative report across all strategies
        try {
            const comparisonReport = generateComparisonReport(strategyResults, searchResults);
            const reportPath = path.join('reports', `semantic-queries-comparison-${Date.now()}.md`);
            fs.writeFileSync(reportPath, comparisonReport);
            console.log(`\n[RunSemanticQueries] Comparison report saved: ${reportPath}`);
        } catch (err) {
            console.error('[RunSemanticQueries] Failed to save comparison report:', err);
        }
    } else {
        // Generate standard combined report
        const results = strategyResults[0].queryResults;
        try {
            const filePath = await reportService.generateAndSaveCombinedPostSearchAggregationReport(
                results,
                config.EMBEDDING_MODEL,
                reportFormat
            );
            console.log(`[RunSemanticQueries] Combined report saved: ${filePath}`);
        } catch (err) {
            console.error('[RunSemanticQueries] Failed to save combined report:', err);
        }
    }

    console.log('\n[RunSemanticQueries] Completed all queries.');
}

main().catch(err => {
    console.error('[RunSemanticQueries] Fatal error:', err);
    process.exit(1);
});
