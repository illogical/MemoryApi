import { ProcessedMemory, ReportStats, MemoryFeedbackReport } from '../memoryReportService';
import { ReportFormatter, PostSearchAggregationResult } from './reportFormatter';

export class MarkdownReportFormatter implements ReportFormatter {
    getFileExtension(): string {
        return 'md';
    }

    formatFeedbackReport(feedback: MemoryFeedbackReport): string {
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

    formatIngestionReport(memories: ProcessedMemory[], stats: ReportStats): string {
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

    formatPostSearchAggregationReport(result: PostSearchAggregationResult): string {
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

    formatCombinedPostSearchAggregationReport(results: PostSearchAggregationResult[]): string {
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

        return md;
    }
}
