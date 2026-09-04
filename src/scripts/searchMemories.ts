import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { MemoryCategory } from '../models/memoryCategory';

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error('Usage: npm run search-memories -- "Query here" [--category=SpecificCategory] [--limit=5]');
        process.exit(1);
    }

    let query = '';
    let category: MemoryCategory | undefined;
    let limit = 5;

    // First argument is query
    if (!args[0].startsWith('--')) {
        query = args[0];
    } else {
        console.error('First argument must be the query.');
        process.exit(1);
    }

    // Parse options
    for (const arg of args.slice(1)) {
        if (arg.startsWith('--category=')) {
            const val = arg.split('=')[1];
            if (Object.values(MemoryCategory).includes(val as MemoryCategory)) {
                category = val as MemoryCategory;
            }
        } else if (arg.startsWith('--limit=')) {
            const val = parseInt(arg.split('=')[1], 10);
            if (!isNaN(val)) {
                limit = val;
            }
        }
    }

    const ragSystem = new MemoryRAGSystem();

    try {
        await ragSystem.initializeForSearch();

        console.log(`Searching for: "${query}" (Limit: ${limit}${category ? `, Category: ${category}` : ''})`);
        const results = await ragSystem.searchMemories(query, category, limit);

        if (results.length === 0) {
            console.log('No matching memories found.');
        } else {
            console.log(`Found ${results.length} results:\n`);
            results.forEach((mem, index) => {
                console.log(`#${index + 1} [Score: ${mem.score?.toFixed(4)}]`);
                console.log(`Content: ${mem.Content}`);
                console.log(`Category: ${mem.Category}`);
                console.log(`Description: ${mem.Description}`);
                console.log(`Tags: ${mem.Tags?.join(', ')}`);
                console.log('');
            });
        }

    } catch (error) {
        console.error('Error searching memories:', error);
        process.exit(1);
    }
}

main();
