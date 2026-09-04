import express, { Router } from 'express';
import path from 'path';
import { pathToFileURL } from 'url';
import { memoryRouter, initializeMemorySystem, memorySystem } from './memoryAPI';
import { config } from '../services/configService';
import { reviewRouter } from './reviewAPI';

/**
 * The API router, unaware of any base path — HomeBase mounts this at
 * `options.basePath` itself (Express strips that prefix before delegating),
 * and standalone mode mounts it at the process root. Never join a base path
 * into these route strings.
 */
export function buildRouter(): Router {
    const router = Router();
    router.use('/api', memoryRouter);
    router.use('/api', reviewRouter);
    return router;
}

/**
 * Initializes the memory system (Qdrant/Neo4j/SQLite connections). Must be
 * called after any config overrides (see src/host/adapter.ts) have been
 * applied, since memoryAPI.ts's module-scope MemoryRAGSystem construction
 * already read the current config the moment it was first imported.
 */
export async function initialize(): Promise<void> {
    try {
        await initializeMemorySystem();
        console.log('Memory system initialized successfully.');
    } catch (err) {
        console.error('Failed to initialize memory system:', err);
        console.log('Server starting despite initialization failure (Degraded Mode).');
    }
}

export async function dispose(): Promise<void> {
    await memorySystem.dispose();
}

export interface HealthSummary {
    ready: boolean;
    summary: string;
}

/** Reuses the same per-store checks the /api/status/* routes already expose. */
export async function getHealth(): Promise<HealthSummary> {
    const checks: Array<[string, () => Promise<number>]> = [
        ['vector', () => memorySystem.getVectorStatus()],
        ['graph', () => memorySystem.getGraphStatus()],
        ['sql', () => memorySystem.getSqlStatus()],
    ];

    const failed: string[] = [];
    if (!memorySystem.getInferenceStatus().active) {
        failed.push('inference');
    }
    for (const [name, check] of checks) {
        try {
            const count = await check();
            if (count < 0) failed.push(name);
        } catch {
            failed.push(name);
        }
    }

    if (failed.length > 0) {
        return { ready: false, summary: `Unreachable: ${failed.join(', ')}` };
    }
    return { ready: true, summary: 'Inference, vector, graph, and SQL services reachable' };
}

const isMain = process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
    (async () => {
        const app = express();
        app.use(express.json());
        app.use(express.static(path.join(process.cwd(), 'public')));
        app.use(buildRouter());

        await initialize();

        app.listen(config.PORT, () => {
            console.log(`Server running on port ${config.PORT}`);
        });
    })();
}
