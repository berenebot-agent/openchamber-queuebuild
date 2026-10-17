import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { useBuildQueuePreferences } from '@/stores/buildQueuePreferences';

export interface BuildQueueEntry {
  id: string;
  sessionId: string;
  directory: string;
  content: string;
  createdAt: number;
  order: number;
  paused: boolean;
}

interface BuildQueueLease {
  directory: string;
  sessionId: string;
  itemId: string;
  startedAt: number;
  needsReview?: boolean;
  reviewReason?: string;
  retryAvailable?: boolean;
}

export interface BuildQueueSnapshot {
  revision: number;
  projectQueueEnabled?: Record<string, boolean>;
  active: BuildQueueLease[];
  forced?: BuildQueueForced[];
  queued: BuildQueueEntry[];
  issues: Array<{ directory: string; issue: string }>;
  preparation?: Array<{ directory: string; phase: 'initializing' | 'staging' | 'generating' | 'committing' }>;
  commits?: Array<{ directory: string; hash: string; subject: string }>;
}

/** A build a user forced to start outside the queue lane. Display only. */
interface BuildQueueForced {
  directory: string;
  sessionId: string;
  startedAt: number;
}

export function useBuildQueueSnapshot(enabled = true) {
  const [snapshot, setSnapshot] = React.useState<BuildQueueSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const sequence = React.useRef(0);

  const refresh = React.useCallback(async () => {
    if (!enabled) return;
    const request = ++sequence.current;
    const runtime = getRuntimeKey();
    try {
      const response = await runtimeFetch('/api/build-queue');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as BuildQueueSnapshot;
      if (!Array.isArray(data.active) || !Array.isArray(data.queued) || !Array.isArray(data.issues)) {
        throw new Error('Invalid build queue response');
      }
      if (request !== sequence.current || runtime !== getRuntimeKey()) return;
      setSnapshot(data);
      // Only apply live snapshot settings once the initial legacy migration has
      // completed through the preference store's authoritative refresh.
      if (data.projectQueueEnabled && useBuildQueuePreferences.getState().syncedRuntimeKey === runtime) {
        useBuildQueuePreferences.getState().syncFromServer(data.projectQueueEnabled);
      }
      setError(null);
    } catch (cause) {
      if (request !== sequence.current || runtime !== getRuntimeKey()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [enabled]);

  React.useEffect(() => {
    setSnapshot(null);
    setError(null);
    if (!enabled) return;
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      sequence.current += 1;
      setSnapshot(null);
      setError(null);
      void refresh();
    });
    // The server broadcasts every build-queue mutation. Reading on that push is
    // what makes a queued build appear when it was submitted rather than on the
    // next poll; the interval below stays as the reconnect and missed-event
    // safety net, since a dropped push must not strand a stale column.
    const unsubscribeEvents = subscribeOpenchamberEvents(event => {
      if (event.type === 'build-queue-updated') void refresh();
    });
    void refresh();
    const interval = setInterval(() => void refresh(), 3000);
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      sequence.current += 1;
      unsubscribe();
      unsubscribeEvents();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [enabled, refresh]);

  return { snapshot, error, refresh };
}
