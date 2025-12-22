# SQLite Database Integration Summary

## Core Architecture
- **Provider**: `sqlite3` driver.
- **Initialization**: `src/scripts/initDb.ts` handles schema creation, indices, and directory setup (`data/memory.db`).
- **Service Layer**: `src/services/sqlService.ts` provides a promisified wrapper for CRUD operations.

## Database Schema
- **`Memories`**: Primary relational storage for memory content, metadata, and timestamps. Includes `Status` and `Deleted` (soft-delete) flags.
- **`MemoryDatabaseRelations`**: Managed join table linking SQL `MemoryId` to external `GraphId` (Neo4j) and `VectorId` (Qdrant).
- **`TagSuggestions`**: Deduplicated storage for suggested tags (always lowercased).
- **`MemorySuggestedTagsRelation`**: Join table tracking tag suggestions per memory.
- **`MemoryHistory`**: Versioning table for memories; stores snapshots of content and metadata for every revision.
- **`SearchHistory`**: Logs semantic search queries, results (vector/graph), the summarization prompt (`MergePrompt`), and the final aggregate summary (`MergeSummary`). Useful for RAG evaluation.

## Integration Points
- **Orchestrator**: `RAGOrchestrator` includes `SqlService` for relational tracking alongside Vector/Graph stores.
- **System**: `MemoryRAGSystem` exposes SQL status and record counts.
- **API**: `/api/status/sql` provides real-time health and record counts.
- **Aggregator**: `MemoryPostSearchAggregator` automatically logs search intent and LLM-generated summaries to `SearchHistory`.
- **UI**: Dashboard status bar includes a "SQL DB" pill showing "Active (X History)".

## Key Methods in `SqlService`
- `addMemory`: Inserts to `Memories`, initializes relations, and records initial history. Supports `Status` (New/Reviewed).
- `updateMemory`: Updates content/tags/category/description, sets `LastUpdated`, and records a new history snapshot.
- `softDeleteMemory`: Sets `Deleted = 1` to hide records without removing them from history.
- `updateMemoryRelations`: Updates Graph/Vector IDs for a memory.
- `addTagSuggestion`: Idempotent insertion (returns existing ID if tag exists).
- `getMemoriesByStatus`: Retrieves non-deleted memories by their workflow status.
- `getMemoryCount`: Returns total count of non-deleted records from `Memories` table.
- `addSearchHistory`: Records the full context of a RAG query, including the raw results and the prompt sent to the LLM for aggregation.

## Verification
- `src/scripts/testSql.ts` validates the core SQL operations and schema constraints.
- `src/scripts/testSearchHistory.ts` validates the `SearchHistory` logging flow.

---

# Walkthrough - Memory Review Refactor to SQLite

I have completed the refactoring of the memory review system to use the SQLite database instead of a local JSON file. This ensures better data integrity, history tracking, and scalability.

## Changes

### Database Schema
#### [initDb.ts](file:///c:/LocalDev/Projects/MemoryApi/src/scripts/initDb.ts)
- **Memories Table**: Added `Status` (default 'New') and `Deleted` (default 0) columns.
- **MemoryHistory Table**: Renamed from `MemoryReview`, removed `LastUpdated`. Used for tracking memory versions.

### Backend Services
#### [sqlService.ts](file:///c:/LocalDev/Projects/MemoryApi/src/services/sqlService.ts)
- Implemented `addMemory` with history tracking.
- Implemented `updateMemory` with history tracking.
- Implemented `softDeleteMemory`.
- Implemented `getMemoriesByStatus`.
- Removed legacy `MemoryReview` methods.

#### [reviewMemoriesService.ts](file:///c:/LocalDev/Projects/MemoryApi/src/services/reviewMemoriesService.ts)
- Switched from file-based `memoryQueue.json` to `SqlService`.
- `addToQueue` now inserts into DB.
- `commitMemory` updates status to 'Reviewed' and triggers Vector/Graph ingestion.
- `deleteFromQueue` performs a soft delete in DB.

#### [memoryRAGSystem.ts](file:///c:/LocalDev/Projects/MemoryApi/src/services/memoryRAGSystem.ts)
- Exposed `getSqlService()` to allow `ReviewMemoriesService` to share the database connection.

## Verification Results

### Automated Verification
I verified the end-to-end flow confirms:
1. **Adding**: Memories are added to SQLite with status 'New' and a history record is created.
2. **Retrieving**: Queue correctly pulls 'New' memories from DB.
3. **Updating**: Updates produce a new history record and update the main table.
4. **Committing**: Status changes to 'Reviewed', and the memory is passed to the orchestration layer.
5. **Deleting**: Memory is soft-deleted (Deleted=1) and correctly removed from the queue view.

---

# Walkthrough - Search History & RAG Evaluation

I have added a `SearchHistory` table to provide traceability for semantic searches. This allows analyzing what results were returned for specific queries and how they were summarized by the LLM.

## Changes

- **Schema Update**: Added `SearchHistory` table in `initDb.ts`.
- **Logging Integration**: `MemoryPostSearchAggregator` now captures the `MergePrompt` and resulting summary, saving them directly to SQLite during the `searchAndSummarizeForMcp` flow.
- **Infrastructure**: Injected `SqlService` into the aggregator via `MemoryRAGSystem`.

## Verification
- **Test Script**: `src/scripts/testSearchHistory.ts` confirms that searches are correctly recorded with JSON-serialized results and raw prompt text.
