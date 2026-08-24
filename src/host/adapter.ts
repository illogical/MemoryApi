import { join } from 'node:path';
import { parseHostedConfig } from './config';
import {
    HOSTED_CONTRACT_VERSION,
    type HostedApplication,
    type HostedApplicationOptions,
} from './contracts';

const DEFAULT_HOMEBASE_PORT = '17106';

/**
 * MemoryApi's HomeBase hosted-adapter factory
 * (docs/plans/homebase-integration-plan.md).
 *
 * Import-safety: this module and the factory call below must have zero side
 * effects — no I/O, no env reads, no dynamic imports of app code. MemoryApi's
 * app modules (configService.ts, memoryAPI.ts, sqlService.ts, ...) construct
 * several module-scope singletons at *import* time (opening a real SQLite
 * file handle, building Qdrant/Neo4j clients from whatever config.*
 * currently resolves to) — see the plan's "import-time side-effect chain"
 * section. To keep those side effects confined to initialize() (as the
 * contract requires), this file dynamically imports
 * '../services/configService.js' FIRST, calls reconfigure() with the hosted
 * overrides, and only THEN dynamically imports '../app/index.js' — never
 * statically at module scope. Node's ESM module cache means both dynamic
 * imports elsewhere in the process (e.g. standalone mode) still resolve to
 * the same singleton instances; only the *order* of first access matters.
 *
 * MemoryApi is native ESM ("type": "module") — this file uses a plain
 * `export default` (see ./index.ts), NOT LMApi's CJS `export =` trick. Node's
 * dynamic `import()` of a genuine ESM module sets `.default` correctly with
 * no interop wrapper involved; `export =` is a CommonJS-only construct.
 */
export default function createMemoryApiAdapter(options: HostedApplicationOptions): HostedApplication {
    const state: {
        since: string;
        initialized: boolean;
        disposed: boolean;
    } = {
        since: new Date().toISOString(),
        initialized: false,
        disposed: false,
    };

    let router: HostedApplication['router'];
    let appDispose: (() => Promise<void>) | undefined;
    let getHealth: (() => Promise<{ ready: boolean; summary: string }>) | undefined;

    const app: HostedApplication = {
        contractVersion: HOSTED_CONTRACT_VERSION,

        get router() {
            return router;
        },

        staticAssets: {
            directory: join(options.repositoryRoot, 'public'),
            spaFallback: false,
        },

        async initialize() {
            parseHostedConfig(options.config);

            const { reconfigure } = await import('../services/configService.js');

            const homebasePort = process.env.HOMEBASE_PORT ?? DEFAULT_HOMEBASE_PORT;
            reconfigure({
                SQLITE_DB_PATH: join(options.dataPath, 'memory.db'),
                PROMPT_TEMPLATE_BASE_PATH: join(options.repositoryRoot, 'src', 'prompts'),
                LLM_HOST: `http://127.0.0.1:${homebasePort}/lmapi`,
            });

            const appModule = await import('../app/index.js');
            router = appModule.buildRouter();
            appDispose = appModule.dispose;
            getHealth = appModule.getHealth;

            await appModule.initialize();

            state.initialized = true;
            state.since = new Date().toISOString();
        },

        async getStatus() {
            if (!state.initialized || !getHealth) {
                return { state: 'degraded' as const, summary: 'Not initialized', since: state.since };
            }
            const health = await getHealth();
            if (!health.ready) {
                return { state: 'degraded' as const, summary: health.summary, since: state.since };
            }
            return { state: 'ready' as const, summary: health.summary, since: state.since };
        },

        async dispose() {
            if (state.disposed || !appDispose) return;
            state.disposed = true;
            await appDispose();
        },
    };

    return app;
}
