// jest.unstable_mockModule must come before any (dynamic or static) import
// of the modules it mocks — including adapter.ts's own dynamic imports,
// which resolve against this same module registry once registered here.
import { jest } from '@jest/globals';
import path from 'node:path';
import type { HostedApplicationOptions } from '../contracts.js';

const reconfigureMock = jest.fn();
jest.unstable_mockModule('../../services/configService.js', () => ({
    reconfigure: reconfigureMock,
}));

const fakeRouter = { __fake: 'router' };
const buildRouterMock = jest.fn(() => fakeRouter);
const appInitializeMock = jest.fn(async () => {});
const appDisposeMock = jest.fn(async () => {});
const getHealthMock = jest.fn(async () => ({ ready: true, summary: 'ok' }));
jest.unstable_mockModule('../../app/index.js', () => ({
    buildRouter: buildRouterMock,
    initialize: appInitializeMock,
    dispose: appDisposeMock,
    getHealth: getHealthMock,
}));

const { default: createMemoryApiAdapter } = await import('../adapter.js');

function baseOptions(overrides: Partial<HostedApplicationOptions> = {}): HostedApplicationOptions {
    return {
        applicationId: 'memoryapi',
        repositoryRoot: 'C:\\fake\\repo\\MemoryApi',
        basePath: '/memoryapi/',
        hostOrigin: 'http://localhost:4000',
        dataPath: 'C:\\fake\\data\\memoryapi',
        config: undefined,
        logger: { child: jest.fn(), log: jest.fn(), flush: jest.fn() } as unknown as HostedApplicationOptions['logger'],
        ...overrides,
    };
}

describe('createMemoryApiAdapter', () => {
    const originalHomebasePort = process.env.HOMEBASE_PORT;

    beforeEach(() => {
        // jest config sets resetMocks: true, which wipes mock
        // implementations (not just call history) before every test — the
        // module-scope `jest.fn(() => ...)` initializers only apply once.
        reconfigureMock.mockReturnValue(undefined);
        buildRouterMock.mockReturnValue(fakeRouter);
        appInitializeMock.mockResolvedValue(undefined);
        appDisposeMock.mockResolvedValue(undefined);
        getHealthMock.mockResolvedValue({ ready: true, summary: 'ok' });
        delete process.env.HOMEBASE_PORT;
    });

    afterEach(() => {
        if (originalHomebasePort === undefined) {
            delete process.env.HOMEBASE_PORT;
        } else {
            process.env.HOMEBASE_PORT = originalHomebasePort;
        }
    });

    test('factory call has zero side effects', () => {
        createMemoryApiAdapter(baseOptions());

        expect(reconfigureMock).not.toHaveBeenCalled();
        expect(buildRouterMock).not.toHaveBeenCalled();
        expect(appInitializeMock).not.toHaveBeenCalled();
    });

    test('exposes the contract version, staticAssets, and no router before initialize()', () => {
        const options = baseOptions();
        const app = createMemoryApiAdapter(options);

        expect(app.contractVersion).toBe(1);
        expect(app.router).toBeUndefined();
        expect(app.staticAssets).toEqual({
            directory: path.join(options.repositoryRoot, 'public'),
            spaFallback: false,
        });
    });

    describe('initialize()', () => {
        test('reconfigures before building the app, then exposes the router', async () => {
            const options = baseOptions();
            const app = createMemoryApiAdapter(options);

            await app.initialize!();

            expect(reconfigureMock).toHaveBeenCalledWith({
                SQLITE_DB_PATH: path.join(options.dataPath, 'memory.db'),
                PROMPT_TEMPLATE_BASE_PATH: path.join(options.repositoryRoot, 'src', 'prompts'),
                LLM_HOST: 'http://127.0.0.1:17106/lmapi',
            });
            expect(buildRouterMock).toHaveBeenCalled();
            expect(appInitializeMock).toHaveBeenCalled();
            expect(app.router).toBe(fakeRouter);

            const reconfigureOrder = reconfigureMock.mock.invocationCallOrder[0];
            const buildRouterOrder = buildRouterMock.mock.invocationCallOrder[0];
            expect(reconfigureOrder).toBeLessThan(buildRouterOrder);
        });

        test('derives LLM_HOST from HOMEBASE_PORT when set', async () => {
            process.env.HOMEBASE_PORT = '19999';
            const app = createMemoryApiAdapter(baseOptions());

            await app.initialize!();

            expect(reconfigureMock).toHaveBeenCalledWith(
                expect.objectContaining({ LLM_HOST: 'http://127.0.0.1:19999/lmapi' })
            );
        });

        test('rejects clearly on an invalid adapterConfig without touching config or app', async () => {
            const app = createMemoryApiAdapter(baseOptions({ config: 'not-an-object' as any }));

            await expect(app.initialize!()).rejects.toThrow(/Invalid MemoryApi adapterConfig/);
            expect(reconfigureMock).not.toHaveBeenCalled();
            expect(buildRouterMock).not.toHaveBeenCalled();
        });
    });

    describe('getStatus()', () => {
        test('reports degraded before initialize()', async () => {
            const app = createMemoryApiAdapter(baseOptions());
            const status = await app.getStatus();
            expect(status.state).toBe('degraded');
            expect(status.summary).toMatch(/not initialized/i);
        });

        test('reports degraded when a dependency is unreachable', async () => {
            const app = createMemoryApiAdapter(baseOptions());
            await app.initialize!();
            getHealthMock.mockResolvedValueOnce({ ready: false, summary: 'Unreachable: sql' });

            const status = await app.getStatus();
            expect(status.state).toBe('degraded');
            expect(status.summary).toBe('Unreachable: sql');
        });

        test('reports ready once initialized and all stores are reachable', async () => {
            const app = createMemoryApiAdapter(baseOptions());
            await app.initialize!();

            const status = await app.getStatus();
            expect(status.state).toBe('ready');
        });
    });

    describe('dispose()', () => {
        test('is idempotent (safe to call twice, and before initialize())', async () => {
            const app = createMemoryApiAdapter(baseOptions());
            await expect(app.dispose!()).resolves.not.toThrow();

            await app.initialize!();
            await app.dispose!();
            await app.dispose!();

            expect(appDisposeMock).toHaveBeenCalledTimes(1);
        });
    });
});
