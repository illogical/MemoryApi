export interface SeedMemory {
    content: string;
    description?: string;
    category?: string;
    tags?: string[];
}

export interface SeedMemoryFile {
    memories: SeedMemory[];
}
