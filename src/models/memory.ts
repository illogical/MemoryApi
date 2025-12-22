import { MemoryCategory } from "./memoryCategory";
import { MemoryStatus } from "./memoryStatus";

export interface Memory {
    Content: string;
    LastUpdated: string;
    Category?: MemoryCategory;
    Description?: string;
    Tags?: string[];
    Status?: MemoryStatus
}

export interface MemoryWithId extends Memory {
    id: string;
    score?: number;
}