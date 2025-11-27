import fs from 'fs/promises';
import path from 'path';
import { Memory } from '../models/memory';

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

    async generateAndSaveReport(
        markdown: string,
        stats: ReportStats,
        reportName: string
    ): Promise<string> {
        const timestampStr = stats.timestamp.toISOString().replace(/[:.]/g, '-');
        const filename = `${reportName}_${timestampStr}.md`;
        const filePath = path.join(this.reportDir, filename);
        await fs.mkdir(this.reportDir, { recursive: true });
        await fs.writeFile(filePath, markdown, 'utf-8');
        return filePath;
    }

    /**
     * Generates a markdown report for memory feedback results (semantic/tag/category queries)
     */
    generateFeedbackMarkdown(feedback: MemoryFeedbackReport): string {
        const ts = feedback.timestamp ? feedback.timestamp.toLocaleString() : new Date().toLocaleString();
        let md = `# Memory Feedback Report\n\n`;
        md += `**Date:** ${ts}\n`;
        md += `**Embedding Model:** ${feedback.embeddingModel}\n`;
        md += `\n## Category Counts\n`;
        Object.entries(feedback.categoryCounts).forEach(([cat, count]: [string, number]) => {
            md += `- **${cat}**: ${count}\n`;
        });
        md += `\n## Memories by Category (Top 3)\n`;
        Object.entries(feedback.memoriesByCategory).forEach(([cat, mems]: [string, any[]]) => {
            md += `\n### ${cat}\n`;
            mems.forEach((m: any) => {
                md += `- **ID:** ${m.id}, **Description:** ${m.Description}, **Tags:** [${(m.Tags || []).join(', ')}]\n`;
            });
        });
        md += `\n## Semantic Search Results\n`;
        feedback.semanticSearches.forEach(({ query, results }: { query: string; results: any[] }) => {
            md += `\n---\n`;
            md += `### \u25B6 Query: \`${query}\`\n`;
            if (results.length === 0) {
                md += `> _No results found._\n`;
            } else {
                md += `| Rank | ID | Description | Category | Tags | Score |\n`;
                md += `|------|----|-------------|----------|------|-------|\n`;
                results.forEach((m: any, idx: number) => {
                    md += `| ${idx + 1} `;
                    md += `| ${m.id || ''} `;
                    md += `| ${m.Description || ''} `;
                    md += `| ${m.Category || ''} `;
                    md += `| [${(m.Tags || []).join(', ')}] `;
                    md += `| ${typeof m.score !== 'undefined' ? `__${m.score}__` : ''} |
`;
                });
            }
        });
        md += `\n## Tag-Based Search Results\n`;
        feedback.tagSearches.forEach(({ tags, results }: { tags: string[]; results: any[] }) => {
            md += `\n### Tags: [${tags.join(', ')}]\n`;
            results.slice(0, 3).forEach((m: any) => {
                md += `- **ID:** ${m.id}, **Description:** ${m.Description}, **Category:** ${m.Category}, **Tags:** [${(m.Tags || []).join(', ')}]`;
                if (typeof m.score !== 'undefined') {
                    md += `, **Score:** __${m.score}__`;
                }
                md += `\n`;
            });
        });
        return md;
    }

    generateIgenestionMarkdown(memories: ProcessedMemory[], stats: ReportStats): string {
        const durationSeconds = (stats.durationMs / 1000).toFixed(2);
        
        let md = `# Memory Ingestion Report\n\n`;
        md += `**Date:** ${stats.timestamp.toLocaleString()}\n`;
        md += `**Duration:** ${durationSeconds} seconds\n`;
        md += `**Total Processed:** ${stats.totalProcessed}\n`;
        md += `**Successfully Added:** ${stats.successCount}\n`;
        md += `**Embedding Model:** ${stats.embeddingModel}\n`;
        
        md += `\n## Processed Memories Details\n\n`;
        md += `This section details each memory processed, showing the raw output from the LLM alongside the final values stored in the database. Use this to tune your prompts.\n\n`;

        memories.forEach((m, index) => {
            md += `### Memory ${index + 1}\n\n`;
            
            // Content
            md += `#### Content\n`;
            md += `> ${m.Content.replace(/\n/g, '\n> ')}\n\n`;
            
            // Classification Comparison
            md += `#### Classification\n`;
            md += `- **Raw LLM Output:** \`${m.classification || 'N/A'}\`\n`;
            md += `- **Final Category:** \`${m.Category}\`\n\n`;

            // Summarization Comparison
            md += `#### Summarization\n`;
            md += `- **Raw LLM Output:** ${m.summary || 'N/A'}\n`;
            md += `- **Final Description:** ${m.Description}\n\n`;

            // Tagging Comparison
            // m.tags is the raw output from loadSeedMemories.ts mapping
            // m.Tags is the final list
            const rawTags = m.tagsRaw || m.tags || []; 
            const finalTags = m.Tags || [];

            md += `#### Tagging\n`;
            md += `- **Raw LLM Output:** \`[${rawTags.join(', ')}]\`\n`;
            md += `- **Final Tags:** \`[${finalTags.join(', ')}]\`\n\n`;
            
            // Other properties if needed
            if (m.id) {
                md += `- **ID:** \`${m.id}\`\n`;
            }
            
            md += `---\n\n`;
        });

        return md;
    }

    /**
     * Generates a markdown report for post-search aggregation output.
     * This captures the query, parameters, top memories, aggregate summaries, and cluster breakdowns.
     */
    generatePostSearchAggregationMarkdown(result: {
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
    }): string {
        const ts = new Date().toLocaleString();
        let md = `# Post-Search Aggregation Report\n\n`;
        md += `**Date:** ${ts}\n`;
        md += `**Query:** \`${result.query}\`\n`;
        md += `**Parameters:** ${JSON.stringify(result.parameters)}\n`;

        // Top Memories Table
        md += `\n## Top Memories\n`;
        if (!result.topMemories || result.topMemories.length === 0) {
            md += `> _No top memories after filtering._\n`;
        } else {
            md += `| Rank | ID | Description | Category | Tags | Score | LastUpdated |\n`;
            md += `|------|----|-------------|----------|------|-------|------------|\n`;
            result.topMemories.forEach((m, idx) => {
                md += `| ${idx + 1} `;
                md += `| ${m.id || ''} `;
                md += `| ${(m.Description || '').replace(/\|/g, '\\|')} `;
                md += `| ${m.Category || ''} `;
                md += `| [${(m.Tags || []).join(', ')}] `;
                md += `| ${typeof m.score !== 'undefined' ? `__${m.score}__` : ''} `;
                md += `| ${m.LastUpdated || ''} |\n`;
            });
        }

        // Aggregate Summaries
        md += `\n## Aggregate Summary\n`;
        if (result.aggregateNarrative) {
            md += `\n### Narrative\n`;
            md += `${result.aggregateNarrative}\n`;
        }
        if (result.aggregateBullets && result.aggregateBullets.length) {
            md += `\n### Bullets\n`;
            result.aggregateBullets.forEach(b => {
                md += `- ${b}\n`;
            });
        }

        // Cluster Summaries
        md += `\n## Cluster Summaries\n`;
        if (result.clusterSummaries && result.clusterSummaries.length) {
            result.clusterSummaries.forEach((c) => {
                md += `\n### ${c.type === 'category' ? 'Category' : 'Tag'}: ${c.key}\n`;
                if (c.narrative) {
                    md += `${c.narrative}\n`;
                }
                if (c.bullets && c.bullets.length) {
                    c.bullets.forEach(b => md += `- ${b}\n`);
                }
            });
        } else {
            md += `> _No cluster summaries produced._\n`;
        }

        // Footer
        md += `\n---\n`;
        md += `This report is generated automatically after each semantic search and post-search aggregation.\n`;
        return md;
    }

    /**
     * Convenience: Generate and save a post-search aggregation report.
     */
    async generateAndSavePostSearchAggregationReport(
        result: {
            query: string;
            topMemories: any[];
            aggregateNarrative?: string;
            aggregateBullets?: string[];
            clusterSummaries?: Array<{ key: string; type: 'category' | 'tag'; narrative?: string; bullets?: string[] }>;
            parameters: any;
        },
        embeddingModel: string = 'unknown'
    ): Promise<string> {
        const markdown = this.generatePostSearchAggregationMarkdown(result);
        const stats: ReportStats = {
            totalProcessed: result.topMemories?.length || 0,
            successCount: result.topMemories?.length || 0,
            durationMs: 0,
            timestamp: new Date(),
            embeddingModel
        };
        return await this.generateAndSaveReport(markdown, stats, 'post_search_aggregation');
    }

        /**
         * Generates and saves a combined post-search aggregation report for multiple queries.
         */
        async generateAndSaveCombinedPostSearchAggregationReport(
            results: Array<{
                query: string;
                topMemories: any[];
                aggregateNarrative?: string;
                aggregateBullets?: string[];
                clusterSummaries?: Array<{ key: string; type: 'category' | 'tag'; narrative?: string; bullets?: string[] }>;
                parameters: any;
            }>,
            embeddingModel: string = 'unknown'
        ): Promise<string> {
            const ts = new Date();
            let md = `# Combined Post-Search Aggregation Report\n\n`;
            md += `**Date:** ${ts.toLocaleString()}\n`;
            md += `**Queries Run:** ${results.length}\n`;

            results.forEach((res, idx) => {
                md += `\n---\n`;
                md += `## Query ${idx + 1}: \`${res.query}\`\n`;
                md += `**Parameters:** ${JSON.stringify(res.parameters)}\n`;

                // Top memories table
                md += `\n### Top Memories\n`;
                if (!res.topMemories || res.topMemories.length === 0) {
                    md += `> _No top memories after filtering._\n`;
                } else {
                    md += `| Rank | ID | Description | Category | Tags | Score | LastUpdated |\n`;
                    md += `|------|----|-------------|----------|------|-------|------------|\n`;
                    res.topMemories.forEach((m: any, idx2: number) => {
                        md += `| ${idx2 + 1} `;
                        md += `| ${m.id || ''} `;
                        md += `| ${(m.Description || '').replace(/\|/g, '\\|')} `;
                        md += `| ${m.Category || ''} `;
                        md += `| [${(m.Tags || []).join(', ')}] `;
                        md += `| ${typeof m.score !== 'undefined' ? `__${m.score}__` : ''} `;
                        md += `| ${m.LastUpdated || ''} |\n`;
                    });
                }

                // Aggregate summaries
                md += `\n### Aggregate Summary\n`;
                if (res.aggregateNarrative) {
                    md += `\n#### Narrative\n`;
                    md += `${res.aggregateNarrative}\n`;
                }
                if (res.aggregateBullets && res.aggregateBullets.length) {
                    md += `\n#### Bullets\n`;
                    res.aggregateBullets.forEach((b: string) => md += `- ${b}\n`);
                }

                // Cluster summaries
                md += `\n### Cluster Summaries\n`;
                if (res.clusterSummaries && res.clusterSummaries.length) {
                    res.clusterSummaries.forEach((c: any) => {
                        md += `\n#### ${c.type === 'category' ? 'Category' : 'Tag'}: ${c.key}\n`;
                        if (c.narrative) md += `${c.narrative}\n`;
                        if (c.bullets && c.bullets.length) c.bullets.forEach((b: string) => md += `- ${b}\n`);
                    });
                } else {
                    md += `> _No cluster summaries produced._\n`;
                }
            });

            const filePath = await this.generateAndSaveReport(md, {
                totalProcessed: results.reduce((sum, r) => sum + (r.topMemories?.length || 0), 0),
                successCount: results.length,
                durationMs: 0,
                timestamp: ts,
                embeddingModel
            }, 'combined_post_search_aggregation');
            return filePath;
        }
}
