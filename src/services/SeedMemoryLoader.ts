import fs from 'fs';
import path from 'path';
import { SeedMemoryFile, SeedMemory } from '../models/seedMemory';
import { MemoryRAGSystem } from './MemoryRAGSystem';
import { Memory } from '../models/memory';
import { MemoryCategory } from '../models/memoryCategory';

export class SeedMemoryLoader {
    constructor(private ragSystem: MemoryRAGSystem) {}

    async loadSeedMemories(jsonFilePath: string): Promise<void> {
        const absPath = path.isAbsolute(jsonFilePath)
            ? jsonFilePath
            : path.join(process.cwd(), jsonFilePath);
        const raw = fs.readFileSync(absPath, 'utf-8');
        const data: SeedMemoryFile = JSON.parse(raw);
        for (const seed of data.memories) {
            const memory: Memory = {
                Description: seed.description || '',
                Content: seed.content,
                Category: seed.category as MemoryCategory | undefined,
                Tags: seed.tags || [],
                LastUpdated: new Date().toISOString()
            };
            await this.ragSystem.addMemory(memory);
        }
        console.log(`Loaded ${data.memories.length} seed memories from ${jsonFilePath}`);
    }
}
