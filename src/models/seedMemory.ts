export interface SeedMemory {
    content: string;
    description?: string;
    category?: string;
    tags?: string[];
    // Explicit metadata (overrides inference; used as eval ground truth)
    sourceType?: string;
    durability?: string;
    dataset?: string;
    tools?: string[];
    projects?: string[];
    topics?: string[];
    // Eval fixture fields
    isRealUserMemory?: boolean;
    isEvalFixture?: boolean;
    expectedUseCase?: string;
    shouldBeDiscoverableBy?: string[];
}

export interface SeedMemoryFile {
    memories: SeedMemory[];
}
