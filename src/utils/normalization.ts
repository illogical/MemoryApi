/**
 * Normalization utilities for tags and entity names.
 * Applied consistently during ingestion and LLM output post-processing.
 */

// Canonical synonyms for entity names
const ENTITY_SYNONYMS: Record<string, string> = {
    'vscode': 'VS Code',
    'vs code': 'VS Code',
    'visual studio code': 'VS Code',
    'nodejs': 'Node.js',
    'node js': 'Node.js',
    'node': 'Node.js',
    'typescript': 'TypeScript',
    'javascript': 'JavaScript',
    'reactjs': 'React',
    'react.js': 'React',
    'neo4j': 'Neo4j',
    'qdrant': 'Qdrant',
    'sqlite': 'SQLite',
    'lmstudio': 'LM Studio',
    'lm studio': 'LM Studio',
    'fancyzones': 'FancyZones',
    'fancy zones': 'FancyZones',
    'powertoys': 'PowerToys',
    'power toys': 'PowerToys',
    'raycast': 'Raycast',
    'superwhisper': 'SuperWhisper',
    'github copilot': 'GitHub Copilot',
    'copilot': 'GitHub Copilot',
};

// Simple irregular plurals
const IRREGULAR_PLURALS: Record<string, string> = {
    'tips': 'tip',
    'tools': 'tool',
    'notes': 'note',
    'reminders': 'reminder',
    'snippets': 'snippet',
    'shortcuts': 'shortcut',
    'preferences': 'preference',
    'utilities': 'utility',
};

/**
 * Normalize a single tag: trim, lowercase, convert common plurals.
 */
export function normalizeTag(tag: string): string {
    const trimmed = tag.trim().toLowerCase();

    // Check irregular plurals first
    if (IRREGULAR_PLURALS[trimmed]) {
        return IRREGULAR_PLURALS[trimmed];
    }

    // Simple heuristic: strip trailing 's' from words longer than 4 chars
    // (only if the word doesn't end in 'ss', 'us', 'is', 'as', or 'ous')
    if (
        trimmed.length > 4 &&
        trimmed.endsWith('s') &&
        !trimmed.endsWith('ss') &&
        !trimmed.endsWith('us') &&
        !trimmed.endsWith('is') &&
        !trimmed.endsWith('as') &&
        !trimmed.endsWith('ous')
    ) {
        return trimmed.slice(0, -1);
    }

    return trimmed;
}

/**
 * Normalize an array of tags and deduplicate.
 */
export function normalizeTags(tags: string[]): string[] {
    const normalized = tags.map(normalizeTag);
    return [...new Set(normalized)];
}

/**
 * Normalize an entity name: check synonyms table, then apply title-case.
 */
export function normalizeEntityName(name: string): string {
    const lower = name.trim().toLowerCase();
    if (ENTITY_SYNONYMS[lower]) {
        return ENTITY_SYNONYMS[lower];
    }
    // Title-case: capitalize the first letter of each word
    return name.trim().replace(/\w\S*/g, (word) => {
        return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    });
}

/**
 * Normalize an array of entity names and deduplicate.
 */
export function normalizeEntityNames(names: string[]): string[] {
    const normalized = names.map(normalizeEntityName);
    return [...new Set(normalized)];
}
