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

