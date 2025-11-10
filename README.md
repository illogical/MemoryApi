# Memory API

## Overview
Memory API is a TypeScript/Node.js backend service designed to store, retrieve, and semantically search user memories using vector embeddings and a Retrieval-Augmented Generation (RAG) architecture. It leverages Qdrant for vector storage and LM Studio for text embedding and summarization. The API supports categorization, semantic search, and CRUD operations for memories, making it suitable for personal assistants, knowledge management, and context-aware applications.

## Intentions
- **Semantic Memory Storage:** Store user memories (preferences, reminders, code snippets, history, notes, prompts) as vector embeddings for efficient semantic search and retrieval.
- **RAG Architecture:** Use LM Studio to generate embeddings and summaries, and Qdrant to store and search memories by similarity.
- **Flexible Categorization:** Memories are categorized and tagged for advanced filtering and organization.
- **RESTful API:** Expose endpoints for adding, searching, updating, and deleting memories, as well as retrieving statistics.

## Architecture
- **Express.js API:** Handles HTTP requests and routes for memory operations.
- **Qdrant Vector Database:** Stores memory embeddings and metadata, enabling fast similarity search and filtering.
- **LM Studio SDK:** Generates text embeddings and summaries for memories, supporting RAG workflows.
- **TypeScript Models & Services:** Strongly-typed interfaces for memory objects, modular services for prompt templates and business logic.
- **Dockerized Deployment:** Includes Dockerfile and docker-compose for easy local or cloud deployment.

### Key Components
- `src/samples/qdrantAPI.ts`: Main implementation of the MemoryRAGSystem class and Express API endpoints.
- `src/services/promptTemplateService.ts`: Loads and renders prompt templates for classification and other tasks.
- `src/prompts/classification.txt`: Example prompt template for memory categorization.
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
- `POST /api/memories`: Add a new memory
- `GET /api/memories/category/:category`: Get memories by category
- `POST /api/memories/search`: Semantic search across memories
- `GET /api/memories/tags?tags=tag1,tag2`: Search by tags
- `PUT /api/memories/:id`: Update a memory
- `DELETE /api/memories/:id`: Delete a memory
- `GET /api/memories/stats`: Get category statistics

## Example Usage
See `src/samples/qdrantAPI.ts` for example usage and implementation details.

## Extending the Project
- Add new categories or metadata fields in the `MemoryCategory` enum and `Memory` interface.
- Create new prompt templates in `src/prompts/` and use `PromptTemplateService` for custom tasks.
- Expand API endpoints for additional features (e.g., user authentication, advanced analytics).
- Add auto-tagging and/or sentiment analysis using LM Studio.
