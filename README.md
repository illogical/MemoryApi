# Dependencies

Install runtime dependencies:

```sh
npm install @qdrant/js-client-rest express @types/express @lmstudio/sdk dotenv
```

Install development dependencies:

```sh
npm install -D @types/node typescript ts-node
```
# Memory API

## Overview
Memory API is a TypeScript/Node.js backend service designed to store, retrieve, and semantically search user memories using vector embeddings and a Retrieval-Augmented Generation (RAG) architecture. It leverages Qdrant for vector storage and LM Studio for text embedding, summarization, categorization, and tagging. The API supports categorization, tagging, semantic search, and CRUD operations for memories, making it suitable for personal assistants, knowledge management, and context-aware applications.

## Intentions
- **Semantic Memory Storage:** Store user memories (preferences, reminders, code snippets, history, notes, prompts) as vector embeddings for efficient semantic search and retrieval.
- **RAG Architecture:** Use LM Studio to generate embeddings, summaries, categories, and tags, and Qdrant to store and search memories by similarity.
- **Automatic Categorization & Tagging:** When adding a memory, the system uses LM Studio and prompt templates to automatically classify, tag, and summarize the content in parallel.
- **Flexible Categorization & Tagging:** Memories are categorized and tagged for advanced filtering and organization. Tag-based and category-based search endpoints are available.
- **RESTful API:** Expose endpoints for adding, searching, updating, and deleting memories, as well as retrieving statistics.

## Architecture
- **Express.js API:** Handles HTTP requests and routes for memory operations.
- **Qdrant Vector Database:** Stores memory embeddings and metadata, enabling fast similarity search and filtering.
- **LM Studio SDK:** Generates text embeddings, summaries, categories, and tags for memories, supporting RAG workflows and auto-tagging/categorization.
- **TypeScript Models & Services:** Strongly-typed interfaces for memory objects, modular services for prompt templates and business logic.
- **Dockerized Deployment:** Includes Dockerfile and docker-compose for easy local or cloud deployment.

### Key Components
- `src/samples/qdrantAPI.ts`: Main implementation of the Express API endpoints and usage of the `MemoryRAGSystem` class.
- `src/services/MemoryRAGSystem.ts`: Core business logic for memory storage, semantic search, categorization, tagging, and summary generation.
- `src/services/promptTemplateService.ts`: Loads and renders prompt templates for classification and tagging tasks.
- `src/prompts/classification.txt`, `src/prompts/tagging.txt`: Example prompt templates for memory categorization and tagging.
- `src/index.ts`: Entry point for the Express server.
- `src/routes/`, `src/controllers/`, `src/models/`: Example structure for modular API development.

## Getting Started

### Prerequisites
- Node.js (v20+ recommended)
- Docker (optional, for containerized deployment)
- Qdrant server (local or remote)
- LM Studio running locally with the required embedding model (e.g., `nomic-embed-text-v1.5`)

### Installation
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
   PORT=3000
   ```
4. **Start LM Studio:**
   Ensure LM Studio is running and the embedding model is loaded.
5. **Run the API (development):**
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

## Extending the Project
- Add new categories or metadata fields in the `MemoryCategory` enum and `Memory` interface.
- Create new prompt templates in `src/prompts/` and use `PromptTemplateService` for custom classification or tagging tasks.
- Expand API endpoints for additional features (e.g., user authentication, advanced analytics).
- Add custom auto-tagging, categorization, or sentiment analysis using LM Studio and prompt templates.
