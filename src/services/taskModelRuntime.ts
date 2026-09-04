import { IngestionTask, TaskModelConfig, TransportProvenance } from '../models/ingestionTask';
import { ModelClient } from './modelClients';

export interface TaskRuntimeStatus {
    active: boolean;
    error?: string;
    tasks: Record<IngestionTask, TaskModelConfig & { transport: TransportProvenance }>;
}

export class TaskModelRuntimeRegistry {
    private readonly clientsByModel = new Map<string, ModelClient>();
    private readonly taskClients: Record<IngestionTask, ModelClient>;
    private readonly taskConfigs: Record<IngestionTask, TaskModelConfig>;
    private ready = false;
    private error: string | undefined;
    private initializationPromise: Promise<void> | undefined;

    constructor(
        private readonly baseModel: string,
        private readonly baseClient: ModelClient,
        taskConfigs: Record<IngestionTask, TaskModelConfig>,
        createClient: () => ModelClient
    ) {
        this.taskConfigs = {
            classification: { ...taskConfigs.classification },
            tagging: { ...taskConfigs.tagging },
            summary: { ...taskConfigs.summary },
        };
        this.clientsByModel.set(baseModel, baseClient);

        const resolveClient = (task: IngestionTask): ModelClient => {
            const model = this.taskConfigs[task].model;
            const existing = this.clientsByModel.get(model);
            if (existing) return existing;
            const client = createClient();
            this.clientsByModel.set(model, client);
            return client;
        };

        this.taskClients = {
            classification: resolveClient('classification'),
            tagging: resolveClient('tagging'),
            summary: resolveClient('summary'),
        };
    }

    getRuntime(task: IngestionTask): { client: ModelClient; config: TaskModelConfig } {
        return {
            client: this.taskClients[task],
            config: { ...this.taskConfigs[task] },
        };
    }

    async initialize(): Promise<void> {
        if (this.ready) return;
        if (!this.initializationPromise) {
            this.initializationPromise = this.initializeOnce().finally(() => {
                this.initializationPromise = undefined;
            });
        }
        return this.initializationPromise;
    }

    private async initializeOnce(): Promise<void> {
        try {
            const availableModels = this.baseClient.listAvailableModels
                ? await this.baseClient.listAvailableModels()
                : await this.baseClient.listModels();
            const missingModels = [...this.clientsByModel.keys()].filter(model => !availableModels.includes(model));
            if (missingModels.length > 0) {
                throw new Error(`Configured inference model(s) unavailable: ${missingModels.join(', ')}`);
            }
            await Promise.all([...this.clientsByModel].map(([model, client]) => client.load(model)));
            this.ready = true;
            this.error = undefined;
        } catch (error) {
            this.ready = false;
            this.error = error instanceof Error ? error.message : String(error);
            throw error;
        }
    }

    getStatus(): TaskRuntimeStatus {
        const taskStatus = (task: IngestionTask) => ({
            ...this.taskConfigs[task],
            transport: this.taskClients[task].transport,
        });
        return {
            active: this.ready,
            ...(this.error && { error: this.error }),
            tasks: {
                classification: taskStatus('classification'),
                tagging: taskStatus('tagging'),
                summary: taskStatus('summary'),
            },
        };
    }

    get models(): string[] {
        return [...this.clientsByModel.keys()];
    }
}
