import { ProcessedMemory, ReportStats, MemoryFeedbackReport } from '../memoryReportService';

export type ReportFormat = 'markdown' | 'html';

export interface PostSearchAggregationResult {
    query: string;
    topMemories: Array<{
        id: string;
        Description?: string;
        Category?: string;
        Tags?: string[];
        LastUpdated?: string;
        score?: number;
        [key: string]: any;
    }>;
    aggregateNarrative?: string;
    aggregateBullets?: string[];
    clusterSummaries?: Array<{
        key: string;
        type: 'category' | 'tag';
        narrative?: string;
        bullets?: string[];
    }>;
    parameters: any;
}

export interface ReportFormatter {
    formatFeedbackReport(feedback: MemoryFeedbackReport): string;
    formatIngestionReport(memories: ProcessedMemory[], stats: ReportStats): string;
    formatPostSearchAggregationReport(result: PostSearchAggregationResult): string;
    formatCombinedPostSearchAggregationReport(results: PostSearchAggregationResult[]): string;
    getFileExtension(): string;
}
