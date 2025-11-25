import dotenv from 'dotenv';
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { MemoryCategory } from '../models/memoryCategory';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import * as z from 'zod/v4';
import { LoggingService } from '../services/loggingService';

dotenv.config();

const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text-v1.5';

// Initialize logging service
const logger = new LoggingService();

// Instantiate underlying memory system (same core used by REST API)
const memorySystem = new MemoryRAGSystem(
  process.env.QDRANT_URL || 'http://localhost:6333',
  process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL
);

// Create MCP server using modern API
const server = new McpServer({
  name: 'memory-api-mcp',
  version: '0.1.0'
});

// Register search + summarization tool
server.registerTool(
    'search_memories',
    {
      title: 'Search Memories',
      description: 'Semantic memory search with optional summarization/clustering for agent context. Prefer hybrid strategy for best results.',
      inputSchema: {
        query: z.string().describe('Semantic search query text.'),
        category: z.string().describe('Optional memory category filter.').optional(),
        limit: z.number().describe('Max number of memories to consider.').optional(),
        scoreThreshold: z.number().describe('Filter memories below this similarity score.').optional(),
        strategy: z
          .enum(['linear', 'cluster-category', 'cluster-tag', 'hybrid'])
          .describe('Aggregation strategy.')
          .optional(),
        format: z
          .enum(['narrative', 'bullets', 'both'])
          .describe('Summary output format.')
          .optional()
      },
      outputSchema: {
        query: z.string(),
        topMemories: z.array(z.any()),
        aggregateNarrative: z.string().optional(),
        aggregateBullets: z.array(z.string()).optional(),
        clusterSummaries: z.array(z.any()).optional(),
        parameters: z.record(z.string(), z.any())
      }
    },
    async (params: {
      query: string;
      category?: string;
      limit?: number;
      scoreThreshold?: number;
      strategy?: 'linear' | 'cluster-category' | 'cluster-tag' | 'hybrid';
      format?: 'narrative' | 'bullets' | 'both';
    }) => {
      logger.info(`MCP Tool [search_memories] invoked with query: "${params.query}"`);
      const { query, category, limit, scoreThreshold, strategy, format } = params;
      let validCategory: MemoryCategory | undefined = undefined;
      if (category) {
        if (!Object.values(MemoryCategory).includes(category as MemoryCategory)) {
          logger.error(`MCP Tool [search_memories] failed: Invalid category "${category}"`);
          const output = { error: `Invalid category: ${category}` };
          return {
            content: [
              { type: 'text', text: JSON.stringify(output) }
            ],
            structuredContent: output,
            isError: true
          };
        }
        validCategory = category as MemoryCategory;
      }
      try {
        const options = { category: validCategory, limit, scoreThreshold, strategy, format };
        const result = await memorySystem.searchAndSummarizeForMcp(query, options);
        logger.info(`MCP Tool [search_memories] completed successfully, returned ${result.topMemories?.length || 0} memories`);
        return {
          content: [
            { type: 'text', text: JSON.stringify(result, null, 2) },
            { type: 'json', json: result }
          ],
          structuredContent: result
        };
      } catch (error: any) {
        logger.error(`MCP Tool [search_memories] error: ${error?.message || error}`);
        throw error;
      }
    }
  );

// Register add_memory tool (mirrors REST POST /api/memories)
server.registerTool(
  'add_memory',
  {
    title: 'Add Memory',
    description:
      'Store a new personal memory with automatic semantic categorization and tagging for future search and retrieval.',
    inputSchema: z.object({
      Content: z.string().describe('Full content of the memory.'),
      //Metadata: z.record(z.string(), z.any()).describe('Additional metadata.').optional()
    }),
    outputSchema: z.object({
      id: z.string().describe('ID of the created memory.'),
      message: z.string().describe('Status message.'),
      error: z.string().optional().describe('Error message if failed.'),
      validCategories: z.array(z.string()).optional()
    })
  },
  async (params: {
    Description: string;
    Content: string;
    //Metadata?: Record<string, any>;
  }) => {
    logger.info(`MCP Tool [add_memory] invoked with Description: "${params.Description}""`);
    // Validate required fields
    if (!params.Content) {
      logger.error('MCP Tool [add_memory] failed: Missing required fields');
      const output = {
        error: 'Description, Content, and Category are required',
        validCategories: Object.values(MemoryCategory)
      };
      return {
        content: [
          { type: 'text', text: JSON.stringify(output) }
        ],
        structuredContent: output,
        isError: true
      };
    }
    try {
      const memory = {
        Content: params.Content,
        //Metadata: params.Metadata || {},
        LastUpdated: new Date().toISOString()
      };
      const id = await memorySystem.addMemory(memory);
      logger.info(`MCP Tool [add_memory] completed successfully, created memory with ID: ${id}`);
      const output = { id, message: 'Memory created successfully' };
      return {
        content: [
          { type: 'text', text: JSON.stringify(output) },
          { type: 'json', json: output }
        ],
        structuredContent: output
      };
    } catch (error: any) {
      logger.error(`MCP Tool [add_memory] error: ${error?.message || error}`);
      const output = { error: 'Failed to add memory', details: error?.message };
      return {
        content: [
          { type: 'text', text: JSON.stringify(output) }
        ],
        structuredContent: output,
        isError: true
      };
    }
  }
);

async function initialize() {
  logger.info('Initializing Memory MCP server...');
  await memorySystem.loadEmbeddingModel();
  await memorySystem.initializeCollection();
  logger.info('Memory MCP server initialization complete');
}

initialize()
  .then(async () => {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info(`Memory MCP server connected via stdio transport`);
    logger.info(`Using embedding model: ${process.env.EMBEDDING_MODEL || DEFAULT_EMBEDDING_MODEL}`);
  })
  .catch(err => {
    logger.error(`Failed to initialize Memory MCP server: ${err}`);
    //console.error('Failed to initialize Memory MCP server:', err);
    process.exit(1);
  });
