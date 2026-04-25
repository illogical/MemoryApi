import sqlite3 from 'sqlite3';
import { config } from '../services/configService';
import fs from 'fs';

sqlite3.verbose();

async function migrateStatuses(): Promise<void> {
    const dbPath = config.SQLITE_DB_PATH;
    console.log(`[migrateMemoryStatuses] Migrating statuses in: ${dbPath}`);

    if (!fs.existsSync(dbPath)) {
        console.log(`[migrateMemoryStatuses] Database not found at ${dbPath}. Nothing to migrate.`);
        return;
    }

    const db = new sqlite3.Database(dbPath);

    const run = (sql: string, params: any[] = []): Promise<void> =>
        new Promise((resolve, reject) => {
            db.run(sql, params, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

    const get = (sql: string): Promise<any> =>
        new Promise((resolve, reject) => {
            db.get(sql, (err, row) => {
                if (err) reject(err);
                else resolve(row);
            });
        });

    try {
        // Old 'New' → 'draft'
        await run(`UPDATE Memories SET Status = 'draft' WHERE Status = 'New'`);
        const draftCount = await get(`SELECT COUNT(*) as count FROM Memories WHERE Status = 'draft'`);
        console.log(`  New → draft: ${draftCount?.count ?? 0} rows`);

        // Old 'Reviewed' → 'stored'
        await run(`UPDATE Memories SET Status = 'stored' WHERE Status = 'Reviewed'`);
        const storedCount = await get(`SELECT COUNT(*) as count FROM Memories WHERE Status = 'stored'`);
        console.log(`  Reviewed → stored: ${storedCount?.count ?? 0} rows`);

        // 'Archived' → 'archived' (same semantic, lowercase)
        await run(`UPDATE Memories SET Status = 'archived' WHERE Status = 'Archived'`);
        const archivedCount = await get(`SELECT COUNT(*) as count FROM Memories WHERE Status = 'archived'`);
        console.log(`  Archived → archived: ${archivedCount?.count ?? 0} rows`);

        console.log('[migrateMemoryStatuses] Migration complete.');
    } finally {
        db.close();
    }
}

migrateStatuses().catch((err) => {
    console.error('[migrateMemoryStatuses] Error:', err);
    process.exit(1);
});
