import { QdrantClient } from '@qdrant/js-client-rest';
import { LoggingService } from './loggingService';
import { Memory, MemoryWithId } from '../models/memory';
import { MemoryCategory } from '../models/memoryCategory';

export class VectorService {
    private client: QdrantClient;
    private loggingService: LoggingService;
    private readonly COLLECTION_NAME = 'memories';
    private readonly VECTOR_SIZE = 768;

    constructor(qdrantUrl: string, loggingService: LoggingService) {
        this.client = new QdrantClient({ url: qdrantUrl });
        this.loggingService = loggingService;
    }

    async initializeCollection(): Promise<void> {
        this.loggingService.trace('[VectorService.initializeCollection] Called');
        try {
            const collections = await this.client.getCollections();
            const exists = collections.collections.some(
                c => c.name === this.COLLECTION_NAME
            );

            if (!exists) {
                this.loggingService.log(`[VectorService.initializeCollection] Creating collection: ${this.COLLECTION_NAME}`);
                await this.client.createCollection(this.COLLECTION_NAME, {
                    vectors: {
                        size: this.VECTOR_SIZE,
                        distance: 'Cosine'
                    }
                });

                this.loggingService.log('[VectorService.initializeCollection] Creating payload index for Category');
                await this.client.createPayloadIndex(this.COLLECTION_NAME, {
                    field_name: 'Category',
                    field_schema: 'keyword'
                });

                this.loggingService.log('[VectorService.initializeCollection] Creating payload index for Tags');
                await this.client.createPayloadIndex(this.COLLECTION_NAME, {
                    field_name: 'Tags',
                    field_schema: 'keyword'
                });

                this.loggingService.log('[VectorService.initializeCollection] Collection initialized successfully');
            } else {
                this.loggingService.log('[VectorService.initializeCollection] Collection already exists');
            }
        } catch (error) {
            this.loggingService.error(`[VectorService.initializeCollection] Error initializing collection: ${error}`);
            throw error;
        }
    }

    async upsertMemory(memory: Memory, embedding: number[], id: string): Promise<string> {
        this.loggingService.trace('[VectorService.upsertMemory] Called');

        await this.client.upsert(this.COLLECTION_NAME, {
            points: [
                {
                    id: id,
                    vector: embedding,
                    payload: {
                        Content: memory.Content,
                        Description: memory.Description,
                        Tags: memory.Tags,
                        Category: memory.Category,
                        LastUpdated: new Date().toISOString(),
                        SourceType: memory.SourceType,
                        Durability: memory.Durability,
                        Dataset: memory.Dataset,
                        IngestionBatchId: memory.IngestionBatchId,
                        UserReviewed: memory.UserReviewed,
                        Tools: memory.Tools,
                        Projects: memory.Projects,
                        Topics: memory.Topics
                    }
                }
            ]
        });

        return id;
    }

    async getMemoriesByCategory(category: MemoryCategory, limit: number = 10): Promise<MemoryWithId[]> {
        this.loggingService.trace(`[VectorService.getMemoriesByCategory] Called with category: ${category}, limit: ${limit}`);
        const response = await this.client.scroll(this.COLLECTION_NAME, {
            filter: {
                must: [
                    {
                        key: 'Category',
                        match: { value: category }
                    }
                ]
            },
            limit,
            with_payload: true,
            with_vector: false
        });

        return response.points.map(point => ({
            id: point.id.toString(),
            ...(point.payload as unknown as Memory)
        }));
    }

    async searchMemoriesWithEmbedding(queryEmbedding: number[], category?: MemoryCategory, limit: number = 5): Promise<MemoryWithId[]> {
        this.loggingService.trace(`[VectorService.searchMemoriesWithEmbedding] Called with category: ${category}, limit: ${limit}`);
        const filter = category
            ? {
                must: [
                    {
                        key: 'Category',
                        match: { value: category }
                    }
                ]
            }
            : undefined;

        const response = await this.client.search(this.COLLECTION_NAME, {
            vector: queryEmbedding,
            limit,
            filter,
            with_payload: true
        });

        return response.map(result => ({
            id: result.id.toString(),
            ...(result.payload as unknown as Memory),
            score: result.score as number | undefined
        }));
    }

    async searchByTags(tags: string[], category?: MemoryCategory): Promise<MemoryWithId[]> {
        this.loggingService.trace(`[VectorService.searchByTags] Called with tags: ${JSON.stringify(tags)}, category: ${category}`);
        const mustConditions: any[] = [
            {
                key: 'Tags',
                match: { any: tags }
            }
        ];

        if (category) {
            mustConditions.push({
                key: 'Category',
                match: { value: category }
            });
        }

        const response = await this.client.scroll(this.COLLECTION_NAME, {
            filter: { must: mustConditions },
            limit: 100,
            with_payload: true,
            with_vector: false
        });

        return response.points.map(point => ({
            id: point.id.toString(),
            ...(point.payload as unknown as Memory)
        }));
    }

    async updateMemory(id: string, updates: Partial<Memory>, embedding?: number[]): Promise<void> {
        this.loggingService.trace(`[VectorService.updateMemory] Called for ID: ${id}`);

        const points = await this.client.retrieve(this.COLLECTION_NAME, {
            ids: [id],
            with_payload: true,
            with_vector: true
        });

        if (points.length === 0) {
            throw new Error(`Memory with ID ${id} not found`);
        }

        const existingMemory = points[0].payload as unknown as Memory;
        const updatedMemory = {
            ...existingMemory,
            ...updates,
            LastUpdated: new Date().toISOString()
        };

        const vector = embedding || points[0].vector as number[];

        await this.client.upsert(this.COLLECTION_NAME, {
            points: [
                {
                    id,
                    vector,
                    payload: updatedMemory
                }
            ]
        });
    }

    async deleteMemory(id: string): Promise<void> {
        this.loggingService.trace(`[VectorService.deleteMemory] Called for ID: ${id}`);
        await this.client.delete(this.COLLECTION_NAME, {
            points: [id]
        });
    }

    async getMemoryById(id: string): Promise<MemoryWithId | null> {
        this.loggingService.trace(`[VectorService.getMemoryById] Called with ID: ${id}`);
        try {
            const points = await this.client.retrieve(this.COLLECTION_NAME, {
                ids: [id],
                with_payload: true,
                with_vector: false
            });
            if (!points || points.length === 0) {
                return null;
            }
            const point = points[0];
            const memory = point.payload as unknown as Memory;
            return {
                id: point.id.toString(),
                ...memory
            };
        } catch (error) {
            this.loggingService.error(`[VectorService.getMemoryById] Error: ${error}`);
            throw new Error('Failed to retrieve memory by id');
        }
    }

    async getCategoryCounts(): Promise<Record<MemoryCategory, number>> {
        this.loggingService.trace('[VectorService.getCategoryCounts] Called');
        const counts = {} as Record<MemoryCategory, number>;

        for (const category of Object.values(MemoryCategory)) {
            const response = await this.client.count(this.COLLECTION_NAME, {
                filter: {
                    must: [{ key: 'Category', match: { value: category } }]
                },
                exact: true
            });
            counts[category as MemoryCategory] = response.count;
        }

        return counts;
    }

    async getTagFrequency(): Promise<Record<string, number>> {
        this.loggingService.trace('[VectorService.getTagFrequency] Called');
        const frequency: Record<string, number> = {};
        let offset: string | number | null = null;

        while (true) {
            const response = await this.client.scroll(this.COLLECTION_NAME, {
                limit: 100,
                offset: offset ?? undefined,
                with_payload: true,
                with_vector: false
            });

            for (const point of response.points) {
                const tags = (point.payload as any)?.Tags;
                if (Array.isArray(tags)) {
                    for (const tag of tags) {
                        if (typeof tag === 'string') {
                            frequency[tag] = (frequency[tag] || 0) + 1;
                        }
                    }
                }
            }

            if (!response.next_page_offset) break;
            offset = response.next_page_offset;
        }

        return frequency;
    }

    async deleteCollection(): Promise<void> {
        try {
            await this.client.deleteCollection(this.COLLECTION_NAME);
            this.loggingService.log(`Collection '${this.COLLECTION_NAME}' deleted successfully.`);
        } catch (error) {
            this.loggingService.error(`Error deleting collection '${this.COLLECTION_NAME}': ${error}`);
            throw new Error(`Failed to delete collection '${this.COLLECTION_NAME}'.`);
        }
    }

    async getRecordCount(): Promise<number> {
        this.loggingService.trace('[VectorService.getRecordCount] Called');
        try {
            const collectionInfo = await this.client.getCollection(this.COLLECTION_NAME);
            return collectionInfo.points_count ?? 0;
        } catch (error) {
            this.loggingService.error(`[VectorService.getRecordCount] Error: ${error}`);
            throw error;
        }
    }
}
