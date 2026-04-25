import { QdrantClient } from '@qdrant/js-client-rest';
import { config } from '../services/configService.js';
import { SqlService } from '../services/sqlService.js';
import { GraphService } from '../services/graphService.js';

const COLLECTION_NAME = config.QDRANT_COLLECTION_NAME;

async function migrateCreatedTimestamp(): Promise<void> {
    const sqlService = new SqlService();
    const graphService = new GraphService(config.NEO4J_URI, config.NEO4J_USER, config.NEO4J_PASSWORD, config.NEO4J_DATABASE);
    const qdrantClient = new QdrantClient({ url: config.QDRANT_URL });

    try {
        console.log('Fetching all memories from SQLite...');
        const memories = await sqlService.getAllMemories();
        console.log(`Found ${memories.length} memories.`);

        // --- Qdrant: patch Created into existing point payloads ---
        const qdrantUpdates = memories.filter(m => m.VectorId && m.Created);
        console.log(`Patching Created into ${qdrantUpdates.length} Qdrant points...`);

        for (const mem of qdrantUpdates) {
            await qdrantClient.setPayload(COLLECTION_NAME, {
                payload: { Created: mem.Created },
                points: [mem.VectorId]
            });
        }
        console.log('Qdrant payloads updated.');

        // --- Qdrant: create datetime index for Created (idempotent) ---
        console.log('Creating Qdrant datetime index for Created...');
        await qdrantClient.createPayloadIndex(COLLECTION_NAME, {
            field_name: 'Created',
            field_schema: 'datetime'
        });
        console.log('Qdrant index created.');

        // --- Neo4j: set created = lastUpdated for nodes missing it ---
        console.log('Backfilling created on Neo4j Memory nodes where null...');
        await graphService.runQuery(`
            MATCH (m:Memory)
            WHERE m.created IS NULL
            SET m.created = m.lastUpdated
        `);
        console.log('Neo4j backfill complete.');

        // --- Neo4j: ensure index exists (initializeSchema may not have run for existing DB) ---
        console.log('Ensuring Neo4j created index exists...');
        await graphService.runQuery(
            `CREATE INDEX memory_created_index IF NOT EXISTS FOR (m:Memory) ON (m.created)`
        );
        console.log('Neo4j index ensured.');

        console.log('Migration complete.');
    } finally {
        await graphService.close();
    }
}

migrateCreatedTimestamp().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
