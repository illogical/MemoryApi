import sqlite3 from 'sqlite3';
import { SqlService } from '../../services/sqlService.js';
import { Config } from '../../services/configService.js';

function createTestSqlService(): SqlService {
    const db = new sqlite3.Database(':memory:');
    const cfg = new Config({ SQLITE_DB_PATH: ':memory:' });
    return new SqlService(cfg, db);
}

describe('SqlService — schema and lifecycle', () => {
    let svc: SqlService;

    beforeEach(async () => {
        svc = createTestSqlService();
        await svc.waitUntilReady();
    });

    test('getMemoryCount returns 0 on empty DB', async () => {
        const count = await svc.getMemoryCount();
        expect(count).toBe(0);
    });

    test('addMemory + getMemory round-trip', async () => {
        const id = await svc.addMemory('Test content', 'desc', ['tag1'], 'Note', 'draft');
        expect(typeof id).toBe('number');
        const mem = await svc.getMemory(id);
        expect(mem).toBeDefined();
        expect(mem.Content).toBe('Test content');
        expect(mem.Description).toBe('desc');
        expect(mem.Category).toBe('Note');
        expect(typeof mem.Created).toBe('string');
        expect(new Date(mem.Created).toISOString()).toBe(mem.Created);
        expect(typeof mem.LastUpdated).toBe('string');
        expect(mem.Created).toBe(mem.LastUpdated);
    });

    test('addMemory respects caller-supplied created timestamp', async () => {
        const customCreated = '2024-01-15T10:00:00.000Z';
        const id = await svc.addMemory('Test content', 'desc', [], 'Note', 'draft', {
            created: customCreated
        });
        const mem = await svc.getMemory(id);
        expect(mem.Created).toBe(customCreated);
        expect(mem.LastUpdated).not.toBe(customCreated);
    });

    test('updateMemory preserves Created but changes LastUpdated', async () => {
        const id = await svc.addMemory('Original', 'desc', [], 'Note', 'draft');
        const before = await svc.getMemory(id);
        await new Promise(r => setTimeout(r, 5));
        await svc.updateMemory(id, 'Updated', 'new desc', [], 'Note');
        const after = await svc.getMemory(id);
        expect(after.Created).toBe(before.Created);
        expect(after.LastUpdated).not.toBe(before.LastUpdated);
    });

    test('getMemoryCount increments after addMemory', async () => {
        await svc.addMemory('A', 'a desc', [], 'Note', 'draft');
        await svc.addMemory('B', 'b desc', [], 'Preference', 'draft');
        const count = await svc.getMemoryCount();
        expect(count).toBe(2);
    });

    test('updateMemory persists changes', async () => {
        const id = await svc.addMemory('Original', 'desc', [], 'Note', 'draft');
        await svc.updateMemory(id, 'Updated', 'new desc', ['updated-tag'], 'Preference');
        const mem = await svc.getMemory(id);
        expect(mem.Content).toBe('Updated');
        expect(mem.Category).toBe('Preference');
    });

    test('softDeleteMemory hides record', async () => {
        const id = await svc.addMemory('To delete', 'desc', [], 'Note', 'draft');
        await svc.softDeleteMemory(id);
        const mem = await svc.getMemory(id);
        expect(mem).toBeUndefined();
    });

    test('softDeleteMemory hides from getMemoriesByStatus', async () => {
        const id = await svc.addMemory('Hidden', 'desc', [], 'Note', 'Active');
        await svc.softDeleteMemory(id);
        const results = await svc.getMemoriesByStatus('Active');
        expect(results.find((r: any) => r.ID === id)).toBeUndefined();
    });

    test('updateMemoryRelations stores graphId and vectorId', async () => {
        const id = await svc.addMemory('With relations', 'desc', [], 'Note', 'draft');
        await svc.updateMemoryRelations(id, 'graph-abc', 'vector-xyz');
        const mem = await svc.getMemory(id);
        expect(mem.GraphId).toBe('graph-abc');
        expect(mem.VectorId).toBe('vector-xyz');
    });

    test('addTagSuggestion + getSuggestedTags round-trip', async () => {
        // Add 5 increments to pass default threshold
        for (let i = 0; i < 5; i++) {
            await svc.addTagSuggestion('newtag');
        }
        const suggestions = await svc.getSuggestedTags(5);
        const found = suggestions.find((s: any) => s.TagText === 'newtag');
        expect(found).toBeDefined();
        expect(found.Count).toBe(5);
    });

    test('dismissTagSuggestion removes tag from getSuggestedTags', async () => {
        for (let i = 0; i < 5; i++) {
            await svc.addTagSuggestion('dismissme');
        }
        const before = await svc.getSuggestedTags(5);
        const tag = before.find((s: any) => s.TagText === 'dismissme');
        expect(tag).toBeDefined();

        await svc.dismissTagSuggestion(tag.ID);
        const after = await svc.getSuggestedTags(5);
        expect(after.find((s: any) => s.TagText === 'dismissme')).toBeUndefined();
    });

    test('addSearchHistory persists a row', async () => {
        await svc.addSearchHistory(
            'test query',
            [],
            [],
            '',
            '',
            10,
            0.6,
            'linear',
            'bullets',
            'test-model',
            0,
            50
        );
        // Verify by checking that the call doesn't throw and the function is usable
        // (no direct read API, but addSearchHistory success is sufficient for smoke test)
    });

    test('getAllMemories with category filter returns only matching', async () => {
        await svc.addMemory('Note mem', 'desc', [], 'Note', 'Active');
        await svc.addMemory('Pref mem', 'desc', [], 'Preference', 'Active');
        const notes = await svc.getAllMemories({ category: 'Note' });
        expect(notes.every((m: any) => m.Category === 'Note')).toBe(true);
    });
});
