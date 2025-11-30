import { ProcessedMemory, ReportStats, MemoryFeedbackReport } from '../memoryReportService';
import { ReportFormatter, PostSearchAggregationResult } from './reportFormatter';

export class HtmlReportFormatter implements ReportFormatter {
    getFileExtension(): string {
        return 'html';
    }

    private getStyles(): string {
        return `
            <style>
                body { font-family: sans-serif; line-height: 1.6; color: #333; max-width: 1200px; margin: 0 auto; padding: 20px; }
                h1, h2, h3, h4 { color: #2c3e50; }
                table { border-collapse: collapse; width: 100%; margin-bottom: 20px; }
                th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
                th { background-color: #f2f2f2; }
                tr:nth-child(even) { background-color: #f9f9f9; }
                .memory-block { border: 1px solid #eee; padding: 15px; margin-bottom: 20px; border-radius: 5px; }
                .raw-output { background-color: #f8f8f8; padding: 10px; border-left: 3px solid #ccc; font-family: monospace; }
                .final-value { font-weight: bold; color: #27ae60; }
                .tag { display: inline-block; background-color: #e1f5fe; color: #0277bd; padding: 2px 8px; border-radius: 12px; font-size: 0.9em; margin-right: 5px; }
                .score { font-weight: bold; color: #e67e22; }
            </style>
        `;
    }

    formatFeedbackReport(feedback: MemoryFeedbackReport): string {
        const ts = feedback.timestamp ? feedback.timestamp.toLocaleString() : new Date().toLocaleString();
        let html = `<!DOCTYPE html><html><head><title>Memory Feedback Report</title>${this.getStyles()}</head><body>`;

        html += `<h1>Memory Feedback Report</h1>`;
        html += `<p><strong>Date:</strong> ${ts}</p>`;
        html += `<p><strong>Embedding Model:</strong> ${feedback.embeddingModel}</p>`;

        html += `<h2>Category Counts</h2><ul>`;
        Object.entries(feedback.categoryCounts).forEach(([cat, count]) => {
            html += `<li><strong>${cat}:</strong> ${count}</li>`;
        });
        html += `</ul>`;

        html += `<h2>Memories by Category (Top 3)</h2>`;
        Object.entries(feedback.memoriesByCategory).forEach(([cat, mems]) => {
            html += `<h3>${cat}</h3><ul>`;
            mems.forEach((m: any) => {
                const tags = (m.Tags || []).map((t: string) => `<span class="tag">${t}</span>`).join('');
                html += `<li><strong>ID:</strong> ${m.id}, <strong>Description:</strong> ${m.Description}, <strong>Tags:</strong> ${tags}</li>`;
            });
            html += `</ul>`;
        });

        html += `<h2>Semantic Search Results</h2>`;
        feedback.semanticSearches.forEach(({ query, results }) => {
            html += `<hr><h3>&#9654; Query: <code>${query}</code></h3>`;
            if (results.length === 0) {
                html += `<p><em>No results found.</em></p>`;
            } else {
                html += `<table><thead><tr><th>Rank</th><th>ID</th><th>Description</th><th>Category</th><th>Tags</th><th>Score</th></tr></thead><tbody>`;
                results.forEach((m: any, idx: number) => {
                    const tags = (m.Tags || []).map((t: string) => `<span class="tag">${t}</span>`).join('');
                    html += `<tr>
                        <td>${idx + 1}</td>
                        <td>${m.id || ''}</td>
                        <td>${m.Description || ''}</td>
                        <td>${m.Category || ''}</td>
                        <td>${tags}</td>
                        <td>${typeof m.score !== 'undefined' ? `<span class="score">${m.score}</span>` : ''}</td>
                    </tr>`;
                });
                html += `</tbody></table>`;
            }
        });

        html += `<h2>Tag-Based Search Results</h2>`;
        feedback.tagSearches.forEach(({ tags, results }) => {
            html += `<h3>Tags: [${tags.join(', ')}]</h3><ul>`;
            results.slice(0, 3).forEach((m: any) => {
                const mTags = (m.Tags || []).map((t: string) => `<span class="tag">${t}</span>`).join('');
                html += `<li><strong>ID:</strong> ${m.id}, <strong>Description:</strong> ${m.Description}, <strong>Category:</strong> ${m.Category}, <strong>Tags:</strong> ${mTags}`;
                if (typeof m.score !== 'undefined') {
                    html += `, <strong>Score:</strong> <span class="score">${m.score}</span>`;
                }
                html += `</li>`;
            });
            html += `</ul>`;
        });

        html += `</body></html>`;
        return html;
    }

    formatIngestionReport(memories: ProcessedMemory[], stats: ReportStats): string {
        const durationSeconds = (stats.durationMs / 1000).toFixed(2);

        let html = `<!DOCTYPE html><html><head><title>Memory Ingestion Report</title>${this.getStyles()}</head><body>`;
        html += `<h1>Memory Ingestion Report</h1>`;
        html += `<p><strong>Date:</strong> ${stats.timestamp.toLocaleString()}</p>`;
        html += `<p><strong>Duration:</strong> ${durationSeconds} seconds</p>`;
        html += `<p><strong>Total Processed:</strong> ${stats.totalProcessed}</p>`;
        html += `<p><strong>Successfully Added:</strong> ${stats.successCount}</p>`;
        html += `<p><strong>Embedding Model:</strong> ${stats.embeddingModel}</p>`;

        html += `<h2>Processed Memories Details</h2>`;
        html += `<p>This section details each memory processed, showing the raw output from the LLM alongside the final values stored in the database.</p>`;

        memories.forEach((m, index) => {
            html += `<div class="memory-block"><h3>Memory ${index + 1}</h3>`;

            // Content
            html += `<h4>Content</h4>`;
            html += `<div class="raw-output">${m.Content.replace(/\n/g, '<br>')}</div>`;

            // Classification
            html += `<h4>Classification</h4>`;
            html += `<p><strong>Raw LLM Output:</strong> <code>${m.classification || 'N/A'}</code></p>`;
            html += `<p><strong>Final Category:</strong> <span class="final-value">${m.Category}</span></p>`;

            // Summarization
            html += `<h4>Summarization</h4>`;
            html += `<p><strong>Raw LLM Output:</strong> ${m.summary || 'N/A'}</p>`;
            html += `<p><strong>Final Description:</strong> <span class="final-value">${m.Description}</span></p>`;

            // Tagging
            const rawTags = m.tagsRaw || m.tags || [];
            const finalTags = m.Tags || [];
            html += `<h4>Tagging</h4>`;
            html += `<p><strong>Raw LLM Output:</strong> <code>[${rawTags.join(', ')}]</code></p>`;
            html += `<p><strong>Final Tags:</strong> <span class="final-value">[${finalTags.join(', ')}]</span></p>`;

            if (m.id) {
                html += `<p><strong>ID:</strong> <code>${m.id}</code></p>`;
            }
            html += `</div>`;
        });

        html += `</body></html>`;
        return html;
    }

    formatPostSearchAggregationReport(result: PostSearchAggregationResult): string {
        const ts = new Date().toLocaleString();
        let html = `<!DOCTYPE html><html><head><title>Post-Search Aggregation Report</title>${this.getStyles()}</head><body>`;
        html += `<h1>Post-Search Aggregation Report</h1>`;
        html += `<p><strong>Date:</strong> ${ts}</p>`;
        html += `<p><strong>Query:</strong> <code>${result.query}</code></p>`;
        html += `<p><strong>Parameters:</strong> <code>${JSON.stringify(result.parameters)}</code></p>`;

        // Top Memories
        html += `<h2>Top Memories</h2>`;
        if (!result.topMemories || result.topMemories.length === 0) {
            html += `<p><em>No top memories after filtering.</em></p>`;
        } else {
            html += `<table><thead><tr><th>Rank</th><th>ID</th><th>Description</th><th>Category</th><th>Tags</th><th>Score</th><th>LastUpdated</th></tr></thead><tbody>`;
            result.topMemories.forEach((m, idx) => {
                const tags = (m.Tags || []).map((t: string) => `<span class="tag">${t}</span>`).join('');
                html += `<tr>
                    <td>${idx + 1}</td>
                    <td>${m.id || ''}</td>
                    <td>${m.Description || ''}</td>
                    <td>${m.Category || ''}</td>
                    <td>${tags}</td>
                    <td>${typeof m.score !== 'undefined' ? `<span class="score">${m.score}</span>` : ''}</td>
                    <td>${m.LastUpdated || ''}</td>
                </tr>`;
            });
            html += `</tbody></table>`;
        }

        // Aggregate Summaries
        html += `<h2>Aggregate Summary</h2>`;
        if (result.aggregateNarrative) {
            html += `<h3>Narrative</h3><p>${result.aggregateNarrative}</p>`;
        }
        if (result.aggregateBullets && result.aggregateBullets.length) {
            html += `<h3>Bullets</h3><ul>`;
            result.aggregateBullets.forEach(b => html += `<li>${b}</li>`);
            html += `</ul>`;
        }

        // Cluster Summaries
        html += `<h2>Cluster Summaries</h2>`;
        if (result.clusterSummaries && result.clusterSummaries.length) {
            result.clusterSummaries.forEach((c) => {
                html += `<h3>${c.type === 'category' ? 'Category' : 'Tag'}: ${c.key}</h3>`;
                if (c.narrative) html += `<p>${c.narrative}</p>`;
                if (c.bullets && c.bullets.length) {
                    html += `<ul>`;
                    c.bullets.forEach(b => html += `<li>${b}</li>`);
                    html += `</ul>`;
                }
            });
        } else {
            html += `<p><em>No cluster summaries produced.</em></p>`;
        }

        html += `<hr><p>This report is generated automatically after each semantic search and post-search aggregation.</p>`;
        html += `</body></html>`;
        return html;
    }

    formatCombinedPostSearchAggregationReport(results: PostSearchAggregationResult[]): string {
        const ts = new Date();
        let html = `<!DOCTYPE html><html><head><title>Combined Post-Search Aggregation Report</title>${this.getStyles()}</head><body>`;
        html += `<h1>Combined Post-Search Aggregation Report</h1>`;
        html += `<p><strong>Date:</strong> ${ts.toLocaleString()}</p>`;
        html += `<p><strong>Queries Run:</strong> ${results.length}</p>`;

        results.forEach((res, idx) => {
            html += `<hr><h2>Query ${idx + 1}: <code>${res.query}</code></h2>`;
            html += `<p><strong>Parameters:</strong> <code>${JSON.stringify(res.parameters)}</code></p>`;

            // Top Memories
            html += `<h3>Top Memories</h3>`;
            if (!res.topMemories || res.topMemories.length === 0) {
                html += `<p><em>No top memories after filtering.</em></p>`;
            } else {
                html += `<table><thead><tr><th>Rank</th><th>ID</th><th>Description</th><th>Category</th><th>Tags</th><th>Score</th><th>LastUpdated</th></tr></thead><tbody>`;
                res.topMemories.forEach((m: any, idx2: number) => {
                    const tags = (m.Tags || []).map((t: string) => `<span class="tag">${t}</span>`).join('');
                    html += `<tr>
                        <td>${idx2 + 1}</td>
                        <td>${m.id || ''}</td>
                        <td>${m.Description || ''}</td>
                        <td>${m.Category || ''}</td>
                        <td>${tags}</td>
                        <td>${typeof m.score !== 'undefined' ? `<span class="score">${m.score}</span>` : ''}</td>
                        <td>${m.LastUpdated || ''}</td>
                    </tr>`;
                });
                html += `</tbody></table>`;
            }

            // Aggregate Summaries
            html += `<h3>Aggregate Summary</h3>`;
            if (res.aggregateNarrative) {
                html += `<h4>Narrative</h4><p>${res.aggregateNarrative}</p>`;
            }
            if (res.aggregateBullets && res.aggregateBullets.length) {
                html += `<h4>Bullets</h4><ul>`;
                res.aggregateBullets.forEach(b => html += `<li>${b}</li>`);
                html += `</ul>`;
            }

            // Cluster Summaries
            html += `<h3>Cluster Summaries</h3>`;
            if (res.clusterSummaries && res.clusterSummaries.length) {
                res.clusterSummaries.forEach((c: any) => {
                    html += `<h4>${c.type === 'category' ? 'Category' : 'Tag'}: ${c.key}</h4>`;
                    if (c.narrative) html += `<p>${c.narrative}</p>`;
                    if (c.bullets && c.bullets.length) {
                        html += `<ul>`;
                        c.bullets.forEach((b: string) => html += `<li>${b}</li>`);
                        html += `</ul>`;
                    }
                });
            } else {
                html += `<p><em>No cluster summaries produced.</em></p>`;
            }
        });

        html += `</body></html>`;
        return html;
    }
}
