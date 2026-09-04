import { Config } from '../../services/configService.js';

// Helper that saves and restores a specific env key around a test
function withEnvVar(key: string, value: string | undefined, fn: () => void): void {
    const original = process.env[key];
    if (value === undefined) {
        delete process.env[key];
    } else {
        process.env[key] = value;
    }
    try {
        fn();
    } finally {
        if (original === undefined) delete process.env[key];
        else process.env[key] = original;
    }
}

function withEnvVars(values: Record<string, string | undefined>, fn: () => void): void {
    const originals: Record<string, string | undefined> = {};
    for (const key of Object.keys(values)) {
        originals[key] = process.env[key];
        const value = values[key];
        if (value === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    try {
        fn();
    } finally {
        for (const key of Object.keys(values)) {
            const original = originals[key];
            if (original === undefined) delete process.env[key];
            else process.env[key] = original;
        }
    }
}

describe('Config — defaults (keys not set in .env)', () => {
    test('AGGREGATION_MAX_MEMORIES defaults to 25 when env not set', () => {
        withEnvVar('AGGREGATION_MAX_MEMORIES', undefined, () => {
            const cfg = new Config();
            expect(cfg.AGGREGATION_MAX_MEMORIES).toBe(25);
        });
    });

    test('AGGREGATION_MAX_CLUSTERS defaults to 5 when env not set', () => {
        withEnvVar('AGGREGATION_MAX_CLUSTERS', undefined, () => {
            const cfg = new Config();
            expect(cfg.AGGREGATION_MAX_CLUSTERS).toBe(5);
        });
    });

    test('AGGREGATION_DEFAULT_SCORE_THRESHOLD defaults to 0.6', () => {
        withEnvVar('AGGREGATION_DEFAULT_SCORE_THRESHOLD', undefined, () => {
            const cfg = new Config();
            expect(cfg.AGGREGATION_DEFAULT_SCORE_THRESHOLD).toBe(0.6);
        });
    });
});

describe('Config — env var overrides', () => {
    test('reads PORT from env as number', () => {
        withEnvVar('PORT', '8080', () => {
            const cfg = new Config();
            expect(cfg.PORT).toBe(8080);
            expect(typeof cfg.PORT).toBe('number');
        });
    });

    test('parses AGGREGATION_MAX_MEMORIES from env as number', () => {
        withEnvVar('AGGREGATION_MAX_MEMORIES', '50', () => {
            const cfg = new Config();
            expect(cfg.AGGREGATION_MAX_MEMORIES).toBe(50);
            expect(typeof cfg.AGGREGATION_MAX_MEMORIES).toBe('number');
        });
    });

    test('reads string env vars', () => {
        withEnvVar('LLM_PROVIDER', 'lmstudio', () => {
            const cfg = new Config();
            expect(cfg.LLM_PROVIDER).toBe('lmstudio');
        });
    });
});

describe('Config — ingestion task models', () => {
    test('task models default to LLM_MODEL with current production parameters', () => {
        withEnvVars({
            LLM_MODEL: undefined,
            LLM_MODEL_CLASSIFICATION: undefined,
            LLM_MODEL_TAGGING: undefined,
            LLM_MODEL_SUMMARY: undefined
        }, () => {
            const cfg = new Config({ LLM_MODEL: 'shared-model' });
            expect(cfg.TASK_MODELS).toEqual({
                classification: { model: 'shared-model', temperature: 0.3, maxTokens: 50 },
                tagging: { model: 'shared-model', temperature: 0.3, maxTokens: 100 },
                summary: { model: 'shared-model', temperature: 0.3, maxTokens: 150 }
            });
        });
    });

    test('resolves each task model override independently', () => {
        withEnvVars({
            LLM_MODEL: 'shared-model',
            LLM_MODEL_CLASSIFICATION: 'classifier',
            LLM_MODEL_TAGGING: 'tagger',
            LLM_MODEL_SUMMARY: 'summarizer'
        }, () => {
            const cfg = new Config();
            expect(cfg.TASK_MODELS.classification.model).toBe('classifier');
            expect(cfg.TASK_MODELS.tagging.model).toBe('tagger');
            expect(cfg.TASK_MODELS.summary.model).toBe('summarizer');
        });
    });
});

describe('Config — constructor overrides', () => {
    test('constructor override takes precedence over env var', () => {
        withEnvVar('PORT', '8080', () => {
            const cfg = new Config({ PORT: 9090 });
            expect(cfg.PORT).toBe(9090);
        });
    });

    test('constructor override takes precedence over defaults', () => {
        withEnvVar('AGGREGATION_MAX_MEMORIES', undefined, () => {
            const cfg = new Config({ AGGREGATION_MAX_MEMORIES: 99 });
            expect(cfg.AGGREGATION_MAX_MEMORIES).toBe(99);
        });
    });

    test('partial override leaves other values from env', () => {
        withEnvVar('PORT', '7777', () => {
            const cfg = new Config({ LLM_PROVIDER: 'lmstudio' });
            expect(cfg.PORT).toBe(7777); // from env
            expect(cfg.LLM_PROVIDER).toBe('lmstudio'); // from override
        });
    });

    test('missing optional vars do not throw', () => {
        expect(() => new Config()).not.toThrow();
    });
});

describe('Config — data isolation targets', () => {
    test('derives test storage targets from MEMORY_DATA_ENV for Neo4j Community instances', () => {
        withEnvVars({
            MEMORY_DATA_ENV: 'test',
            SQLITE_DB_PATH: '/wrong/shared/memory.db',
            QDRANT_COLLECTION_NAME: 'wrong_collection',
            NEO4J_URI: 'bolt://wrong-shared:7687',
            NEO4J_TEST_URI: 'bolt://test-neo4j:7687',
            NEO4J_DATABASE: 'wrong_database',
            NEO4J_ISOLATION_MODE: 'community-instances'
        }, () => {
            const cfg = new Config();
            expect(cfg.SQLITE_DB_PATH.replace(/\\/g, '/')).toMatch(/data\/test\/memory\.db$/);
            expect(cfg.QDRANT_COLLECTION_NAME).toBe('memoryapi_test_memories');
            expect(cfg.NEO4J_URI).toBe('bolt://test-neo4j:7687');
            expect(cfg.NEO4J_DATABASE).toBe('neo4j');
        });
    });

    test('derives production storage targets from MEMORY_DATA_ENV for Neo4j Community instances', () => {
        withEnvVar('MEMORY_DATA_ENV', 'production', () => {
            const cfg = new Config();
            expect(cfg.SQLITE_DB_PATH.replace(/\\/g, '/')).toMatch(/data\/prod\/memory\.db$/);
            expect(cfg.QDRANT_COLLECTION_NAME).toBe('memoryapi_prod_memories');
            expect(cfg.NEO4J_URI).toBe('bolt://localhost:7687');
            expect(cfg.NEO4J_DATABASE).toBe('neo4j');
        });
    });

    test('constructor storage overrides are still honored for isolated tests', () => {
        withEnvVar('MEMORY_DATA_ENV', 'test', () => {
            const cfg = new Config({ SQLITE_DB_PATH: ':memory:' });
            expect(cfg.SQLITE_DB_PATH).toBe(':memory:');
            expect(cfg.QDRANT_COLLECTION_NAME).toBe('memoryapi_test_memories');
            expect(cfg.NEO4J_DATABASE).toBe('neo4j');
        });
    });

    test('enterprise mode derives Neo4j database names instead of per-env URIs', () => {
        withEnvVars({
            MEMORY_DATA_ENV: 'test',
            NEO4J_URI: 'bolt://enterprise-neo4j:7687',
            NEO4J_TEST_URI: 'bolt://community-test:7687',
            NEO4J_ISOLATION_MODE: 'enterprise-databases'
        }, () => {
            const cfg = new Config();
            expect(cfg.NEO4J_URI).toBe('bolt://enterprise-neo4j:7687');
            expect(cfg.NEO4J_DATABASE).toBe('memoryapi_test');
        });
    });
});

