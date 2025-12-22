import sqlite3 from 'sqlite3';
import path from 'path';

// Enable verbose logging
sqlite3.verbose();

const DB_PATH = path.join(process.cwd(), 'data', 'memory.db');

export interface Memory {
    content: string;
    description?: string;
    tags?: string[];
    category?: string;
}

export interface TagSuggestion {
    id: number;
    tagText: string;
    lastUpdated: string;
    created: string;
}

export class SqlService {
    private db: sqlite3.Database;

    constructor() {
        this.db = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                console.error('Error opening database:', err.message);
            } else {
                console.log('Connected to the SQLite database.');
            }
        });
        this.enableForeignKeys();
    }

    private enableForeignKeys() {
        this.db.run('PRAGMA foreign_keys = ON;', (err) => {
            if (err) console.error('Error enabling foreign keys:', err.message);
        });
    }

    // Helper to wrap db.run in a promise
    private run(sql: string, params: any[] = []): Promise<void> {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    // Helper to wrap db.run in a promise and return the lastID
    private runInsert(sql: string, params: any[] = []): Promise<number> {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) return reject(err);
                resolve(this.lastID);
            });
        });
    }

    // Helper to wrap db.get in a promise
    private get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) return reject(err);
                resolve(row as T);
            });
        });
    }

    // Helper to wrap db.all in a promise
    private all<T>(sql: string, params: any[] = []): Promise<T[]> {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) return reject(err);
                resolve(rows as T[]);
            });
        });
    }

    public async addMemory(content: string, description: string, tags: string[], category: string, status: string = 'New', model?: string, durationMilliseconds?: number): Promise<number> {
        const timestamp = new Date().toISOString();
        const tagsString = JSON.stringify(tags);

        try {
            const memoryId = await this.runInsert(
                `INSERT INTO Memories (Content, Description, Tags, Category, Created, LastUpdated, Status, Deleted) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
                [content, description, tagsString, category, timestamp, timestamp, status]
            );

            // Always create a new record in MemoryDatabaseRelations with null GraphId and VectorId
            await this.run(
                `INSERT INTO MemoryDatabaseRelations (MemoryId, GraphId, VectorId) VALUES (?, NULL, NULL)`,
                [memoryId]
            );

            // Add history record for the new memory with model and duration info
            await this.addMemoryHistory(memoryId, content, description, tags, category, model, durationMilliseconds);

            return memoryId;
        } catch (error) {
            console.error('Error adding memory:', error);
            throw error;
        }
    }

    public async addMemoryHistory(memoryId: number, content: string, description: string, tags: string[], category: string, model?: string, durationMilliseconds?: number): Promise<void> {
        const timestamp = new Date().toISOString();
        const tagsString = JSON.stringify(tags);

        try {
            await this.run(
                `INSERT INTO MemoryHistory (Content, Description, Tags, Category, Created, MemoryId, Model, DurationMilliseconds) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [content, description, tagsString, category, timestamp, memoryId, model, durationMilliseconds]
            );
        } catch (error) {
            console.error('Error adding memory history:', error);
            throw error;
        }
    }

    public async updateMemory(id: number, content: string, description: string, tags: string[], category: string, status?: string): Promise<void> {
        const timestamp = new Date().toISOString();
        const tagsString = JSON.stringify(tags);

        let sql = `UPDATE Memories SET Content = ?, Description = ?, Tags = ?, Category = ?, LastUpdated = ?`;
        const params: any[] = [content, description, tagsString, category, timestamp];

        if (status) {
            sql += `, Status = ?`;
            params.push(status);
        }

        sql += ` WHERE ID = ?`;
        params.push(id);

        try {
            await this.addMemoryHistory(id, content, description, tags, category);
            await this.run(sql, params);
        } catch (error) {
            console.error('Error updating memory:', error);
            throw error;
        }
    }

    public async updateMemoryStatus(id: number, status: string): Promise<void> {
        const timestamp = new Date().toISOString();
        await this.run(`UPDATE Memories SET Status = ?, LastUpdated = ? WHERE ID = ?`, [status, timestamp, id]);
    }

    public async softDeleteMemory(id: number): Promise<void> {
        const timestamp = new Date().toISOString();
        await this.run(`UPDATE Memories SET Deleted = 1, LastUpdated = ? WHERE ID = ?`, [timestamp, id]);
    }

    public async getMemoriesByStatus(status: string): Promise<any[]> {
        return this.all(`SELECT * FROM Memories WHERE Status = ? AND Deleted = 0`, [status]);
    }

    public async updateMemoryRelations(memoryId: number, graphId?: string, vectorId?: string): Promise<void> {
        const updates: string[] = [];
        const params: any[] = [];

        if (graphId !== undefined) {
            updates.push('GraphId = ?');
            params.push(graphId);
        }
        if (vectorId !== undefined) {
            updates.push('VectorId = ?');
            params.push(vectorId);
        }

        if (updates.length === 0) return;

        params.push(memoryId);
        const sql = `UPDATE MemoryDatabaseRelations SET ${updates.join(', ')} WHERE MemoryId = ?`;

        await this.run(sql, params);
    }

    public async addTagSuggestion(tag: string): Promise<number> {
        const lowerTag = tag.toLowerCase(); // Ensure lowercase
        const timestamp = new Date().toISOString();

        const existing = await this.get<{ ID: number }>(`SELECT ID FROM TagSuggestions WHERE TagText = ?`, [lowerTag]);
        if (existing) {
            await this.run(`UPDATE TagSuggestions SET LastUpdated = ? WHERE ID = ?`, [timestamp, existing.ID]);
            return existing.ID;
        }

        return await this.runInsert(
            `INSERT INTO TagSuggestions (TagText, Created, LastUpdated) VALUES (?, ?, ?)`,
            [lowerTag, timestamp, timestamp]
        );
    }

    public async recordSuggestedTag(memoryId: number, tagId: number): Promise<void> {
        await this.run(
            `INSERT OR IGNORE INTO MemorySuggestedTagsRelation (MemoryId, SuggestedTagId) VALUES (?, ?)`,
            [memoryId, tagId]
        );
    }

    public async getMemory(id: number): Promise<any> {
        return this.get(`SELECT * FROM Memories JOIN MemoryDatabaseRelations ON Memories.ID = MemoryDatabaseRelations.MemoryId WHERE Memories.ID = ? AND Memories.Deleted = 0`, [id]);
    }

    public async getMemoryCount(): Promise<number> {
        const row = await this.get<{ count: number }>('SELECT COUNT(*) as count FROM Memories WHERE Deleted = 0');
        return row ? row.count : 0;
    }

    public async addSearchHistory(
        searchText: string,
        vectorResults: any,
        graphResults: any,
        mergePrompt: string,
        mergeSummary: string,
        paramLimit: number,
        scoreThreshold: number,
        strategy: string,
        format: string,
        model: string,
        resultCount: number,
        durationMilliseconds: number
    ): Promise<void> {
        const timestamp = new Date().toISOString();
        const vectorResultsStr = JSON.stringify(vectorResults);
        const graphResultsStr = JSON.stringify(graphResults);

        try {
            await this.run(
                `INSERT INTO SearchHistory (
                    SearchText, Created, VectorResults, GraphResults, MergePrompt, MergeSummary,
                    ParamLimit, ScoreThreshold, Strategy, Format, Model, ResultCount, DurationMilliseconds
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    searchText, timestamp, vectorResultsStr, graphResultsStr, mergePrompt, mergeSummary,
                    paramLimit, scoreThreshold, strategy, format, model, resultCount, durationMilliseconds
                ]
            );
        } catch (error) {
            console.error('Error adding search history:', error);
            // We do not throw here to avoid failing the search request just because logging failed? 
            // Or should we throw? Typically logging failure shouldn't crash the app, but let's log it.
        }
    }

    public close() {
        this.db.close((err) => {
            if (err) {
                console.error('Error closing database:', err.message);
            }
        });
    }
}
