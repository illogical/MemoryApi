import { MemorySourceType } from './memorySourceType';
import { MemoryDataset } from './memoryDataset';

export interface IngestionContext {
    batchId: string;
    sourceType: MemorySourceType;
    dataset: MemoryDataset;
}
