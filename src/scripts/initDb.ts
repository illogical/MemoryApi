import sqlite3 from 'sqlite3';
import { open } from 'sqlite3';
import path from 'path';
import fs from 'fs';

// Enable verbose logging for debugging
sqlite3.verbose();

const DB_PATH = path.join(process.cwd(), 'data', 'memory.db');

async function initializeDatabase() {
    console.log(`Initializing database at ${DB_PATH}...`);

    // Ensure data directory exists
    const dataDir = path.dirname(DB_PATH);
    if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
    }

    const db = new sqlite3.Database(DB_PATH);

    const runRun = (sql: string, params: any[] = []): Promise<void> => {
        return new Promise((resolve, reject) => {
            db.run(sql, params, function (err) {
                if (err) return reject(err);
                resolve();
            });
        });
    };

    try {
        // Enable foreign keys
        await runRun('PRAGMA foreign_keys = ON;');

        // Create Memories Table
        console.log('Creating Memories table...');
        await runRun(`
      CREATE TABLE IF NOT EXISTS Memories (
        ID INTEGER PRIMARY KEY AUTOINCREMENT,
        Content TEXT NOT NULL,
        Description TEXT,
        Tags TEXT,
        Category TEXT,
        Created TEXT NOT NULL,
        LastUpdated TEXT NOT NULL
      );
    `);

        // Create MemoryDatabaseRelations Table
        console.log('Creating MemoryDatabaseRelations table...');
        await runRun(`
      CREATE TABLE IF NOT EXISTS MemoryDatabaseRelations (
        MemoryId INTEGER PRIMARY KEY,
        GraphId TEXT,
        VectorId TEXT,
        FOREIGN KEY (MemoryId) REFERENCES Memories(ID) ON DELETE CASCADE
      );
    `);

        // Create TagSuggestions Table
        console.log('Creating TagSuggestions table...');
        await runRun(`
      CREATE TABLE IF NOT EXISTS TagSuggestions (
        ID INTEGER PRIMARY KEY AUTOINCREMENT,
        TagText TEXT NOT NULL UNIQUE,
        LastUpdated TEXT NOT NULL,
        Created TEXT NOT NULL
      );
    `);

        // Create MemorySuggestedTagsRelation Table
        console.log('Creating MemorySuggestedTagsRelation table...');
        await runRun(`
      CREATE TABLE IF NOT EXISTS MemorySuggestedTagsRelation (
        MemoryId INTEGER,
        SuggestedTagId INTEGER,
        PRIMARY KEY (MemoryId, SuggestedTagId),
        FOREIGN KEY (MemoryId) REFERENCES Memories(ID) ON DELETE CASCADE,
        FOREIGN KEY (SuggestedTagId) REFERENCES TagSuggestions(ID) ON DELETE CASCADE
      );
    `);

        // Create Indexes
        console.log('Creating indexes...');
        await runRun('CREATE INDEX IF NOT EXISTS idx_memories_created ON Memories(Created);');
        await runRun('CREATE INDEX IF NOT EXISTS idx_tagsuggestions_tagtext ON TagSuggestions(TagText);');

        console.log('Database initialization completed successfully.');
    } catch (error) {
        console.error('Error initializing database:', error);
        process.exit(1);
    } finally {
        db.close();
    }
}

initializeDatabase();
