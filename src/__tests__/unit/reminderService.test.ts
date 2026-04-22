import { jest } from '@jest/globals';
import { ReminderService } from '../../services/reminderService.js';
import { LoggingService } from '../../services/loggingService.js';

function makeLogger(): LoggingService {
    return {
        log: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
        trace: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        close: jest.fn(),
    } as unknown as LoggingService;
}

describe('ReminderService.createTask', () => {
    const FAKE_TOKEN = 'test-todoist-token';

    beforeEach(() => {
        global.fetch = jest.fn() as unknown as typeof fetch;
    });

    function mockFetch(ok: boolean, body: object = {}) {
        (global.fetch as any).mockResolvedValue({
            ok,
            text: async () => JSON.stringify(body),
            json: async () => body,
        });
    }

    const memory = { Content: 'Buy milk', LastUpdated: '' };

    test('calls Todoist API with correct endpoint and auth header', async () => {
        mockFetch(true, { id: 'task-123' });
        const svc = new ReminderService(FAKE_TOKEN, makeLogger());
        await svc.createTask(memory as any);
        expect(global.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = (global.fetch as any).mock.calls[0] as [string, any];
        expect(url).toContain('todoist.com');
        expect(init.headers['Authorization']).toBe(`Bearer ${FAKE_TOKEN}`);
    });

    test('sends memory content in request body', async () => {
        mockFetch(true, { id: 'task-456' });
        const svc = new ReminderService(FAKE_TOKEN, makeLogger());
        await svc.createTask(memory as any);
        const [, init] = (global.fetch as any).mock.calls[0] as [string, any];
        const body = JSON.parse(init.body);
        expect(body.content).toBe('Buy milk');
    });

    test('does not throw when network error occurs', async () => {
        (global.fetch as any).mockRejectedValue(new Error('Network failure'));
        const svc = new ReminderService(FAKE_TOKEN, makeLogger());
        await expect(svc.createTask(memory as any)).resolves.toBeUndefined();
    });

    test('does not throw when API returns non-ok status', async () => {
        mockFetch(false, { error: 'Unauthorized' });
        const svc = new ReminderService(FAKE_TOKEN, makeLogger());
        await expect(svc.createTask(memory as any)).resolves.toBeUndefined();
    });

    test('skips fetch when API key is empty', async () => {
        const svc = new ReminderService('', makeLogger());
        await svc.createTask(memory as any);
        expect(global.fetch).not.toHaveBeenCalled();
    });
});
