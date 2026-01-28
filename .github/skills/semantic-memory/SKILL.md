---
name: semantic-memory
description: Long-term semantic memory system for AI agents using MCP. Use when asked to remember preferences, store reminders, save code snippets, recall past context, search personal knowledge, or retrieve relevant information for coding tasks. Enables context persistence across sessions through vector search with automatic categorization and tagging.
license: Complete terms in LICENSE.txt
---

# Semantic Memory for AI Agents

This skill enables GitHub Copilot and other AI agents to store and retrieve long-term memories using a Model Context Protocol (MCP) server backed by vector embeddings and semantic search. Unlike stateless interactions, this provides persistent context across sessions for personal preferences, reminders, code snippets, project history, and more.

## When to Use This Skill

Use the semantic memory tools when the user asks to:

- **Store information**: "Remember that I prefer...", "Save this code snippet for later", "Remind me to...", "Keep a note that..."
- **Retrieve context**: "What are my preferences for...", "Find that code snippet about...", "What did I say about...", "Recall my notes on..."
- **Before coding tasks**: Proactively search for relevant past context (preferences, patterns, decisions) to inform implementation
- **Personal knowledge management**: Store ideas, prompts, checklists, or documentation for future reference

## Prerequisites

- Memory MCP server must be running and connected (verify with your MCP client configuration)
- LM Studio or Ollama must be running with embedding and inference models loaded
- Qdrant vector database must be accessible

## Available Tools

### 1. `add_memory` - Store New Memories

Stores a new memory with automatic categorization, tagging, and summarization. Memories are queued for review before final storage.

**Parameters**:
- `Content` (required): Full memory content, often starting with "Remember..."

**Example Invocations**:

```typescript
// Store a preference
add_memory({
  Content: "I prefer working in the afternoons and find mornings less productive."
})

// Store a reminder
add_memory({
  Content: "Remember that FancyZones is my go-to tool for window management on Windows. Hold Shift while dragging a window to see zones."
})

// Store a code snippet
add_memory({
  Content: "foreach(int i = 0; i < count; i++) { } // C# foreach loop pattern"
})

// Store an idea
add_memory({
  Content: "Idea: Build a fitness tracking app with gamification features."
})
```

**Return Value**:
```json
{
  "id": "uuid-string",
  "message": "Memory queued for review"
}
```

**Categories Recognized**:
- `Preference` - User preferences and settings
- `Reminder` - Time-based or conditional reminders
- `Code Snippet` - Code examples and programming patterns
- `Event` - Time-bound events and occurrences
- `Note` - General notes and observations
- `Prompt` - LLM prompts and templates
- `Idea` - Creative ideas and concepts

### 2. `search_memories` - Semantic Search with Aggregation

Searches memories using vector similarity and intelligently aggregates results for optimal LLM consumption. **Always prefer the `hybrid` strategy** for best results.

**Parameters**:
- `query` (required): Semantic search query describing what you're looking for
- `category` (optional): Filter by category (e.g., "Preference", "Code Snippet")
- `limit` (optional, default 10): Maximum memories to return
- `scoreThreshold` (optional, default 0.7): Minimum similarity score (0-1)
- `strategy` (optional, default "linear"): Aggregation strategy
  - `linear` - Single cohesive summary of all results
  - `cluster-category` - Group and summarize by category
  - `cluster-tag` - Group and summarize by tags
  - **`hybrid` (RECOMMENDED)** - Global summary + category clusters
- `format` (optional, default "both"): Output format
  - `narrative` - Prose summary
  - `bullets` - Bullet-point facts
  - `both` - Both formats

**Example Invocations**:

```typescript
// Search for coding preferences
search_memories({
  query: "programming language preferences and coding style",
  strategy: "hybrid",
  format: "both"
})

// Search for window management tools
search_memories({
  query: "window management utilities and productivity tools",
  category: "Reminder",
  strategy: "hybrid"
})

// Search for past project ideas
search_memories({
  query: "app development ideas and project concepts",
  category: "Idea",
  limit: 5
})

// Broad context search before starting a task
search_memories({
  query: "web development preferences frameworks libraries patterns",
  strategy: "hybrid",
  limit: 15
})
```

**Return Value**:
```json
{
  "topMemories": [
    {
      "id": "uuid",
      "content": "Original memory text",
      "description": "Auto-generated summary",
      "category": "Preference",
      "tags": ["Programming", "Favorite"],
      "score": 0.92,
      "lastUpdated": "2026-01-27T10:30:00Z"
    }
  ],
  "aggregateNarrative": "Prose summary of all results...",
  "aggregateBullets": [
    "- Fact 1 from memories",
    "- Fact 2 from memories"
  ],
  "clusterSummaries": [
    {
      "clusterKey": "Preference",
      "memoryCount": 3,
      "narrative": "Summary of preference memories...",
      "bullets": ["- Preference fact 1", "- Preference fact 2"]
    }
  ],
  "searchContext": {
    "query": "original query",
    "vectorResultCount": 10,
    "graphResultCount": 0
  }
}
```

## Step-by-Step Workflows

### Workflow 1: Store a User Preference

When the user says "Remember that I prefer X" or "I like/dislike Y":

1. Call `add_memory` with the full preference statement as `Content`
2. Confirm storage: "I've saved your preference about X. You can modify it in the review queue before it's committed."

**Example**:
```typescript
// User says: "Remember that I prefer reading science fiction novels with emphasis on space exploration"
add_memory({
  Content: "I prefer reading science fiction and futuristic novels with an emphasis on advanced technology and space exploration and character development."
})
```

### Workflow 2: Store a Reminder

When the user says "Remind me..." or "Remember that [tool/process]...":

1. Call `add_memory` with the full reminder text
2. If time-based, ensure the date/time is included in the content
3. Confirm: "Reminder saved. I'll be able to recall this when you ask about [topic]."

**Example**:
```typescript
// User says: "Remind me that I use FancyZones for window management"
add_memory({
  Content: "Remember that FancyZones is my go-to free software tool/utility for window management on Windows. It is installed as part of Microsoft PowerToys. Hold Shift while dragging a window to see the zone layout and drop the window into a zone."
})
```

### Workflow 3: Retrieve Context Before Coding

**Best Practice**: Before starting any coding task, proactively search for relevant context to inform your implementation.

1. Identify key topics/domains in the user's request
2. Call `search_memories` with a broad query covering those topics
3. Use `strategy: "hybrid"` for comprehensive results
4. Review `aggregateNarrative` and `clusterSummaries` for relevant preferences/patterns
5. Apply discovered context to your implementation

**Example**:
```typescript
// User asks: "Create a REST API endpoint for user authentication"
// Before implementing, search for context:
search_memories({
  query: "API development authentication security preferences patterns frameworks",
  strategy: "hybrid",
  limit: 15
})

// Review results for:
// - Preferred authentication method (JWT, OAuth, etc.)
// - Security standards the user follows
// - Code style preferences
// - Past API patterns used
```

### Workflow 4: Search for Specific Information

When the user asks "What did I say about..." or "Find that note about...":

1. Extract key terms from their question
2. Call `search_memories` with those terms as the query
3. Use `strategy: "hybrid"` for best results
4. If results are too broad, add a `category` filter
5. Present the `aggregateNarrative` or relevant `topMemories` to the user

**Example**:
```typescript
// User asks: "What are my food preferences?"
search_memories({
  query: "food cuisine cooking eating preferences",
  category: "Preference",
  strategy: "hybrid",
  format: "both"
})

// Then present: "Based on your memories: You don't enjoy cooking because it's time-consuming. Your favorite cuisine is Mexican."
```

## Effective Semantic Search Tips

### Query Construction

**Good queries** are descriptive and include synonyms/related terms:
- ✅ "programming language preferences coding style patterns"
- ✅ "window management tools productivity utilities desktop organization"
- ✅ "food cuisine eating cooking preferences favorites"

**Poor queries** are too narrow or use exact phrase matching:
- ❌ "C#" (too narrow, may miss related context)
- ❌ "the exact tool I mentioned before" (not semantic)

### Strategy Selection

| Strategy | When to Use | Output |
|----------|-------------|--------|
| `hybrid` | **Default choice** - provides both overview and categorical breakdown | Global summary + category clusters |
| `linear` | Need single cohesive narrative, no clustering needed | Single summary |
| `cluster-category` | Results span multiple categories, want organized view | Category-based clusters |
| `cluster-tag` | Want to see results grouped by specific topics/entities | Tag-based clusters |

**Recommendation**: Always use `strategy: "hybrid"` unless you have a specific reason not to.

### Filtering

- Use `category` filter when searching for specific memory types:
  - "Code Snippet" - for code examples
  - "Preference" - for user preferences
  - "Reminder" - for reminders and tool notes
- Adjust `limit` based on context window needs (default 10 is usually sufficient)
- Lower `scoreThreshold` (e.g., 0.6) for broader results, raise it (e.g., 0.8) for stricter matches

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Tool not found | Verify MCP server is running (`npm run mcp` in project directory) |
| No results returned | Try lowering `scoreThreshold` or broadening query terms |
| Too many irrelevant results | Add `category` filter or raise `scoreThreshold` |
| Duplicate memories in results | This is expected when using graph + vector search; system automatically merges duplicates |
| `add_memory` returns error | Check that `Content` parameter is provided and is a non-empty string |
| Invalid category error | Use exact category names: "Preference", "Reminder", "Code Snippet", "Event", "Note", "Prompt", "Idea" |

## Best Practices

1. **Proactive Context Retrieval**: Always search for relevant context before implementing features or answering questions
2. **Descriptive Memory Content**: When storing memories, include enough detail for semantic search to find them later
3. **Use Hybrid Strategy**: Prefer `strategy: "hybrid"` for comprehensive results with multiple perspectives
4. **Review Aggregated Summaries**: Use `aggregateNarrative` and `clusterSummaries` instead of reading all `topMemories` individually
5. **Category Filtering**: Use category filters when you know the type of memory you're looking for
6. **Natural Language Queries**: Write queries as natural descriptions, not exact phrase matching

## References

- [Memory API README](../../README.md) - Full API documentation
- [MCP Server Source](../../src/app/memoryMcpServer.ts) - Server implementation details
- [Sample Memories](../../src/samples/seedMemories.json) - Example memory formats
