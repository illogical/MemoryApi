import { MemoryReportService } from '../services/memoryReportService';

async function testHtmlReport() {
    const reportService = new MemoryReportService();

    const feedback = {
        categoryCounts: { 'Work': 5, 'Personal': 3 },
        memoriesByCategory: {
            'Work': [
                { id: '1', Description: 'Meeting notes', Tags: ['meeting', 'notes'], Category: 'Work' },
                { id: '2', Description: 'Project plan', Tags: ['project', 'planning'], Category: 'Work' }
            ],
            'Personal': [
                { id: '3', Description: 'Grocery list', Tags: ['shopping'], Category: 'Personal' }
            ]
        },
        semanticSearches: [
            {
                query: 'project',
                results: [
                    { id: '2', Description: 'Project plan', Category: 'Work', Tags: ['project'], score: 0.9 }
                ]
            }
        ],
        tagSearches: [],
        embeddingModel: 'test-model',
        timestamp: new Date()
    };

    console.log('Generating HTML Feedback Report...');
    const filePath = await reportService.generateFeedbackReport(feedback, 'html');
    console.log(`Report generated at: ${filePath}`);
}

testHtmlReport().catch(console.error);
