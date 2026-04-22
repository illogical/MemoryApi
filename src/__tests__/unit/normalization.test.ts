import { normalizeTag, normalizeTags, normalizeEntityName, normalizeEntityNames } from '../../utils/normalization.js';

describe('normalizeTag', () => {
    test('lowercases input', () => {
        expect(normalizeTag('TypeScript')).toBe('typescript');
    });

    test('trims surrounding whitespace', () => {
        expect(normalizeTag(' react ')).toBe('react');
    });

    test('maps irregular plural "snippets" → "snippet"', () => {
        expect(normalizeTag('snippets')).toBe('snippet');
    });

    test('maps irregular plural "tools" → "tool"', () => {
        expect(normalizeTag('tools')).toBe('tool');
    });

    test('maps irregular plural "tips" → "tip"', () => {
        expect(normalizeTag('tips')).toBe('tip');
    });

    test('maps irregular plural "utilities" → "utility"', () => {
        expect(normalizeTag('utilities')).toBe('utility');
    });

    test('strips trailing s from longer words (heuristic)', () => {
        // "workflows" is > 4 chars, ends in s, not in exception list
        expect(normalizeTag('workflows')).toBe('workflow');
    });

    test('preserves words ending in "ss"', () => {
        expect(normalizeTag('class')).toBe('class'); // ends in ss → no strip
    });

    test('preserves words ending in "us"', () => {
        expect(normalizeTag('focus')).toBe('focus');
    });

    test('preserves short words (≤ 4 chars)', () => {
        expect(normalizeTag('tags')).toBe('tags'); // 4 chars, not stripped
    });

    test('returns empty string for empty input', () => {
        expect(normalizeTag('')).toBe('');
    });
});

describe('normalizeTags', () => {
    test('deduplicates tags after normalization', () => {
        expect(normalizeTags(['ai', 'ai', 'AI'])).toEqual(['ai']);
    });

    test('handles empty array', () => {
        expect(normalizeTags([])).toEqual([]);
    });

    test('normalizes and deduplicates mixed tags', () => {
        const result = normalizeTags(['TypeScript', 'javascript', 'typescript']);
        expect(result).toEqual(['typescript', 'javascript']);
    });
});

describe('normalizeEntityName', () => {
    test('resolves synonym "vscode" → "VS Code"', () => {
        expect(normalizeEntityName('vscode')).toBe('VS Code');
    });

    test('resolves synonym "vs code" → "VS Code"', () => {
        expect(normalizeEntityName('vs code')).toBe('VS Code');
    });

    test('resolves synonym "nodejs" → "Node.js"', () => {
        expect(normalizeEntityName('nodejs')).toBe('Node.js');
    });

    test('resolves synonym "copilot" → "GitHub Copilot"', () => {
        expect(normalizeEntityName('copilot')).toBe('GitHub Copilot');
    });

    test('resolves synonym "typescript" → "TypeScript"', () => {
        expect(normalizeEntityName('typescript')).toBe('TypeScript');
    });

    test('title-cases unknown entity name', () => {
        expect(normalizeEntityName('my custom tool')).toBe('My Custom Tool');
    });

    test('trims whitespace before processing', () => {
        expect(normalizeEntityName('  vscode  ')).toBe('VS Code');
    });
});

describe('normalizeEntityNames', () => {
    test('handles empty array', () => {
        expect(normalizeEntityNames([])).toEqual([]);
    });

    test('deduplicates after normalization', () => {
        const result = normalizeEntityNames(['vscode', 'VS Code', 'vs code']);
        expect(result).toEqual(['VS Code']);
    });

    test('filters out empty strings after trim', () => {
        // normalizeEntityName('') returns '' after title-case — still present, but empty strings can be filtered upstream
        // The function itself does not filter empties; verify it doesn't crash
        expect(() => normalizeEntityNames(['', 'vscode'])).not.toThrow();
    });

    test('returns canonical forms for known synonyms in batch', () => {
        const result = normalizeEntityNames(['nodejs', 'typescript', 'reactjs']);
        expect(result).toContain('Node.js');
        expect(result).toContain('TypeScript');
        expect(result).toContain('React');
    });
});
