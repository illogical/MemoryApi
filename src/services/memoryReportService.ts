import fs from 'fs/promises';
import path from 'path';
import { Memory } from '../models/memory';
import { ReportFormat, ReportFormatter, PostSearchAggregationResult } from './reportFormatters/reportFormatter';
import { MarkdownReportFormatter } from './reportFormatters/markdownReportFormatter';
import { HtmlReportFormatter } from './reportFormatters/htmlReportFormatter';

export interface ProcessedMemory extends Memory {
    summary?: string;
    classification?: string;
    tagsRaw?: string[]; // The raw tags returned by the LLM
    [key: string]: any;
}

export interface ReportStats {
    totalProcessed: number;
    successCount: number;
    durationMs: number;
    timestamp: Date;
    embeddingModel: string;
}

export interface MemoryFeedbackReport {
    categoryCounts: Record<string, number>;
    memoriesByCategory: Record<string, any[]>;
    semanticSearches: Array<{ query: string; results: any[] }>;
    tagSearches: Array<{ tags: string[]; results: any[] }>;
    embeddingModel: string;
    timestamp?: Date;
}

export class MemoryReportService {
    private reportDir: string;

    constructor(reportDir: string = 'reports') {
        this.reportDir = reportDir;
    }

    private getFormatter(format: ReportFormat): ReportFormatter {
        switch (format) {
            case 'html':
                return new HtmlReportFormatter();
            case 'markdown':
            default:
                return new MarkdownReportFormatter();
        }
    }

    async generateAndSaveReport(
        content: string,
        stats: ReportStats,
        reportName: string,
        extension: string
    ): Promise<string> {
        const timestampStr = stats.timestamp.toISOString().replace(/[:.]/g, '-');
        const filename = `${reportName}_${timestampStr}.${extension}`;
        const filePath = path.join(this.reportDir, filename);
        await fs.mkdir(this.reportDir, { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
        return filePath;
    }

    /**
     * Generates a report for memory feedback results (semantic/tag/category queries)
     */
    async generateFeedbackReport(
        feedback: MemoryFeedbackReport,
        format: ReportFormat = 'markdown'
    ): Promise<string> {
        const formatter = this.getFormatter(format);
        const content = formatter.formatFeedbackReport(feedback);

        // Create a dummy stats object for the filename timestamp
        const stats: ReportStats = {
            totalProcessed: 0,
            successCount: 0,
            durationMs: 0,
            timestamp: feedback.timestamp || new Date(),
            embeddingModel: feedback.embeddingModel
        };

        return await this.generateAndSaveReport(content, stats, 'feedback_report', formatter.getFileExtension());
    }

    // Kept for backward compatibility if needed, but now delegates to generateFeedbackReport
    generateFeedbackMarkdown(feedback: MemoryFeedbackReport): string {
        return new MarkdownReportFormatter().formatFeedbackReport(feedback);
    }

    async generateIngestionReport(
        memories: ProcessedMemory[],
        stats: ReportStats,
        format: ReportFormat = 'markdown'
    ): Promise<string> {
        const formatter = this.getFormatter(format);
        const content = formatter.formatIngestionReport(memories, stats);
        return await this.generateAndSaveReport(content, stats, 'ingestion_report', formatter.getFileExtension());
    }

    // Kept for backward compatibility
    generateIgenestionMarkdown(memories: ProcessedMemory[], stats: ReportStats): string {
        return new MarkdownReportFormatter().formatIngestionReport(memories, stats);
    }

    /**
     * Generates a report for post-search aggregation output.
     */
    async generatePostSearchAggregationReport(
        result: PostSearchAggregationResult,
        format: ReportFormat = 'markdown'
    ): Promise<string> {
        const formatter = this.getFormatter(format);
        const content = formatter.formatPostSearchAggregationReport(result);

        const stats: ReportStats = {
            totalProcessed: result.topMemories?.length || 0,
            successCount: result.topMemories?.length || 0,
            durationMs: 0,
            timestamp: new Date(),
            embeddingModel: 'unknown' // or pass it in if available
        };

        return await this.generateAndSaveReport(content, stats, 'post_search_aggregation', formatter.getFileExtension());
    }

    // Kept for backward compatibility
    generatePostSearchAggregationMarkdown(result: PostSearchAggregationResult): string {
        return new MarkdownReportFormatter().formatPostSearchAggregationReport(result);
    }

    /**
     * Convenience: Generate and save a post-search aggregation report.
     */
    async generateAndSavePostSearchAggregationReport(
        result: PostSearchAggregationResult,
        embeddingModel: string = 'unknown',
        format: ReportFormat = 'markdown'
    ): Promise<string> {
        const formatter = this.getFormatter(format);
        const content = formatter.formatPostSearchAggregationReport(result);
        const stats: ReportStats = {
            totalProcessed: result.topMemories?.length || 0,
            successCount: result.topMemories?.length || 0,
            durationMs: 0,
            timestamp: new Date(),
            embeddingModel
        };
        return await this.generateAndSaveReport(content, stats, 'post_search_aggregation', formatter.getFileExtension());
    }

    /**
     * Generates and saves a combined post-search aggregation report for multiple queries.
     */
    async generateAndSaveCombinedPostSearchAggregationReport(
        results: PostSearchAggregationResult[],
        embeddingModel: string = 'unknown',
        format: ReportFormat = 'markdown'
    ): Promise<string> {
        const formatter = this.getFormatter(format);
        const content = formatter.formatCombinedPostSearchAggregationReport(results);

        const stats: ReportStats = {
            totalProcessed: results.reduce((sum, r) => sum + (r.topMemories?.length || 0), 0),
            successCount: results.length,
            durationMs: 0,
            timestamp: new Date(),
            embeddingModel
        };

        return await this.generateAndSaveReport(content, stats, 'combined_post_search_aggregation', formatter.getFileExtension());
    }
}
