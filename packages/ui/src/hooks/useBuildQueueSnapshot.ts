import React from 'react';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

const buildQueueEntrySchema = z.object({
  id: z.string(),
  sessionId: z.string(),
  directory: z.string(),
  content: z.string(),
  createdAt: z.number(),
  order: z.number(),
  paused: z.boolean(),
});

const buildQueueLeaseSchema = z.object({
  directory: z.string(),
  sessionId: z.string(),
  // An adopted live build owns no queued item.
  itemId: z.string().optional(),
  startedAt: z.number(),
  needsReview: z.boolean().optional(),
  reviewReason: z.string().optional(),
  retryAvailable: z.boolean().optional(),
});

const buildQueueForcedSchema = z.object({
  directory: z.string(),
  sessionId: z.string(),
  startedAt: z.number(),
  counts: z.boolean().default(false),
});

const buildQueueSnapshotSchema = z.object({
  revision: z.number(),
  pausedDirectories: z.array(z.string()).default([]),
  active: z.array(buildQueueLeaseSchema),
  queued: z.array(buildQueueEntrySchema),
  issues: z.array(z.object({ directory: z.string(), issue: z.string() })),
  forced: z.array(buildQueueForcedSchema).optional(),
  preparation: z.array(z.object({
    directory: z.string(),
    phase: z.enum(['initializing', 'staging', 'generating', 'committing']),
  })).optional(),
  commits: z.array(z.object({
    directory: z.string(),
    hash: z.string(),
    subject: z.string(),
  })).optional(),
});

type BuildQueueSnapshot = z.infer<typeof buildQueueSnapshotSchema>;

/**
 * The last good queue per runtime. The board mounts this hook again on every
 * switch back from a chat, and starting from nothing would paint the amber
 * "queue unavailable" mark on every project tab until the read returns — or
 * for good if that one read fails. Seeded on mount, replaced by every answer.
 */
const queueCache = new Map<string, BuildQueueSnapshot>();

subscribeRuntimeEndpointChanged(() => queueCache.clear());

/** Empties the cache, so a test starts from a cold page. */
export const clearBuildQueueSnapshotCache = (): void => { queueCache.clear(); };

export function useBuildQueueSnapshot(enabled = true) {
  const [snapshot, setSnapshot] = React.useState<BuildQueueSnapshot | null>(() => queueCache.get(getRuntimeKey()) ?? null);
  const [error, setError] = React.useState<string | null>(null);
  const sequence = React.useRef(0);

  const refresh = React.useCallback(async () => {
    if (!enabled) return;
    const request = ++sequence.current;
    const runtime = getRuntimeKey();
    try {
      const response = await runtimeFetch('/api/build-queue');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const parsed = buildQueueSnapshotSchema.safeParse(await response.json());
      if (!parsed.success) throw new Error('Invalid build queue response');
      if (runtime !== getRuntimeKey()) return;
      queueCache.set(runtime, parsed.data);
      if (request !== sequence.current) return;
      setSnapshot(parsed.data);
      setError(null);
    } catch (cause) {
      if (request !== sequence.current || runtime !== getRuntimeKey()) return;
      // A failed re-read keeps the queue already in hand: it is stale, not
      // absent, and the next event or reconnect reads it again. The error
      // stands for a queue that could not be read at all.
      if (queueCache.has(runtime)) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [enabled]);

  React.useEffect(() => {
    setSnapshot(queueCache.get(getRuntimeKey()) ?? null);
    setError(null);
    if (!enabled) return;
    const unsubscribeRuntime = subscribeRuntimeEndpointChanged(() => {
      sequence.current += 1;
      setSnapshot(null);
      setError(null);
      void refresh();
    });
    const unsubscribeEvents = subscribeOpenchamberEvents(event => {
      // Reconnect reads cover mutations missed while the stream was down.
      if (event.type === 'build-queue-updated' || event.type === 'event-stream-ready') void refresh();
    });
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    void refresh();
    return () => {
      sequence.current += 1;
      unsubscribeRuntime();
      unsubscribeEvents();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, refresh]);

  return { snapshot, error, refresh };
}
