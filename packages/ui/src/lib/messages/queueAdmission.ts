import { z } from 'zod';
import { isVSCodeRuntime } from '@/lib/desktop';
import { normalizePath } from '@/lib/pathNormalization';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';

export const isServerOwnedMessageQueue = (): boolean => !isVSCodeRuntime();

const admissionSnapshot = z.object({
    sessions: z.array(z.object({
        sessionId: z.string(),
        directory: z.string(),
        items: z.array(z.object({ messageId: z.string().optional() })),
    })),
});

/** Confirms admission after a lost response, before the prompt exists in OpenCode history. */
export async function hasQueuedPrompt(sessionId: string, messageId: string, directory?: string | null): Promise<boolean> {
    const runtimeKey = getRuntimeKey();
    const response = await runtimeFetch('/api/message-queue', { signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Queue admission check failed (${response.status})`);
    const snapshot = admissionSnapshot.parse(await response.json());
    if (runtimeKey !== getRuntimeKey()) throw new Error('Runtime changed while checking queue admission');
    return snapshot.sessions.some(session => session.sessionId === sessionId
        && (!directory || normalizePath(session.directory) === normalizePath(directory))
        && session.items.some(item => item.messageId === messageId));
}
