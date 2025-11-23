import fs from 'fs';
import path from 'path';

export interface FeedbackQueries {
    semanticQueries: string[];
    tagSearches: string[][];
}

export class FeedbackQueryLoader {
    static load(jsonFilePath: string): FeedbackQueries {
        const absPath = path.isAbsolute(jsonFilePath)
            ? jsonFilePath
            : path.join(process.cwd(), jsonFilePath);
        let raw: string;
        try {
            raw = fs.readFileSync(absPath, 'utf-8');
        } catch (fileErr) {
            throw new Error(`Error reading feedback queries file at ${absPath}: ${fileErr}`);
        }
        let data: FeedbackQueries;
        try {
            data = JSON.parse(raw);
        } catch (jsonErr) {
            throw new Error(`Error parsing JSON from feedback queries file at ${absPath}: ${jsonErr}`);
        }
        return data;
    }
}
