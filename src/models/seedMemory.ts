export type SeedMemory = {
    content: string;
    description?: string;
    category?: string;
    tags?: string[];
};

export type SeedMemoryFile = {
    memories: SeedMemory[];
};
