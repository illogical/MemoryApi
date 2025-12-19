import { config } from 'dotenv';
config();
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { MemoryCategory } from '../models/memoryCategory';
import path from 'path';
import { FeedbackQueryLoader } from '../helpers/FeedbackQueryLoader';
import { MemoryReportService, ReportStats } from '../services/memoryReportService';

async function main() {
    const qdrantUrl = process.env.QDRANT_URL;
    const embeddingModel = process.env.EMBEDDING_MODEL;
    const modelName = process.env.LLM_MODEL || 'llama-3.2-3b-instruct';
    const provider = process.env.LLM_PROVIDER || 'lmstudio';
    if (!qdrantUrl || !embeddingModel) {
        console.error('Missing QDRANT_URL or EMBEDDING_MODEL in environment variables.');
        process.exit(1);
    }
    const ragSystem = new MemoryRAGSystem(qdrantUrl, modelName, provider, embeddingModel);
    await ragSystem.loadEmbeddingModel();

    // Load feedback queries from JSON file
    // Find the first argument that doesn't start with --
    const feedbackQueriesArg = process.argv.slice(2).find(arg => !arg.startsWith('--'));
    const feedbackQueriesPath = feedbackQueriesArg
        ? path.resolve(feedbackQueriesArg)
        : path.resolve('src/samples/feedbackQueries.json');
    let feedbackQueries;
    try {
        feedbackQueries = FeedbackQueryLoader.load(feedbackQueriesPath);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }

    const startTime = Date.now();

    // 1. Get category counts
    const categoryCounts = await ragSystem.getCategoryCounts();

    // 2. List memories by category (showing first 3 for each)
    const memoriesByCategory: Record<string, any[]> = {};
    for (const category of Object.values(MemoryCategory)) {
        const memories = await ragSystem.getMemoriesByCategory(category as MemoryCategory, 3);
        memoriesByCategory[category] = memories;
    }

    // 3. Semantic search examples (from JSON)
    const semanticSearches: Array<{ query: string; results: any[] }> = [];
    for (const query of feedbackQueries.semanticQueries) {
        const results = await ragSystem.searchMemories(query, undefined, 2);
        semanticSearches.push({ query, results });
    }

    // 4. Tag-based search examples (from JSON)
    const tagSearches: Array<{ tags: string[]; results: any[] }> = [];
    for (const tags of feedbackQueries.tagSearches) {
        const results = await ragSystem.searchByTags(tags);
        tagSearches.push({ tags, results });
    }

    // Generate feedback report
    const reportService = new MemoryReportService();
    const reportStats: ReportStats = {
        totalProcessed: semanticSearches.length + tagSearches.length,
        successCount: semanticSearches.reduce((acc, s) => acc + s.results.length, 0) + tagSearches.reduce((acc, t) => acc + t.results.length, 0),
        durationMs: Date.now() - startTime,
        timestamp: new Date(),
        embeddingModel: embeddingModel
    };
    // Parse report format from args
    const reportFormatArg = process.argv.find(arg => arg.startsWith('--report-format='));
    const reportFormat = reportFormatArg ? reportFormatArg.split('=')[1] as 'html' | 'markdown' : 'markdown';

    const reportPath = await reportService.generateFeedbackReport({
        categoryCounts,
        memoriesByCategory,
        semanticSearches,
        tagSearches,
        embeddingModel,
        timestamp: reportStats.timestamp
    }, reportFormat);
    console.log(`Feedback report generated at: ${reportPath}`);
}

main().catch((err) => {
    console.error('Error running memory feedback script:', err);
    process.exit(1);
});
