import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { Memory } from '../models/memory';
import { MemoryCategory } from '../models/memoryCategory';

async function main() {
    const args = process.argv.slice(2);
    if (args.length === 0) {
        console.error('Usage: npm run add-memory -- "Memory content here" [--category=SpecificCategory]');
        process.exit(1);
    }

    // Basic arg parsing
    let content = '';
    let category: MemoryCategory | undefined;

    // First argument is assumed to be content if it doesn't start with --
    if (!args[0].startsWith('--')) {
        content = args[0];
    } else {
        console.error('First argument must be the memory content.');
        process.exit(1);
    }

    // Parse options
    for (const arg of args.slice(1)) {
        if (arg.startsWith('--category=')) {
            const val = arg.split('=')[1];
            if (Object.values(MemoryCategory).includes(val as MemoryCategory)) {
                category = val as MemoryCategory;
            } else {
                console.warn(`Invalid category: ${val}. Allowing auto-classification.`);
            }
        }
    }

    const ragSystem = new MemoryRAGSystem();

    console.log('Initializing system...');
    try {
        await ragSystem.initializeCollection();
        await ragSystem.loadInferenceModel();

        const memory: Memory = {
            Content: content,
            Category: category,
            LastUpdated: new Date().toISOString()
        };

        console.log('Adding memory...');
        const id = await ragSystem.addMemory(memory);
        console.log(`Successfully added memory with ID: ${id}`);

        // Fetch it back to show what was inferred
        const added = await ragSystem.getMemoryById(id);
        if (added) {
            console.log('\n--- Added Memory Details ---');
            console.log(`ID: ${added.id}`);
            console.log(`Content: ${added.Content}`);
            console.log(`Category: ${added.Category} (Inferred/Provided)`);
            console.log(`Tags: ${added.Tags?.join(', ')}`);
            console.log(`Description: ${added.Description}`);
            console.log('----------------------------');
        }

    } catch (error) {
        console.error('Error adding memory:', error);
        process.exit(1);
    }
}

main();
