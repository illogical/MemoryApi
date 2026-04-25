import { MemoryCategory } from "./memoryCategory";
import { MemoryStatus } from "./memoryStatus";

export interface Memory {
    Content: string;
    LastUpdated: string;
    Created?: string;
    Category?: MemoryCategory;
    Description?: string;
    Tags?: string[];
    Status?: MemoryStatus;
    IngestionBatchId?: string;
    UserReviewed?: string; // 'auto' | 'human-confirmed' | 'corrected'
    // Entity fields (set explicitly on seeds; LLM-inferred on live adds)
    Tools?: string[];
    Projects?: string[];
}

export interface MemoryWithId extends Memory {
    id: string;
    score?: number;
}
