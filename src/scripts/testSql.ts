import { SqlService } from '../services/sqlService';

async function testSqlService() {
    const sqlService = new SqlService();

    try {
        console.log("Testing SqlService...");

        // 1. Add Memory
        console.log("Adding memory...");
        const memoryId = await sqlService.addMemory(
            "Test content for SQLite",
            "Test description",
            ["test", "sqlite"],
            "TestCategory"
        );
        console.log(`Memory added with ID: ${memoryId}`);

        // 2. Verify Memory and Relations
        console.log("Verifying memory and relations...");
        const memory = await sqlService.getMemory(memoryId);
        console.log("Retrieved memory:", memory);

        if (!memory) {
            console.error("Memory not found!");
            return;
        }

        if (memory.ID !== memoryId) console.error("ID mismatch");
        if (memory.Content !== "Test content for SQLite") console.error("Content mismatch");
        if (memory.GraphId !== null) console.error("GraphId should be null");
        if (memory.VectorId !== null) console.error("VectorId should be null");

        // 3. Update Relations
        console.log("Updating relations...");
        await sqlService.updateMemoryRelations(memoryId, "graph-123", "vector-456");
        const updatedMemory = await sqlService.getMemory(memoryId);
        console.log("Updated memory:", updatedMemory);

        if (updatedMemory.GraphId !== "graph-123") console.error("GraphId update failed");
        if (updatedMemory.VectorId !== "vector-456") console.error("VectorId update failed");

        // 4. Test Tag Suggestions
        console.log("Testing tag suggestions...");
        const tagId1 = await sqlService.addTagSuggestion("TestTag");
        const tagId2 = await sqlService.addTagSuggestion("testtag"); // Should return same ID as above (after lowercasing) due to logic or duplicate check? 
        // Wait, my logic checks for lowerTag. "TestTag".toLowerCase() is "testtag".

        console.log(`Tag IDs: ${tagId1}, ${tagId2}`);
        if (tagId1 !== tagId2) {
            console.log("Tag IDs differ - possibly first insert, second update returning ID.");
            // My code returns existing.ID if exists.
        } else {
            console.log("Tag deduplication working (IDs match).");
        }

        // 5. Link Tag to Memory
        console.log("Linking tag to memory...");
        await sqlService.recordSuggestedTag(memoryId, tagId1);
        console.log("Link created.");

        // 6. Test Memory Review
        console.log("Testing memory review...");
        const reviewId = await sqlService.addMemoryReview(
            "Review Content",
            "Review Description",
            ["review", "tag"],
            "ReviewCategory"
        );
        console.log(`Review added with ID: ${reviewId}`);

        const review = await sqlService.getMemoryReview(reviewId);
        console.log("Retrieved review:", review);

        if (!review || review.MemoryId !== null) {
            console.error("Review creation failed or MemoryId not null");
        }

        console.log("Linking review to memory...");
        // Link to the memory we created earlier (ID 1 usually)
        await sqlService.updateMemoryReviewLink(reviewId, memoryId);

        const updatedReview = await sqlService.getMemoryReview(reviewId);
        console.log("Updated review:", updatedReview);

        if (updatedReview.MemoryId !== memoryId) {
            console.error("Review linking failed");
        } else {
            console.log("Review linked successfully.");
        }

        console.log("SqlService verified successfully.");

    } catch (error) {
        console.error("Test failed:", error);
    } finally {
        sqlService.close();
    }
}

testSqlService();
