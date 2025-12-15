import neo4j, { Driver, Session, SessionConfig } from 'neo4j-driver';
import { MemoryWithId } from '../models/memory';

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

    async initializeSchema(): Promise<void> {
        const session = this.getSession();
        try {
            // Uniqueness Constraints
            await session.run(`CREATE CONSTRAINT memory_id_unique IF NOT EXISTS FOR (m:Memory) REQUIRE m.id IS UNIQUE`);
            await session.run(`CREATE CONSTRAINT tag_name_unique IF NOT EXISTS FOR (t:Tag) REQUIRE t.name IS UNIQUE`);
            await session.run(`CREATE CONSTRAINT category_name_unique IF NOT EXISTS FOR (c:Category) REQUIRE c.name IS UNIQUE`);

            // Index for faster lookups
            await session.run(`CREATE INDEX memory_last_updated_index IF NOT EXISTS FOR (m:Memory) ON (m.lastUpdated)`);

            // Vector Index
            const vectorIndexExists = await session.run(`SHOW INDEXES WHERE name = 'memory_embedding_index'`);
            if (vectorIndexExists.records.length === 0) {
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
                embedding: embedding || []
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
                
                FOREACH (_ IN CASE WHEN size($embedding) > 0 THEN [1] ELSE [] END |
                    SET m.embedding = $embedding
                )

                // Category Relationship
                MERGE (c:Category {name: $category})
                MERGE (m)-[:IN_CATEGORY]->(c)

                // Tag Relationships
                FOREACH (tagName IN $tags |
                    MERGE (t:Tag {name: tagName})
                    MERGE (m)-[:TAGGED_WITH]->(t)
                )
            `;

            await session.run(query, params);
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
     * Enhanced traversal to find related memories based on shared tags and categories.
     * Weighs tags higher than category. Returns aggregated score.
     * @param memoryId The ID of the memory to find related items for.
     * @param limit Max number of related memories. 
     * @returns Array of related memories with aggregated scores.
     */
    async getRelatedMemories(memoryId: string, limit: number = 5): Promise<Array<{ memory: any, score: number }>> {
        const session = this.getSession('READ');
        try {
            const query = `
                MATCH (m:Memory {id: $memoryId})
                
                // Find memories sharing tags
                OPTIONAL MATCH (m)-[:TAGGED_WITH]->(t:Tag)<-[:TAGGED_WITH]-(otherTag:Memory)
                WHERE otherTag.id <> $memoryId
                WITH otherTag, count(t) * 2 AS tagScore // Tags weighted x2

                // Find memories sharing category
                OPTIONAL MATCH (m)-[:IN_CATEGORY]->(c:Category)<-[:IN_CATEGORY]-(otherCat:Memory)
                WHERE otherCat.id <> $memoryId
                WITH collect({node: otherTag, score: tagScore}) as tagNodes, otherCat, 1 AS catScore

                // Combine results
                UNWIND (
                    [n IN tagNodes | {node: n.node, score: n.score}] + 
                    [{node: otherCat, score: 1}]
                ) AS item
                
                WITH item.node AS other, sum(item.score) AS totalScore
                WHERE other IS NOT NULL
                RETURN other, totalScore
                ORDER BY totalScore DESC
                LIMIT $limit
            `;

            const result = await session.run(query, { memoryId, limit });
            return result.records.map(r => ({
                memory: r.get('other').properties,
                score: r.get('totalScore').toNumber()
            }));
        } catch (error) {
            console.error('Error in getRelatedMemories:', error);
            throw error;
        } finally {
            await session.close();
        }
    }

    /**
     * Finds memories that have specific tags.
     */
    async getMemoriesByTags(tags: string[]): Promise<any[]> {
        const session = this.getSession('READ');
        try {
            const query = `
                MATCH (m:Memory)-[:TAGGED_WITH]->(t:Tag)
                WHERE t.name IN $tags
                RETURN m, count(t) as matchCount
                ORDER BY matchCount DESC
            `;
            const result = await session.run(query, { tags });
            return result.records.map(r => r.get('m').properties);
        } catch (error) {
            console.error('Error in getMemoriesByTags:', error);
            throw error;
        } finally {
            await session.close();
        }
    }
    async deleteMemory(id: string): Promise<void> {
        const session = this.getSession();
        try {
            await session.run(`
                MATCH (m:Memory {id: $id})
                DETACH DELETE m
            `, { id });
        } catch (error) {
            console.error(`Error deleting memory ${id}:`, error);
            throw error;
        } finally {
            await session.close();
        }
    }

    async getRelationshipCount(): Promise<number> {
        const session = this.getSession('READ');
        try {
            const result = await session.run('MATCH ()-[r]->() RETURN count(r) as count');
            if (result.records.length === 0) return 0;
            const count = result.records[0].get('count');
            return count.toNumber();
        } catch (error) {
            console.error('Error getting relationship count:', error);
            throw error;
        } finally {
            await session.close();
        }
    }
}
