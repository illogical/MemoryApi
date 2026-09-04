import { ReviewMemoriesService } from '../services/reviewMemoriesService';
import { MemoryRAGSystem } from '../services/memoryRAGSystem';
import { SqlService } from '../services/sqlService';
import { MemoryCategory } from '../models/memoryCategory';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { LoggingService } from '../services/loggingService';


// Initialize logging service
const logger = new LoggingService();

// Instantiate underlying memory system (same core used by REST API)
const memorySystem = new MemoryRAGSystem();
const sqlService = new SqlService();

// Create MCP server using modern API
const server = new McpServer({
  name: 'memory-api-mcp',
  version: '0.1.0'
});

// Register search + summarization tool
server.tool(
  'search_memories',
  'Semantic memory search with optional summarization/clustering for agent context. Prefer hybrid strategy for best results.',
  {
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
  } as any,
  async (args: any) => {
    logger.info(`MCP Tool [search_memories] invoked with query: "${args.query}"`);
    const { query, category, limit, scoreThreshold, strategy, format } = args;
    let validCategory: MemoryCategory | undefined = undefined;
    if (category) {
      if (!Object.values(MemoryCategory).includes(category as MemoryCategory)) {
        logger.error(`MCP Tool [search_memories] failed: Invalid category "${category}"`);
        const output = { error: `Invalid category: ${category}` };
        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(output) }
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
          { type: 'text' as const, text: JSON.stringify(result, null, 2) }
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
server.tool(
  'add_memory',
  'Store a new personal memory with automatic semantic categorization and tagging for future search and retrieval.',
  {
    Content: z.string().describe('Full content of the memory to be stored. Often initiated by "Remember..." ')
  } as any,
  async (args: any) => {
    logger.info(`MCP Tool [add_memory] invoked with Content: "${args.Content}"`);
    try {
      // Use ReviewMemoriesService to queue memory for review
      const reviewService = new ReviewMemoriesService(memorySystem);
      const memory = {
        Content: args.Content,
        LastUpdated: new Date().toISOString()
      };
      const queuedItem = await reviewService.addToQueue(memory);
      logger.info(`MCP Tool [add_memory] completed successfully, queued memory with ID: ${queuedItem.id}`);
      const output = { id: queuedItem.id, message: 'Memory queued for review' };
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(output) }
        ],
        structuredContent: output
      };
    } catch (error: any) {
      logger.error(`MCP Tool [add_memory] error: ${error?.message || error}`);
      const output = { error: 'Failed to queue memory', details: error?.message };
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(output) }
        ],
        structuredContent: output,
        isError: true
      };
    }
  }
);

// Register list_all_memories tool — admin-level export of all stored memories
server.tool(
  'list_all_memories',
  'List all stored memories with optional filtering by category. Returns ID, Content, Category, Tags, Tools, Projects, and IngestionBatchId per record.',
  {
    category: z.string().describe('Filter by memory category.').optional()
  } as any,
  async (args: any) => {
    logger.info(`MCP Tool [list_all_memories] invoked`);
    try {
      const memories = await sqlService.getAllMemories({
        category: args.category
      });
      logger.info(`MCP Tool [list_all_memories] returning ${memories.length} memories`);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(memories, null, 2) }],
        structuredContent: { memories }
      };
    } catch (error: any) {
      logger.error(`MCP Tool [list_all_memories] error: ${error?.message || error}`);
      throw error;
    }
  }
);

async function main() {
  try {
    // Initialize transport first
    const transport = new StdioServerTransport();

    // Connect server to transport - this must happen before any async initialization
    await server.connect(transport);
    logger.info('Memory MCP server connected via stdio transport');

    // Initialize memory system after connection (non-blocking background task)
    memorySystem.initialize()
      .then(() => {
        logger.info('Memory system initialized successfully');
      })
      .catch(err => {
        logger.error(`Warning: Memory system initialization is degraded: ${err.message}`);
      });

    logger.info('Memory MCP server ready');
  } catch (err) {
    logger.error(`Failed to start Memory MCP server: ${err}`);
    process.exit(1);
  }
}

main();
