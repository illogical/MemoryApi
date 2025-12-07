import neo4j, { Driver, Session, SessionConfig } from 'neo4j-driver';
import { MemoryWithId } from '../models/memory';
import { MemoryCategory } from '../models/memoryCategory';

export class GraphService {
    private driver: Driver;
    private dbName?: string;

    constructor(uri: string, user: string, pass: string, dbName?: string) {
        this.driver = neo4j.driver(uri, neo4j.auth.basic(user, pass));
        this.dbName = dbName;
    }

    private getSession(mode: 'READ' | 'WRITE' = 'WRITE'): Session {
        const config: SessionConfig = {
            defaultAccessMode: mode === 'READ' ? neo4j.session.READ : neo4j.session.WRITE,
        };
        if (this.dbName) {
            config.database = this.dbName;
        }
        return this.driver.session(config);
    }

    async close(): Promise<void> {
        await this.driver.close();
    }

    /**
     * Initializes constraints and indexes for the graph schema.
     * Call this once during application startup.
     */
    async initializeSchema(): Promise<void> {
        const session = this.getSession();
        try {
            // Constraints
            await session.run(`CREATE CONSTRAINT memory_id_unique IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE`);
            await session.run(`CREATE CONSTRAINT tag_name_unique IF NOT EXISTS FOR (t:Tag) REQUIRE t.name IS UNIQUE`);
            await session.run(`CREATE CONSTRAINT category_name_unique IF NOT EXISTS FOR (c:Category) REQUIRE c.name IS UNIQUE`);

            // Vector Index
            // Note: This requires Neo4j 5.11+ for vector indexes. Adjust dimensions as needed (e.g., 1536 for OpenAI).
            // We'll create it if it doesn't exist.
            const vectorIndexExists = await session.run(`SHOW INDEXES WHERE name = 'memory_embedding_index'`);
            if (vectorIndexExists.records.length === 0) {
                // 384 is a common small model dimension, 1536 for OpenAI. 
                // We will default to 1536 but this should match your embedding model.
                await session.run(`
                    CREATE VECTOR INDEX memory_embedding_index IF NOT EXISTS
                    FOR (m:Memory) ON (m.embedding)
                    OPTIONS {indexConfig: {
                        ` + "`vector.dimensions`" + `: 1536,
                        ` + "`vector.similarity_function`" + `: 'cosine'
                    }}
                `);
            }

            // Fulltext Index
            await session.run(`
                CREATE FULLTEXT INDEX memory_fulltext_index IF NOT EXISTS
                FOR (m:Memory) ON EACH [m.content, m.description]
            `);

            console.log('Graph schema initialized successfully.');
        } catch (error) {
            console.error('Error initializing graph schema:', error);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Upserts a memory into the graph, linking it to Tags and Category.
     * @param memory The memory object.
     * @param embedding The vector embedding for the memory content.
     */
    async upsertMemory(memory: MemoryWithId, embedding?: number[]): Promise<void> {
        const session = this.getSession();
        try {
            const params = {
                id: memory.id,
                content: memory.Content,
                description: memory.Description || '',
                lastUpdated: memory.LastUpdated,
                category: memory.Category ? memory.Category.toString() : 'Uncategorized',
                tags: memory.Tags || [],
                embedding: embedding || [] // Ensure embedding is passed if available
            };

            // Cypher query to merge nodes and relationships
            // 1. Merge Memory node
            // 2. Merge Category node and link
            // 3. Merge Tag nodes and link
            const query = `
                MERGE (m:Memory {id: $id})
                SET m.content = $content,
                    m.description = $description,
                    m.lastUpdated = $lastUpdated
                
                // Only set embedding if it's provided and non-empty
                FOREACH (_ IN CASE WHEN size($embedding) > 0 THEN [1] ELSE [] END |
                    SET m.embedding = $embedding
                )

                // Handle Category
                MERGE (c:Category {name: $category})
                MERGE (m)-[:IN_CATEGORY]->(c)

                // Handle Tags
                FOREACH (tagName IN $tags |
                    MERGE (t:Tag {name: tagName})
                    MERGE (m)-[:TAGGED_WITH]->(t)
                )
            `;

            await session.run(query, params);
            // console.log(`Upserted memory ${memory.id} to graph.`);
        } catch (error) {
            console.error(`Error upserting memory ${memory.id}:`, error);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Performs a vector similarity search yielding top-k results.
     * @param queryVector The embedding vector of the search query.
     * @param topK Number of results to return.
     * @returns Array of memories with similarity scores.
     */
    async vectorSearch(queryVector: number[], topK: number = 10): Promise<Array<{ memory: any, score: number }>> {
        const session = this.getSession('READ');
        try {
            const result = await session.run(`
                CALL db.index.vector.queryNodes('memory_embedding_index', $topK, $queryVector)
                YIELD node, score
                RETURN node AS memory, score
            `, { topK, queryVector });

            return result.records.map(r => ({
                memory: r.get('memory').properties,
                score: r.get('score')
            }));
        } catch (error) {
            console.error('Error in vectorSearch:', error);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Finds related memories based on shared tags and categories.
     * This is a simple recommendation/traversal query.
     * @param memoryId The ID of the memory to find related items for.
     * @param limit Max number of related memories.
     */
    async getRelatedMemories(memoryId: string, limit: number = 5): Promise<any[]> {
        const session = this.getSession('READ');
        try {
            const query = `
                MATCH (m:Memory {id: $memoryId})
                MATCH (m)-[:TAGGED_WITH|IN_CATEGORY]-(relatedNode)-[:TAGGED_WITH|IN_CATEGORY]-(other:Memory)
                WHERE other.id <> $memoryId
                RETURN other, count(relatedNode) as sharedConnections
                ORDER BY sharedConnections DESC
                LIMIT $limit
            `;
            const result = await session.run(query, { memoryId, limit });
            return result.records.map(r => r.get('other').properties);
        } catch (error) {
            console.error('Error in getRelatedMemories:', error);
            throw error;
        } finally {
            await session.close();
        }
    }
}
