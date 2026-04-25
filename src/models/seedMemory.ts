export interface SeedMemory {
    content: string;
    description?: string;
    category?: string;
    tags?: string[];
    tools?: string[];
    projects?: string[];
}

export interface SeedMemoryFile {
    memories: SeedMemory[];
}
