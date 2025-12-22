import { SqlService } from '../services/sqlService';
import sqlite3 from 'sqlite3';
import path from 'path';

const DB_PATH = path.join(process.cwd(), 'data', 'memory.db');

async function testSearchHistory() {
    console.log("Testing SearchHistory...");
    const sqlService = new SqlService();

    // Give it a moment to connect
    await new Promise(resolve => setTimeout(resolve, 500));

    try {
        const searchText = "test search query";
        const vectorResults = [{ id: "vec1", score: 0.9 }];
        const graphResults = [{ id: "node1" }];
        const mergePrompt = "Summarize this...";
        const mergeSummary = "This is a summary.";

        console.log("Adding search history...");
        await sqlService.addSearchHistory(
            searchText,
            vectorResults,
            graphResults,
            mergePrompt,
            mergeSummary,
            10,
            0.7,
            "linear",
            "bullets",
            "test-model",
            1,
            100
        );
        console.log("Search history added.");

        // Verify directly with sqlite3
        const db = new sqlite3.Database(DB_PATH);

        await new Promise<void>((resolve, reject) => {
            db.get("SELECT * FROM SearchHistory ORDER BY ID DESC LIMIT 1", (err, row: any) => {
                if (err) {
                    console.error("Error reading verification:", err);
                    reject(err);
                    return;
                }
                console.log("Latest SearchHistory record:", row);
                if (!row) {
                    console.error("No record found!");
                    reject(new Error("No record found"));
                    return;
                }
                if (row.SearchText !== searchText) console.error("SearchText mismatch");
                if (row.MergePrompt !== mergePrompt) console.error("MergePrompt mismatch");
                if (row.MergeSummary !== mergeSummary) console.error("MergeSummary mismatch");
                if (row.ParamLimit !== 10) console.error("ParamLimit mismatch");
                if (row.ScoreThreshold !== 0.7) console.error("ScoreThreshold mismatch");
                if (row.Strategy !== 'linear') console.error("Strategy mismatch");
                if (row.Format !== 'bullets') console.error("Format mismatch");
                if (row.Model !== 'test-model') console.error("Model mismatch");
                if (row.ResultCount !== 1) console.error("ResultCount mismatch");
                if (row.DurationMilliseconds !== 100) console.error("DurationMilliseconds mismatch");

                // Parse JSON
                const vRes = JSON.parse(row.VectorResults);
                if (vRes[0].id !== "vec1") console.error("VectorResult JSON mismatch");

                console.log("Verification successful.");
                resolve();
            });
        });

        db.close();

    } catch (error) {
        console.error("Test failed:", error);
    } finally {
        sqlService.close();
    }
}

testSearchHistory();
