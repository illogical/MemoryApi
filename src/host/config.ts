import { z } from 'zod';

/**
 * Validates HomeBase's opaque `options.config` (the registry's
 * `adapterConfig`). MemoryApi doesn't require any hosted-mode-only fields
 * today — the adapter derives everything it needs (SQLITE_DB_PATH,
 * PROMPT_TEMPLATE_BASE_PATH, LLM_HOST) from `options.dataPath`/
 * `options.repositoryRoot`/`process.env.HOMEBASE_PORT`. This schema exists
 * so a future field can be added without a breaking change.
 */
export const hostedConfigSchema = z.object({}).passthrough();

export type HostedConfig = z.infer<typeof hostedConfigSchema>;

/**
 * Parses and validates `options.config`. Call from `initialize()`, not from
 * the factory itself, so a bad config surfaces as an `initialize()`
 * rejection HomeBase can mark `unavailable`, not a factory-call-time throw.
 */
export function parseHostedConfig(config: Readonly<Record<string, unknown>> | undefined): HostedConfig {
    const result = hostedConfigSchema.safeParse(config ?? {});
    if (!result.success) {
        throw new Error(`Invalid MemoryApi adapterConfig: ${result.error.message}`);
    }
    return result.data;
}
