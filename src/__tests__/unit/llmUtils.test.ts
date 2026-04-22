import { jest } from '@jest/globals';
import { withLLMRetry, filterValidTags } from '../../utils/llmUtils.js';

describe('withLLMRetry', () => {
    test('succeeds on first attempt — calls fn once', async () => {
        const fn = jest.fn<() => Promise<string>>().mockResolvedValue('VALID');
        const validate = (raw: string) => (raw === 'VALID' ? raw : null);
        const result = await withLLMRetry(fn, validate, 3);
        expect(result).toBe('VALID');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('fails once then succeeds — calls fn twice', async () => {
        const fn = jest.fn<() => Promise<string>>()
            .mockResolvedValueOnce('INVALID')
            .mockResolvedValueOnce('VALID');
        const validate = (raw: string) => (raw === 'VALID' ? raw : null);
        const result = await withLLMRetry(fn, validate, 3);
        expect(result).toBe('VALID');
        expect(fn).toHaveBeenCalledTimes(2);
    });

    test('exhausts all attempts — returns null', async () => {
        const fn = jest.fn<() => Promise<string>>().mockResolvedValue('BAD');
        const validate = (_raw: string) => null;
        const result = await withLLMRetry(fn, validate, 3);
        expect(result).toBeNull();
        expect(fn).toHaveBeenCalledTimes(3);
    });

    test('propagates error thrown by fn immediately', async () => {
        const fn = jest.fn<() => Promise<string>>().mockRejectedValue(new Error('network error'));
        const validate = (_raw: string) => null;
        await expect(withLLMRetry(fn, validate, 3)).rejects.toThrow('network error');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    test('respects custom maxAttempts', async () => {
        const fn = jest.fn<() => Promise<string>>().mockResolvedValue('BAD');
        const validate = (_raw: string) => null;
        await withLLMRetry(fn, validate, 5);
        expect(fn).toHaveBeenCalledTimes(5);
    });

    test('passes attempt number to validate', async () => {
        const attemptsSeen: number[] = [];
        const fn = jest.fn<() => Promise<string>>().mockResolvedValue('x');
        const validate = (_raw: string, attempt: number) => {
            attemptsSeen.push(attempt);
            return null;
        };
        await withLLMRetry(fn, validate, 3);
        expect(attemptsSeen).toEqual([1, 2, 3]);
    });
});

describe('filterValidTags', () => {
    const allowed = ['typescript', 'react', 'node.js', 'debugging'];

    test('returns all tags when all are valid', () => {
        const { valid, discarded } = filterValidTags('typescript, react', allowed);
        expect(valid).toEqual(['typescript', 'react']);
        expect(discarded).toEqual([]);
    });

    test('removes tags not in allowed list', () => {
        const { valid, discarded } = filterValidTags('typescript, unknown-tag', allowed);
        expect(valid).toEqual(['typescript']);
        expect(discarded).toEqual(['unknown-tag']);
    });

    test('case-insensitive matching', () => {
        const { valid } = filterValidTags('TypeScript, REACT', allowed);
        expect(valid).toEqual(['typescript', 'react']);
    });

    test('returns empty arrays for empty input', () => {
        const { valid, discarded } = filterValidTags('', allowed);
        expect(valid).toEqual([]);
        expect(discarded).toEqual([]);
    });

    test('all tags invalid — returns all as discarded', () => {
        const { valid, discarded } = filterValidTags('foo, bar, baz', allowed);
        expect(valid).toEqual([]);
        expect(discarded).toEqual(['foo', 'bar', 'baz']);
    });

    test('does not return duplicate valid tags', () => {
        const { valid } = filterValidTags('typescript, TypeScript', allowed);
        expect(valid).toHaveLength(1);
        expect(valid[0]).toBe('typescript');
    });

    test('trims whitespace around tags', () => {
        const { valid } = filterValidTags('  typescript  ,  react  ', allowed);
        expect(valid).toEqual(['typescript', 'react']);
    });
});
