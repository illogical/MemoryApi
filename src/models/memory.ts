import { MemoryCategory } from "./memoryCategory";
import { MemoryStatus } from "./memoryStatus";
import { MemorySourceType } from "./memorySourceType";
import { MemoryDurability } from "./memoryDurability";
import { MemoryDataset } from "./memoryDataset";

export interface Memory {
    Content: string;
    LastUpdated: string;
    Category?: MemoryCategory;
    Description?: string;
    Tags?: string[];
    Status?: MemoryStatus;
    // Ingestion metadata
    SourceType?: MemorySourceType;
    Durability?: MemoryDurability;
    Dataset?: MemoryDataset;
    IngestionBatchId?: string;
    UserReviewed?: string; // 'auto' | 'human-confirmed' | 'corrected'
    // Entity fields (set explicitly on seeds; LLM-inferred on live adds)
    Tools?: string[];
    Projects?: string[];
    Topics?: string[];
}

export interface MemoryWithId extends Memory {
    id: string;
    score?: number;
}