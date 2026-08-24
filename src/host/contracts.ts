/**
 * HomeBase's hosted-application contract, transcribed from
 * `src/contracts/hostedApplication.ts` in the HomeBase checkout
 * (`c:\LocalDev\Projects\HomeBase`) since MemoryApi does not depend on
 * HomeBase as a package. Keep in sync manually if HomeBase's contract
 * changes — there is no shared package to pull types from.
 */
export const HOSTED_CONTRACT_VERSION = 1 as const;

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

export interface ApplicationLogger {
    child(bindings: Readonly<Record<string, unknown>>): ApplicationLogger;
    log(
        level: LogLevel,
        event: string,
        message: string,
        context?: Readonly<Record<string, unknown>>,
    ): void;
    flush?(): Promise<void>;
}

export interface HostedApplicationStatus {
    readonly state: 'ready' | 'degraded';
    readonly summary: string;
    readonly since: string; // ISO-8601
}

export interface ActiveWorkStatus {
    readonly hasActiveWork: boolean;
    readonly description?: string;
}

export type Disposer = () => Promise<void> | void;

export interface HostedApplicationOptions {
    readonly applicationId: string;
    readonly repositoryRoot: string;
    /** Always e.g. "/memoryapi/" in practice — trailing slash, computed by HomeBase. */
    readonly basePath: `/${string}/`;
    readonly hostOrigin: string | undefined;
    /** `<HOMEBASE_DATA_PATH>/apps/memoryapi` — created via mkdir(recursive) before the factory runs. */
    readonly dataPath: string;
    /** Opaque passthrough from the registry's `adapterConfig` — unused by MemoryApi today. */
    readonly config: Readonly<Record<string, unknown>> | undefined;
    readonly logger: ApplicationLogger;
}

export interface HostedApplication {
    readonly contractVersion: typeof HOSTED_CONTRACT_VERSION;
    initialize?(): Promise<void>;
    router?: import('express').Router;
    staticAssets?: { readonly directory: string; readonly spaFallback: boolean };
    attachRealtime?(server: import('node:http').Server): Promise<Disposer | void>;
    getStatus(): Promise<HostedApplicationStatus>;
    getActiveWork?(): Promise<ActiveWorkStatus>;
    dispose?(): Promise<void>;
}

export type CreateHostedApplication = (options: HostedApplicationOptions) => HostedApplication;
