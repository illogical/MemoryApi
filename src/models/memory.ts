import { MemoryCategory } from "./memoryCategory";

export interface Memory {
    Content: string;
    LastUpdated: string;
    Category?: MemoryCategory;
    Description?: string;
    Tags?: string[];
}

export interface MemoryWithId extends Memory {
    id: string;
}