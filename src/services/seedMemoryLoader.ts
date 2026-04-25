import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { SeedMemory, SeedMemoryFile } from '../models/seedMemory';
import { MemoryRAGSystem } from './memoryRAGSystem';
import { Memory } from '../models/memory';
import { MemoryCategory } from '../models/memoryCategory';
import { normalizeTags } from '../utils/normalization';



export class SeedMemoryLoader {
        /**
         * Loads and parses the seed memories JSON file into Memory objects.
         */
        public async loadSeedMemoriesToMemoryObjects(jsonFilePath: string): Promise<Memory[]> {
            const absPath = path.isAbsolute(jsonFilePath)
                ? jsonFilePath
                : path.join(process.cwd(), jsonFilePath);
            let raw: string;
            try {
                raw = fs.readFileSync(absPath, 'utf-8');
            } catch (fileErr) {
                throw new Error(`Error reading file at ${absPath}: ${fileErr}`);
            }
            let data: SeedMemoryFile;
            try {
                data = JSON.parse(raw);
            } catch (jsonErr) {
                throw new Error(`Error parsing JSON from file at ${absPath}: ${jsonErr}`);
            }
            return data.memories.map(seed => ({
                Description: seed.description || '',
                Content: seed.content,
                Category: seed.category as MemoryCategory | undefined,
                Tags: normalizeTags(seed.tags || []),
                LastUpdated: new Date().toISOString(),
                Tools: seed.tools,
                Projects: seed.projects
            }));
        }

    public async loadSeedMemoriesToDatabases(jsonFilePath: string, ragSystem: MemoryRAGSystem): Promise<void> {
        try {
            // Ensure the collection exists before loading seed memories
            await ragSystem.initializeCollection();

            const absPath = path.isAbsolute(jsonFilePath)
                ? jsonFilePath
                : path.join(process.cwd(), jsonFilePath);
            let raw: string;
            try {
                raw = fs.readFileSync(absPath, 'utf-8');
            } catch (fileErr) {
                console.error(`Error reading file at ${absPath}:`, fileErr);
                return;
            }
            let data: SeedMemoryFile;
            try {
                data = JSON.parse(raw);
            } catch (jsonErr) {
                console.error(`Error parsing JSON from file at ${absPath}:`, jsonErr);
                return;
            }
            let loadedCount = 0;
            for (const seed of data.memories) {
                const memory: Memory = {
                    Description: seed.description || '',
                    Content: seed.content,
                    Category: seed.category as MemoryCategory | undefined,
                    Tags: normalizeTags(seed.tags || []),
                    LastUpdated: new Date().toISOString(),
                    Tools: seed.tools,
                    Projects: seed.projects
                };
                try {
                    await ragSystem.addMemory(memory);
                    loadedCount++;
                } catch (addErr) {
                    console.error(`Error adding memory:`, addErr, memory);
                }
            }
            console.log(`Loaded ${loadedCount} seed memories from ${jsonFilePath}`);
        } catch (err) {
            console.error('Unexpected error in loadSeedMemories:', err);
        }
    }

    /**
     * Append a single seed memory to the seedMemories.json file.
     */
    public async appendSeedMemory(seedMemory: SeedMemory, jsonFilePath: string): Promise<void> {
        const absPath = path.isAbsolute(jsonFilePath)
            ? jsonFilePath
            : path.join(process.cwd(), jsonFilePath);

        const fileContent = await fsp.readFile(absPath, 'utf-8');
        const data = JSON.parse(fileContent) as SeedMemoryFile;

        if (!Array.isArray(data.memories)) {
            data.memories = [];
        }

        data.memories.push({
            content: seedMemory.content,
            description: seedMemory.description || '',
            category: seedMemory.category,
            tags: Array.isArray(seedMemory.tags) ? seedMemory.tags : []
        });

        await fsp.writeFile(absPath, JSON.stringify(data, null, 2), 'utf-8');
    }
}
