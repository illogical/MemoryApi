import { LoggingService } from './loggingService';
import { Memory } from '../models/memory';

export class ReminderService {
    private todoistToken: string;
    private loggingService: LoggingService;
    private readonly TODOIST_API_URL = 'https://api.todoist.com/rest/v2/tasks';
    private readonly REQUEST_TIMEOUT = 5000;

    constructor(todoistToken: string, loggingService: LoggingService) {
        this.todoistToken = todoistToken;
        this.loggingService = loggingService;
    }

    /**
     * Creates a task in Todoist with the memory content.
     * Errors are logged but do not block execution.
     */
    async createTask(memory: Memory): Promise<void> {
        this.loggingService.trace('[ReminderService.createTask] Called');

        if (!this.todoistToken) {
            this.loggingService.info('[ReminderService.createTask] No API key configured — skipping Todoist call');
            return;
        }

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT);

        try {
            const payload = {
                content: memory.Content
            };

            this.loggingService.info(`[ReminderService.createTask] Posting reminder to Todoist: "${memory.Content.substring(0, 50)}..."`);

            const response = await fetch(this.TODOIST_API_URL, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.todoistToken}`
                },
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Todoist API failed with status ${response.status}: ${errorText}`);
            }

            const result = await response.json();
            this.loggingService.log(`[ReminderService.createTask] Successfully created Todoist task: ${result.id}`);

        } catch (error) {
            // Log error but don't throw - we don't want to block memory storage
            if (error instanceof Error) {
                if (error.name === 'AbortError') {
                    this.loggingService.error(`[ReminderService.createTask] Request timeout after ${this.REQUEST_TIMEOUT}ms`);
                } else {
                    this.loggingService.error(`[ReminderService.createTask] Error creating Todoist task: ${error.message}`);
                }
            } else {
                this.loggingService.error(`[ReminderService.createTask] Unknown error: ${error}`);
            }
        } finally {
            clearTimeout(timeoutId);
        }
    }
}
