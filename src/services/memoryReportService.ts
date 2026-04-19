import fs from 'fs/promises';
import path from 'path';
import { Memory } from '../models/memory';
import { ReportFormat, ReportFormatter, PostSearchAggregationResult } from './reportFormatters/reportFormatter';
import { MarkdownReportFormatter } from './reportFormatters/markdownReportFormatter';
import { HtmlReportFormatter } from './reportFormatters/htmlReportFormatter';
import { VectorService } from './vectorService';
import { GraphService } from './graphService';
import { SqlService } from './sqlService';

export interface IngestionVerificationReport {
    timestamp: string;
    qdrantCount: number;
    neo4jMemoryCount: number;
    neo4jRelationshipCount: number;
    sqliteMemoryCount: number;
    categoryDistribution: Record<string, number>;
    tagFrequency: Record<string, number>;
    storeCountsMatch: boolean;
    warnings: string[];
}

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

    /**
     * Queries all three stores and compiles a cross-store verification report.
     * Prints the summary to the console and returns the structured report.
     */
    async generateVerificationReport(
        vectorService: VectorService,
        graphService: GraphService,
        sqlService: SqlService
    ): Promise<IngestionVerificationReport> {
        const timestamp = new Date().toISOString();
        const warnings: string[] = [];

        const [qdrantCount, neo4jMemoryCount, neo4jRelationshipCount, sqliteMemoryCount, categoryDistribution, tagFrequency] =
            await Promise.all([
                vectorService.getRecordCount().catch(err => { warnings.push(`Qdrant count error: ${err}`); return -1; }),
                graphService.getMemoryCount().catch(err => { warnings.push(`Neo4j memory count error: ${err}`); return -1; }),
                graphService.getRelationshipCount().catch(err => { warnings.push(`Neo4j relationship count error: ${err}`); return -1; }),
                sqlService.getMemoryCount().catch(err => { warnings.push(`SQLite count error: ${err}`); return -1; }),
                vectorService.getCategoryCounts().catch(err => { warnings.push(`Category distribution error: ${err}`); return {} as Record<string, number>; }),
                vectorService.getTagFrequency().catch(err => { warnings.push(`Tag frequency error: ${err}`); return {} as Record<string, number>; })
            ]);

        const storeCountsMatch = qdrantCount >= 0 && neo4jMemoryCount >= 0 && sqliteMemoryCount >= 0
            && qdrantCount === neo4jMemoryCount
            && qdrantCount === sqliteMemoryCount;

        if (!storeCountsMatch) {
            warnings.push(
                `Store count mismatch — Qdrant: ${qdrantCount}, Neo4j: ${neo4jMemoryCount}, SQLite: ${sqliteMemoryCount}`
            );
        }

        const report: IngestionVerificationReport = {
            timestamp,
            qdrantCount,
            neo4jMemoryCount,
            neo4jRelationshipCount,
            sqliteMemoryCount,
            categoryDistribution,
            tagFrequency,
            storeCountsMatch,
            warnings
        };

        // Print summary to console
        console.log('\n=== Ingestion Verification Report ===');
        console.log(`Timestamp:       ${timestamp}`);
        console.log(`Qdrant count:    ${qdrantCount}`);
        console.log(`Neo4j memories:  ${neo4jMemoryCount}`);
        console.log(`Neo4j relations: ${neo4jRelationshipCount}`);
        console.log(`SQLite count:    ${sqliteMemoryCount}`);
        console.log(`Counts match:    ${storeCountsMatch ? '✓ YES' : '✗ NO'}`);
        console.log('Category distribution:');
        for (const [cat, count] of Object.entries(categoryDistribution)) {
            if (count > 0) console.log(`  ${cat}: ${count}`);
        }
        const topTags = Object.entries(tagFrequency).sort((a, b) => b[1] - a[1]).slice(0, 10);
        if (topTags.length > 0) {
            console.log('Top tags:');
            for (const [tag, count] of topTags) {
                console.log(`  ${tag}: ${count}`);
            }
        }
        if (warnings.length > 0) {
            console.log('Warnings:');
            for (const w of warnings) console.log(`  ⚠ ${w}`);
        }
        console.log('=====================================\n');

        return report;
    }
}
