import { afterEach, expect, spyOn, test } from 'bun:test';
import { getRuntimeApiBaseUrl, getRuntimeKey, switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { hasQueuedPrompt } from './queueAdmission';

const original = { runtimeKey: getRuntimeKey(), apiBaseUrl: getRuntimeApiBaseUrl() };
const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ sessions: [] }));
afterEach(() => {
    fetchSpy.mockReset();
    switchRuntimeEndpoint(original);
});

test('confirms the exact prompt, session and directory without requiring history', async () => {
    fetchSpy.mockImplementation(async () => Response.json({ sessions: [{ sessionId: 'ses_a', directory: '/project/', items: [{ messageId: 'msg_a' }] }] }));
    expect(await hasQueuedPrompt('ses_a', 'msg_a', '/project')).toBe(true);
    expect(await hasQueuedPrompt('ses_a', 'msg_b', '/project')).toBe(false);
    expect(await hasQueuedPrompt('ses_a', 'msg_a', '/other')).toBe(false);
    expect(await hasQueuedPrompt('ses_b', 'msg_a', '/project')).toBe(false);
});

test('unavailable and malformed snapshots remain failures', async () => {
    fetchSpy.mockImplementation(async () => Response.json({ error: 'Unavailable' }, { status: 503 }));
    await expect(hasQueuedPrompt('ses_a', 'msg_a')).rejects.toThrow('503');
    fetchSpy.mockImplementation(async () => Response.json({}));
    await expect(hasQueuedPrompt('ses_a', 'msg_a')).rejects.toThrow();
});

test('rejects a response from the previous runtime', async () => {
    fetchSpy.mockImplementationOnce(async () => {
        switchRuntimeEndpoint({ runtimeKey: 'other-queue-runtime', apiBaseUrl: 'https://other-queue.test' });
        return Response.json({ sessions: [] });
    });
    await expect(hasQueuedPrompt('ses_a', 'msg_a')).rejects.toThrow('Runtime changed');
});
