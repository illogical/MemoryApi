import sqlite3 from 'sqlite3';
import { config, Config } from './configService';

// Enable verbose logging
sqlite3.verbose();

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

export interface MemoryPopulationValidationResult {
    totalCount: number;
    expectedCount?: number;
    missingGraphIds: number;
    missingVectorIds: number;
    mismatchedRelationIds: number;
    missingRelationRows: number;
    invalidMemoryIds: number[];
    isValid: boolean;
}

export class SqlService {
    private db!: sqlite3.Database;
    private initializationPromise: Promise<void>;
    private isClosed: boolean = true;

    private _dbPath: string = config.SQLITE_DB_PATH;

    constructor(cfg: Config = config, db?: sqlite3.Database) {
        this._dbPath = cfg.SQLITE_DB_PATH;
        this.initializationPromise = Promise.resolve();
        if (db) {
            this.db = db;
            this.isClosed = false;
            this.enableForeignKeys();
            this.initializationPromise = this.initializeSchema().catch(err => {
                console.error('Error initializing schema:', err);
                throw err;
            });
        } else {
            this.openConnection(this._dbPath);
        }
    }

    private openConnection(dbPath: string): void {
        this.db = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error('Error opening database:', err.message);
            } else {
                console.log('Connected to the SQLite database.');
            }
        });
        this.isClosed = false;
        this.enableForeignKeys();
        this.initializationPromise = this.initializeSchema().catch(err => {
            console.error('Error initializing schema:', err);
            throw err;
        });
    }

    private enableForeignKeys() {
        this.db.run('PRAGMA foreign_keys = ON;', (err) => {
            if (err) console.error('Error enabling foreign keys:', err.message);
        });
    }

    private async initializeSchema(): Promise<void> {
        await this.runRaw(`CREATE TABLE IF NOT EXISTS Memories (
            ID INTEGER PRIMARY KEY AUTOINCREMENT,
            Content TEXT NOT NULL,
            Description TEXT,
            Tags TEXT,
            Category TEXT,
            Created TEXT NOT NULL,
            LastUpdated TEXT NOT NULL,
            Status TEXT NOT NULL DEFAULT 'New',
            Deleted BOOLEAN DEFAULT 0,
            IngestionBatchId TEXT,
            UserReviewed TEXT,
            Tools TEXT,
            Projects TEXT
        )`);
        // Migrations: add new columns if they don't exist (for existing DBs)
        const newColumns: { name: string; def: string }[] = [
            { name: 'IngestionBatchId', def: 'TEXT' },
            { name: 'UserReviewed', def: 'TEXT' },
            { name: 'Tools', def: 'TEXT' },
            { name: 'Projects', def: 'TEXT' },
        ];
        for (const col of newColumns) {
            try {
                await this.runRaw(`ALTER TABLE Memories ADD COLUMN ${col.name} ${col.def}`);
            } catch {
                // Column already exists — ignore
            }
        }
        // Drop legacy columns
        for (const col of ['SourceType', 'Durability', 'Dataset', 'Topics']) {
            try {
                await this.runRaw(`ALTER TABLE Memories DROP COLUMN ${col}`);
            } catch {
                // Column doesn't exist — ignore
            }
        }
        await this.runRaw(`CREATE TABLE IF NOT EXISTS MemoryDatabaseRelations (
            MemoryId INTEGER PRIMARY KEY,
            GraphId TEXT,
            VectorId TEXT,
            FOREIGN KEY (MemoryId) REFERENCES Memories(ID) ON DELETE CASCADE
        )`);
        await this.runRaw(`CREATE TABLE IF NOT EXISTS TagSuggestions (
            ID INTEGER PRIMARY KEY AUTOINCREMENT,
            TagText TEXT NOT NULL UNIQUE,
            Count INTEGER NOT NULL DEFAULT 0,
            Active BOOLEAN NOT NULL DEFAULT 1,
            LastUpdated TEXT NOT NULL,
            Created TEXT NOT NULL
        )`);
        await this.runRaw(`CREATE TABLE IF NOT EXISTS MemorySuggestedTagsRelation (
            MemoryId INTEGER,
            SuggestedTagId INTEGER,
            PRIMARY KEY (MemoryId, SuggestedTagId),
            FOREIGN KEY (MemoryId) REFERENCES Memories(ID) ON DELETE CASCADE,
            FOREIGN KEY (SuggestedTagId) REFERENCES TagSuggestions(ID) ON DELETE CASCADE
        )`);
        await this.runRaw(`CREATE TABLE IF NOT EXISTS SearchHistory (
            ID INTEGER PRIMARY KEY AUTOINCREMENT,
            SearchText TEXT,
            Created TEXT,
            VectorResults TEXT,
            GraphResults TEXT,
            MergePrompt TEXT,
            MergeSummary TEXT,
            ParamLimit INTEGER,
            ScoreThreshold REAL,
            Strategy TEXT,
            Format TEXT,
            Model TEXT,
            ResultCount INTEGER,
            DurationMilliseconds INTEGER
        )`);
        await this.runRaw(`CREATE INDEX IF NOT EXISTS idx_memories_created ON Memories(Created)`);
        await this.runRaw(`CREATE INDEX IF NOT EXISTS idx_tagsuggestions_tagtext ON TagSuggestions(TagText)`);
        await this.runRaw(`CREATE INDEX IF NOT EXISTS idx_memories_ingestionbatchid ON Memories(IngestionBatchId)`);
    }

    public async waitUntilReady(): Promise<void> {
        await this.initializationPromise;
    }

    public async reconnect(): Promise<void> {
        await this.close();
        this.openConnection(this._dbPath);
        await this.waitUntilReady();
    }

    private async ensureReady(): Promise<void> {
        if (this.isClosed) {
            throw new Error('SQLite connection is closed');
        }
        await this.initializationPromise;
    }

    // Helper to wrap db.run in a promise during initialization
    private runRaw(sql: string, params: any[] = []): Promise<void> {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) return reject(err);
                resolve();
            });
        });
    }

    private async run(sql: string, params: any[] = []): Promise<void> {
        await this.ensureReady();
        return this.runRaw(sql, params);
    }

    // Helper to wrap db.run in a promise and return the lastID
    private runInsertRaw(sql: string, params: any[] = []): Promise<number> {
        return new Promise((resolve, reject) => {
            this.db.run(sql, params, function (err) {
                if (err) return reject(err);
                resolve(this.lastID);
            });
        });
    }

    private async runInsert(sql: string, params: any[] = []): Promise<number> {
        await this.ensureReady();
        return this.runInsertRaw(sql, params);
    }

    // Helper to wrap db.get in a promise
    private getRaw<T>(sql: string, params: any[] = []): Promise<T | undefined> {
        return new Promise((resolve, reject) => {
            this.db.get(sql, params, (err, row) => {
                if (err) return reject(err);
                resolve(row as T);
            });
        });
    }

    private async get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
        await this.ensureReady();
        return this.getRaw<T>(sql, params);
    }

    // Helper to wrap db.all in a promise
    private allRaw<T>(sql: string, params: any[] = []): Promise<T[]> {
        return new Promise((resolve, reject) => {
            this.db.all(sql, params, (err, rows) => {
                if (err) return reject(err);
                resolve(rows as T[]);
            });
        });
    }

    private async all<T>(sql: string, params: any[] = []): Promise<T[]> {
        await this.ensureReady();
        return this.allRaw<T>(sql, params);
    }

    public async addMemory(
        content: string,
        description: string,
        tags: string[],
        category: string,
        status: string = 'New',
        metadata?: {
            ingestionBatchId?: string;
            userReviewed?: string;
            tools?: string[];
            projects?: string[];
            created?: string;
        }
    ): Promise<number> {
        const timestamp = new Date().toISOString();
        const createdAt = metadata?.created ?? timestamp;
        const tagsString = JSON.stringify(tags);
        const toolsString = metadata?.tools ? JSON.stringify(metadata.tools) : null;
        const projectsString = metadata?.projects ? JSON.stringify(metadata.projects) : null;

        try {
            const memoryId = await this.runInsert(
                `INSERT INTO Memories (Content, Description, Tags, Category, Created, LastUpdated, Status, Deleted, IngestionBatchId, UserReviewed, Tools, Projects)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
                [
                    content, description, tagsString, category, createdAt, timestamp, status,
                    metadata?.ingestionBatchId ?? null,
                    metadata?.userReviewed ?? null,
                    toolsString,
                    projectsString
                ]
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
        return this.all(
            `SELECT m.*
             FROM Memories m
             WHERE m.Status = ? AND m.Deleted = 0
             ORDER BY m.Created DESC`,
            [status]
        );
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
            await this.run(`UPDATE TagSuggestions SET Count = Count + 1, LastUpdated = ? WHERE ID = ?`, [timestamp, existing.ID]);
            return existing.ID;
        }

        return await this.runInsert(
            `INSERT INTO TagSuggestions (TagText, Created, LastUpdated, Count) VALUES (?, ?, ?, ?)`,
            [lowerTag, timestamp, timestamp, 1]
        );
    }

    public async recordSuggestedTag(memoryId: number, tagId: number): Promise<void> {
        await this.run(
            `INSERT OR IGNORE INTO MemorySuggestedTagsRelation (MemoryId, SuggestedTagId) VALUES (?, ?)`,
            [memoryId, tagId]
        );
    }

    public async getSuggestedTags(threshold: number = 5): Promise<any[]> {
        return this.all(`SELECT * FROM TagSuggestions WHERE Count >= ? AND Active = 1 ORDER BY Count DESC`, [threshold]);
    }

    public async dismissTagSuggestion(id: number): Promise<void> {
        const timestamp = new Date().toISOString();
        await this.run(`UPDATE TagSuggestions SET Active = 0, LastUpdated = ? WHERE ID = ?`, [timestamp, id]);
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

    public async getAllMemories(filters?: {
        category?: string;
    }): Promise<any[]> {
        const conditions: string[] = ['m.Deleted = 0'];
        const params: any[] = [];

        if (filters?.category) {
            conditions.push('m.Category = ?');
            params.push(filters.category);
        }

        const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        return this.all(
            `SELECT m.ID, m.Content, m.Category, m.Tags,
                    m.IngestionBatchId, m.UserReviewed, m.Tools, m.Projects,
                    m.Created, m.LastUpdated, m.Status,
                    r.GraphId, r.VectorId
             FROM Memories m
             LEFT JOIN MemoryDatabaseRelations r ON m.ID = r.MemoryId
             ${where}
             ORDER BY m.Created DESC`,
            params
        );
    }

    public async validateMemoryPopulation(filters?: {
        category?: string;
    }, expectedCount?: number): Promise<MemoryPopulationValidationResult> {
        const memories = await this.getAllMemories(filters);
        const invalidMemoryIds: number[] = [];
        let missingGraphIds = 0;
        let missingVectorIds = 0;
        let mismatchedRelationIds = 0;
        let missingRelationRows = 0;

        for (const memory of memories) {
            const hasGraphId = typeof memory.GraphId === 'string' && memory.GraphId.trim().length > 0;
            const hasVectorId = typeof memory.VectorId === 'string' && memory.VectorId.trim().length > 0;

            if (!hasGraphId && !hasVectorId) {
                missingRelationRows++;
            }
            if (!hasGraphId) {
                missingGraphIds++;
            }
            if (!hasVectorId) {
                missingVectorIds++;
            }
            if (hasGraphId && hasVectorId && memory.GraphId !== memory.VectorId) {
                mismatchedRelationIds++;
            }

            if (!hasGraphId || !hasVectorId || (hasGraphId && hasVectorId && memory.GraphId !== memory.VectorId)) {
                invalidMemoryIds.push(memory.ID);
            }
        }

        const totalCount = memories.length;
        const countMatches = expectedCount === undefined || totalCount === expectedCount;
        const isValid = countMatches
            && missingGraphIds === 0
            && missingVectorIds === 0
            && mismatchedRelationIds === 0
            && missingRelationRows === 0;

        return {
            totalCount,
            expectedCount,
            missingGraphIds,
            missingVectorIds,
            mismatchedRelationIds,
            missingRelationRows,
            invalidMemoryIds,
            isValid
        };
    }

    public async close(): Promise<void> {
        if (this.isClosed) {
            return;
        }

        await new Promise<void>((resolve, reject) => {
            this.db.close((err) => {
                if (err) {
                    console.error('Error closing database:', err.message);
                    reject(err);
                    return;
                }
                resolve();
            });
        });

        this.isClosed = true;
    }
}

export const sqlService = new SqlService();
