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
- **LM Studio SDK:** Generates text embeddings, summaries, categories, and tags for memories, supporting RAG workflows and auto-tagging/categorization.
- **TypeScript Models & Services:** Strongly-typed interfaces for memory objects, modular services for prompt templates and business logic.
- **Dockerized Deployment:** Includes Dockerfile and docker-compose for easy local or cloud deployment.

### Core Services

#### MemoryRAGSystem (`src/services/MemoryRAGSystem.ts`)
The central engine of the application. It orchestrates the interaction between the vector database (Qdrant) and the LLM provider.
-   **Lifecycle Management:** Handles the full pipeline of adding memories: text summarization, auto-classification, auto-tagging, embedding generation, and vector storage.
-   **Search Orchestration:** Manages semantic search queries, filtering by category or tags, and retrieving payload data.
-   **Model Management:** Dynamically loads and unloads embedding and inference models to optimize resource usage.

#### MemoryPostSearchAggregator (`src/services/MemoryPostSearchAggregator.ts`)
A specialized service responsible for **post-retrieval processing**. Raw search results from a vector database can be repetitive or fragmented. This aggregator transforms them into high-quality context.
-   **Strategies:** Supports multiple aggregation strategies:
    -   **Linear:** Summarizes top results into a single narrative or list.
    -   **Cluster (Category/Tag):** Groups memories by metadata and generates focused summaries for each cluster (e.g., "Project Updates", "Personal Preferences").
    -   **Hybrid:** Combines global summaries with detailed cluster breakdowns.
-   **MCP Optimization:** The output is structured specifically for tool use by AI agents (like GitHub Copilot), providing `narrative` (for understanding) and `bullets` (for strict fact adherence).

### Key Components
- `src/samples/qdrantAPI.ts`: Main implementation of the Express API endpoints and usage of the `MemoryRAGSystem` class.
- `src/services/MemoryRAGSystem.ts`: Core business logic for memory storage, semantic search, categorization, tagging, and summary generation.
- `src/services/MemoryPostSearchAggregator.ts`: Logic for clustering and summarizing search results for LLM consumption.
- `src/services/promptTemplateService.ts`: Loads and renders prompt templates for classification and tagging tasks.
- `src/prompts/classification.txt`, `src/prompts/tagging.txt`, `src/prompts/memory_summary.txt`: Prompt templates for memory processing.
- `src/index.ts`: Entry point for the Express server.
- `src/routes/`, `src/controllers/`, `src/models/`: Example structure for modular API development.



# Getting Started

## Prerequisites
- Node.js (v20+ recommended)
- Docker (optional, for containerized deployment)
- Qdrant server (local or remote)
- LM Studio running locally with the required embedding model (e.g., `nomic-embed-text-v1.5`)

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
   Create a `.env` file with:
   ```env
   QDRANT_URL=http://localhost:6333
   EMBEDDING_MODEL=nomic-embed-text-v1.5
   SUMMARIZATION_MODEL=llama-3.2-3b-instruct
   CLASSIFICATION_MODEL=llama-3.2-3b-instruct
   TAGGING_MODEL=llama-3.2-3b-instruct
   ```
4. **Start LM Studio:**
   Ensure LM Studio is running and the embedding model is loaded.

5. **Load seed memories from sample data:**
   To bulk load the sample seed memories into your system, run the following command (passing the path to the JSON file):
   ```pwsh
   npx tsx src/scripts/loadSeedMemories.ts src/samples/seedMemories.json
   ```
   This will use the `SeedMemoryLoader` to import all memories from the specified JSON file (e.g., `src/samples/seedMemories.json`).

6. **Run feedback queries and get memory statistics:**
   To run feedback queries and get statistics or search results, use:
   ```pwsh
   npx tsx src/scripts/memoryFeedback.ts src/samples/feedbackQueries.json
   ```
   You can pass a custom path to your feedback queries JSON file as the second argument. If omitted, it defaults to `src/samples/feedbackQueries.json`.

## Run the API (development):
   ```pwsh
   npm run dev
   ```
   Or use Docker:
   ```pwsh
   docker-compose up --build
   ```

### API Endpoints
- `POST /api/memories`: Add a new memory. The API will automatically summarize, categorize, and tag the memory content using LM Studio and prompt templates. Required fields: `Description`, `Content`, and `Category`.
- `GET /api/memories/category/:category`: Get memories by category. Returns all memories in the specified category.
- `POST /api/memories/search`: Semantic search across memories. Finds memories similar to the provided query, optionally filtered by category.
- `GET /api/memories/tags?tags=tag1,tag2`: Search by tags. Returns memories matching any of the provided tags, optionally filtered by category.
- `PUT /api/memories/:id`: Update a memory. Allows partial updates to memory fields.
- `DELETE /api/memories/:id`: Delete a memory by ID.
- `GET /api/memories/stats`: Get category statistics. Returns counts of memories per category.

## Example Usage
See `src/samples/qdrantAPI.ts` for example usage and implementation details. When adding a memory, you may omit `Description`, `Category`, or `Tags`—the system will generate them automatically if missing.

# Dependencies
Install runtime dependencies:

```sh
npm install @qdrant/js-client-rest express @types/express @lmstudio/sdk dotenv
```

Install development dependencies:

```sh
npm install -D @types/node typescript ts-node
```

## HTTP File Testing in VS Code
To easily test API endpoints using the provided `.http` files (such as `src/samples/memoryApiTest.http`), install the **REST Client** extension for VS Code:

- Extension: [REST Client](https://marketplace.visualstudio.com/items?itemName=humao.rest-client)
- After installation, open any `.http` file and click the `Send Request` link above each request to execute it directly in VS Code and view the response inline.

This is useful for quickly verifying your API endpoints during development.

## Extending the Project
- Add new categories or metadata fields in the `MemoryCategory` enum and `Memory` interface.
- Create new prompt templates in `src/prompts/` and use `PromptTemplateService` for custom classification or tagging tasks.
- Expand API endpoints for additional features (e.g., user authentication, advanced analytics).
- Add custom auto-tagging, categorization, or sentiment analysis using LM Studio and prompt templates.
