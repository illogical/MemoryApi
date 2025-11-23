import { config } from 'dotenv';
config();
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { MemoryCategory } from '../models/memoryCategory';
import path from 'path';
import { FeedbackQueryLoader } from '../helpers/FeedbackQueryLoader';

async function main() {
    const qdrantUrl = process.env.QDRANT_URL;
    const embeddingModel = process.env.EMBEDDING_MODEL;
    if (!qdrantUrl || !embeddingModel) {
        console.error('Missing QDRANT_URL or EMBEDDING_MODEL in environment variables.');
        process.exit(1);
    }
    const ragSystem = new MemoryRAGSystem(qdrantUrl, embeddingModel);

    // Load feedback queries from JSON file
    const feedbackQueriesArg = process.argv[2];
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

    // 1. Get category counts
    const categoryCounts = await ragSystem.getCategoryCounts();
    console.log('Memory counts by category:', categoryCounts);

    // 2. List memories by category (showing first 3 for each)
    for (const category of Object.values(MemoryCategory)) {
        const memories = await ragSystem.getMemoriesByCategory(category as MemoryCategory, 3);
        console.log(`\nMemories in category '${category}':`);
        memories.forEach(m => {
            console.log(`- ID: ${m.id}, Description: ${m.Description}, Tags: ${m.Tags?.join(', ')}`);
        });
    }

    // 3. Semantic search examples (from JSON)
    for (const query of feedbackQueries.semanticQueries) {
        const results = await ragSystem.searchMemories(query, undefined, 2);
        console.log(`\nSemantic search for "${query}":`);
        results.forEach(m => {
            console.log(`- ID: ${m.id}, Description: ${m.Description}, Category: ${m.Category}, Tags: ${m.Tags?.join(', ')}`);
        });
    }

    // 4. Tag-based search examples (from JSON)
    for (const tags of feedbackQueries.tagSearches) {
        const results = await ragSystem.searchByTags(tags);
        console.log(`\nTag search for [${tags.join(', ')}]:`);
        results.slice(0, 3).forEach(m => {
            console.log(`- ID: ${m.id}, Description: ${m.Description}, Category: ${m.Category}, Tags: ${m.Tags?.join(', ')}`);
        });
    }
}

main().catch((err) => {
    console.error('Error running memory feedback script:', err);
    process.exit(1);
});
