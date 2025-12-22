# Memory API

## Purpose
The primary purpose of the Memory API is to endow AI assistants and agents with **long-term, semantic memory**. By moving beyond simple stateless interactions or limited context windows, this system allows agents to:
1.  **Remember** user preferences, past projects, and specific instructions over time.
2.  **Retrieve** relevant context based on semantic meaning, not just keyword matching.
3.  **Synthesize** fragmented memories into coherent summaries, providing a "working memory" for complex tasks.

This project serves as a backend reference implementation for building **Retrieval-Augmented Generation (RAG)** workflows that are specifically tuned for personal knowledge management and agentic context.

## Overview
Memory API is a TypeScript/Node.js backend service designed to store, retrieve, and semantically search user memories using vector embeddings and a Retrieval-Augmented Generation (RAG) architecture. It leverages Qdrant for vector storage and LM Studio for text embedding, summarization, categorization, and tagging. The API supports categorization, tagging, semantic search, and CRUD operations for memories, making it suitable for personal assistants, knowledge management, and context-aware applications.

## Intentions
- **Semantic Memory Storage:** Store user memories (preferences, reminders, code snippets, history, notes, prompts) as vector embeddings for efficient semantic search and retrieval.
- **RAG Architecture:** Use LM Studio models to generate embeddings, summaries, categories, and tags, and Qdrant to store and search memories by similarity.
- **Automatic Categorization & Tagging:** When adding a memory, the system uses LM Studio and prompt templates to automatically classify, tag, and summarize the content in parallel.
- **Context Synthesis (MCP-Ready):** Beyond simple retrieval, the system aggregates and summarizes search results into concise narratives or bulleted fact lists. This is designed for consumption by other LLMs (e.g., via the Model Context Protocol) to reduce context window noise.
- **Flexible Categorization & Tagging:** Memories are categorized and tagged for advanced filtering and organization. Tag-based and category-based search endpoints are available.
- **RESTful API:** Expose endpoints for adding, searching, updating, and deleting memories, as well as retrieving statistics.

## Architecture
- **Express.js API:** Handles HTTP requests and routes for memory operations.
- **Qdrant Vector Database:** Stores memory embeddings and metadata, enabling fast similarity search and filtering.
- **SQLite Database:** Stores revisions, audit logs, and history for long-term persistence and relational integrity.
- **Neo4j Graph Database (optional):** Persists relationships for graph-driven queries and status reporting; API degrades gracefully if unavailable.
- **LLM + Embeddings Providers (LM Studio or Ollama):** Generates embeddings, summaries, categories, and tags for memories; provider and model are configurable via `.env`.
- **TypeScript Models & Services:** Strongly-typed interfaces for memory objects, modular services for prompt templates and business logic.
- **Dockerized Deployment:** Includes Dockerfile and docker-compose for easy local or cloud deployment.

### Core Services

#### MemoryRAGSystem (src/services/memoryRAGSystem.ts)
The central engine of the application. It orchestrates the interaction between the vector database (Qdrant) and the LLM provider.
-   **Lifecycle Management:** Handles the full pipeline of adding memories: text summarization, auto-classification, auto-tagging, embedding generation, and vector storage.
-   **Search Orchestration:** Manages semantic search queries, filtering by category or tags, and retrieving payload data.
-   **Model Management:** Dynamically loads and unloads embedding and inference models to optimize resource usage.

#### MemoryPostSearchAggregator (src/services/memoryPostSearchAggregator.ts)
A specialized service responsible for **post-retrieval processing**. Raw search results from a vector database can be repetitive or fragmented. This aggregator transforms them into high-quality context.
-   **Strategies:** Supports multiple aggregation strategies:
    -   **Linear:** Summarizes top results into a single narrative or list.
    -   **Cluster (Category/Tag):** Groups memories by metadata and generates focused summaries for each cluster (e.g., "Project Updates", "Personal Preferences").
    -   **Hybrid:** Combines global summaries with detailed cluster breakdowns.
-   **MCP Optimization:** The output is structured specifically for tool use by AI agents (like GitHub Copilot), providing `narrative` (for understanding) and `bullets` (for strict fact adherence).

### Key Components
- [src/app/qdrantAPI.ts](src/app/qdrantAPI.ts): Express router implementing Memory API endpoints backed by `MemoryRAGSystem`.
- [src/services/memoryRAGSystem.ts](src/services/memoryRAGSystem.ts): Core business logic for memory storage, semantic search, categorization, tagging, and summary generation.
- [src/services/memoryPostSearchAggregator.ts](src/services/memoryPostSearchAggregator.ts): Clustering and summarization of search results for LLM consumption.
- [src/services/promptTemplateService.ts](src/services/promptTemplateService.ts): Loads and renders prompt templates for categorization and tagging tasks.
- [src/prompts/categorization.txt](src/prompts/categorization.txt), [src/prompts/tagging.txt](src/prompts/tagging.txt), [src/prompts/aggregation_summary.txt](src/prompts/aggregation_summary.txt): Prompt templates for memory processing.
- [src/app/index.ts](src/app/index.ts): Entry point for the Express server; mounts API routers and serves the review UI.
- [src/routes/](src/routes/), [src/controllers/](src/controllers/), [src/models/](src/models/): Example structure for modular API development.



# Getting Started

## Prerequisites
- Node.js (v20+ recommended)
- Docker (optional, for containerized deployment)
- Qdrant server (local or remote)
- LM Studio running locally with the required embedding model (e.g., `nomic-embed-text-v1.5`)
 - Neo4j (optional, if using graph features)

## Installation
1. **Clone the repository:**
   ```pwsh
   git clone <repo-url>
   cd MemoryApi
   ```
2. **Install dependencies:**
   ```pwsh
   npm install
   ```
3. **Configure environment variables:**
   Create a `.env` file (defaults shown from the codebase). You can override as needed:
   ```env
   PORT=3000
   QDRANT_URL=http://localhost:6333
   EMBEDDING_MODEL=nomic-embed-text:v1.5
   LLM_PROVIDER=ollama
   LLM_MODEL=phi4
   LLM_HOST=http://localhost:11434
   PROMPT_TEMPLATE_BASE_PATH=./prompts
   NEO4J_URI=bolt://localhost:7687
   NEO4J_USER=neo4j
   NEO4J_PASSWORD=password
   ```
   Notes:
   - `PROMPT_TEMPLATE_BASE_PATH` defaults to the local `prompts/` directory if unspecified.
   - Graph features are optional; if Neo4j is unavailable, the API runs in a degraded mode for graph endpoints.
4. **Start LM Studio:**
   Ensure LM Studio is running and the embedding model is loaded.

5. **Load seed memories from sample data:**
   To bulk load the sample seed memories into your system, run the following command (passing the path to the JSON file):
   ```pwsh
   npx tsx src/scripts/loadSeedMemories.ts src/samples/seedMemories.json --report-format=html
   ```
   This will use the `SeedMemoryLoader` to import all memories from the specified JSON file (e.g., `src/samples/seedMemories.json`). You can specify the report format as `html` or `markdown` (default).

6. **Run feedback queries and get memory statistics:**
   To run feedback queries and get statistics or search results, use:
   ```pwsh
   npx tsx src/scripts/memoryFeedback.ts src/samples/feedbackQueries.json --report-format=html
   ```
   You can pass a custom path to your feedback queries JSON file as the second argument. If omitted, it defaults to `src/samples/feedbackQueries.json`. You can also specify the report format as `html` or `markdown` (default).

## Run the API (development):
   ```pwsh
   npm run dev
   ```
   Or use Docker:
   ```pwsh
   docker-compose up --build
   ```

## Raycast Extension - Add Memory
The project includes a **Raycast extension** that allows you to quickly add memories to the review queue directly from your command bar, without switching to a browser or terminal.

### Features
-   **Quick Memory Entry:** Add memories instantly from Raycast with a simple command.
-   **Automatic Metadata Generation:** The API automatically generates a summary, category, and tags for your memory.
-   **Real-time Feedback:** View the generated metadata (category, description, tags) immediately after submission.
-   **Keyboard Shortcuts:** Copy JSON response, memory ID, or content with quick keyboard shortcuts.
-   **Error Handling:** Clear error messages if the API is unavailable or the request fails.

### Installation & Usage
1.  **Install dependencies** in the Raycast extension directory:
    ```pwsh
   cd raycast/add-memory
    npm install
    ```
2.  **Start the Memory API server** (the extension connects to `http://localhost:3000`):
    ```pwsh
    npm run dev
    ```
3.  **Run the Raycast extension** in development mode:
    ```pwsh
    npm run dev
    ```
4.  **Open Raycast** and search for "Add Memory".
5.  **Enter your memory** in the argument field and press Enter.
6.  **Review the results** showing the generated ID, category, description, and tags.
7.  **Use keyboard shortcuts:**
    -   `Cmd+R`: Reload/retry the request
    -   `Cmd+C`: Copy the full JSON response
    -   `Cmd+Shift+C`: Copy the memory ID
    -   `Cmd+Shift+M`: Copy the memory content

The memory will be added to the review queue where you can further refine it using the web frontend before committing it to the vector database.

## Memory Review Frontend
The project includes a web-based frontend for reviewing memories before they are committed to the vector database. This allows you to inspect and modify the automatically generated summaries, categories, and tags.

1.  **Start the API server** (see "Run the API" above).
2.  **Open your browser** and navigate to:
    ```
    http://localhost:3000/
    ```
3.  **Use the interface** to:
    -   View memories currently in the review queue.
    -   Edit the content, description, category, or tags.
    -   Add new tags using the auto-complete feature.
    -   **Save Changes** to update the memory in the queue.
    -   **Add Memory** to commit the memory to the vector database and remove it from the queue.
    -   **Delete** to remove the memory from the queue entirely.

### API Endpoints
— Core memory endpoints
- `POST /api/memories`: Add a new memory. Automatically summarizes, categorizes, and tags content (missing fields are generated).
- `GET /api/memories/:id`: Retrieve a memory by ID.
- `GET /api/memories/category/:category`: Get memories by category with optional `limit`.
- `POST /api/memories/search`: Semantic search with optional category filter and `limit`.
- `GET /api/memories/tags?tags=tag1,tag2[&category=...]`: Search by tags with optional category filter.
- `PUT /api/memories/:id`: Update a memory (partial updates supported).
- `DELETE /api/memories/:id`: Delete a memory by ID.
- `GET /api/memories/stats`: Get category statistics.
- `POST /api/memories/search-and-summarize`: Semantic search with post-retrieval aggregation for MCP-style outputs. Accepts `query` (required) plus `category`, `limit`, `scoreThreshold`, `strategy` (`linear` | `cluster-category` | `cluster-tag` | `hybrid`), and `format` (`narrative` | `bullets` | `both`).

— Review queue endpoints
- `POST /api/review/queue`: Add a new memory to the review queue (generates summary, category, tags).
- `GET /api/review/queue`: Get all queued memories.
- `PUT /api/review/queue/:id`: Update a queued memory (validates `Category`).
- `DELETE /api/review/queue/:id`: Remove a memory from the queue.
- `POST /api/review/commit/:id`: Commit a queued memory to vector storage.
- `GET /api/review/categories`: List available categories.
- `GET /api/review/tags`: List all known tags (for auto-complete).

— Status endpoints
- `GET /api/status`: Overall status for vector and graph stores.
- `GET /api/status/vector`: Vector DB status and count.
- `GET /api/status/graph`: Graph DB status and count.

## Run the MCP Server
The project provides a Model Context Protocol (MCP) server so VS Code (or any MCP-compatible client) can call a tool that performs semantic memory search plus summarization/clustering.

1. Install dependencies (if not already):
   ```pwsh
   npm install
   ```
2. Start LM Studio with the embedding + inference models defined in your `.env`.
3. Launch the MCP server:
   ```pwsh
   npm run mcp
   ```
4. In VS Code, use an MCP-capable extension/client and register this server via a command that starts the process (`npm run mcp`). The tools exposed are:
   - `search_memories` — accepts:
   - `query` (required)
   - `category` (optional enum of categories)
   - `limit`, `scoreThreshold`
   - `strategy`: `linear` | `cluster-category` | `cluster-tag` | `hybrid`
   - `format`: `narrative` | `bullets` | `both`
   - `add_memory` — accepts:
      - `Content` (required): Full memory content to store. This queues the memory in the review workflow and returns the queued item ID.

`search_memories` returns a JSON payload containing `topMemories`, optional `aggregateNarrative`, `aggregateBullets`, and any `clusterSummaries` depending on strategy, mirroring the REST endpoint `POST /api/memories/search-and-summarize`.

## Example Usage
See [src/app/qdrantAPI.ts](src/app/qdrantAPI.ts) for example usage and implementation details. When adding a memory, you may omit `Description`, `Category`, or `Tags`—the system will generate them automatically if missing.

# Dependencies
Install runtime dependencies:

```sh
npm install @qdrant/js-client-rest express @lmstudio/sdk dotenv neo4j-driver @modelcontextprotocol/sdk zod @types/express
```

Install development dependencies:

```sh
npm install -D typescript ts-node-dev nodemon
```

## HTTP File Testing in VS Code
To easily test API endpoints using the provided `.http` files (such as `src/samples/memoryApiTest.http`), install the **REST Client** extension for VS Code:

- Extension: [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client)
- After installation, open any `.http` file and click the `Send Request` link above each request to execute it directly in VS Code and view the response inline.

This is useful for quickly verifying your API endpoints during development.


## Tag & Category Evaluation
A reports are generated to evaluate the performance of the auto-tagging and auto-categorization features. This allows different models, providers, and prompts to be benchmarked. The results are output as detailed markdown reports in the `reports/` directory.

To evaluate the performance of the auto-tagging functionality, use the provided evaluation script:
```pwsh
npx tsx src/scripts/evaluateTagging.ts --model=phi-4 --provider=lmstudio
```

To evaluate the performance of the auto-categorization functionality, use the provided evaluation script:
```pwsh
npx tsx src/scripts/evaluateCategorization.ts --model=phi-4 --provider=lmstudio
```

*Supported Providers:*
- `lmstudio`
- `ollama`

## Report Generation
The system generates detailed reports for various operations (ingestion, feedback, evaluation). By default, reports are generated in Markdown format. You can switch to HTML format by using the `--report-format=html` flag with the supported scripts.

Supported scripts:
- `src/scripts/loadSeedMemories.ts`
- `src/scripts/memoryFeedback.ts`
- `src/scripts/evaluateSemanticQueries.ts`

Example:
```pwsh
npx tsx src/scripts/memoryFeedback.ts --report-format=html
```

### Extending the Project
- Add new categories or metadata fields in the `MemoryCategory` enum and `Memory` interface.
- Create new prompt templates in `src/prompts/` and use `PromptTemplateService` for custom classification or tagging tasks.
- Expand API endpoints for additional features (e.g., user authentication, advanced analytics).
- Add custom auto-tagging, categorization, or sentiment analysis using LM Studio and prompt templates.
