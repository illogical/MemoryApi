import fs from 'fs';
import path from 'path';
import { SeedMemoryFile } from '../models/seedMemory';
import { MemoryRAGSystem } from './memoryRAGSystem';
import { Memory } from '../models/memory';
import { MemoryCategory } from '../models/memoryCategory';

export class SeedMemoryLoader {
    constructor(private ragSystem: MemoryRAGSystem) {}

    async loadSeedMemories(jsonFilePath: string): Promise<void> {
        try {
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
                    Tags: seed.tags || [],
                    LastUpdated: new Date().toISOString()
                };
                try {
                    await this.ragSystem.addMemory(memory);
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
}
