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
}
