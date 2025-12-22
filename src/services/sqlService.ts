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

    public async addMemory(content: string, description: string, tags: string[], category: string): Promise<number> {
        const timestamp = new Date().toISOString();
        const tagsString = JSON.stringify(tags);

        try {
            const memoryId = await this.runInsert(
                `INSERT INTO Memories (Content, Description, Tags, Category, Created, LastUpdated) VALUES (?, ?, ?, ?, ?, ?)`,
                [content, description, tagsString, category, timestamp, timestamp]
            );

            // Always create a new record in MemoryDatabaseRelations with null GraphId and VectorId
            await this.run(
                `INSERT INTO MemoryDatabaseRelations (MemoryId, GraphId, VectorId) VALUES (?, NULL, NULL)`,
                [memoryId]
            );

            return memoryId;
        } catch (error) {
            console.error('Error adding memory:', error);
            throw error;
        }
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
        return this.get(`SELECT * FROM Memories JOIN MemoryDatabaseRelations ON Memories.ID = MemoryDatabaseRelations.MemoryId WHERE Memories.ID = ?`, [id]);
    }

    public close() {
        this.db.close((err) => {
            if (err) {
                console.error('Error closing database:', err.message);
            }
        });
    }
}
