import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';

export interface BuildQueueEntry {
  id: string;
  sessionId: string;
  directory: string;
  content: string;
  createdAt: number;
  order: number;
}

export interface BuildQueueLease {
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
  active: BuildQueueLease[];
  queued: BuildQueueEntry[];
  issues: Array<{ directory: string; issue: string }>;
}

export function useBuildQueueSnapshot() {
  const [snapshot, setSnapshot] = React.useState<BuildQueueSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    try {
      const response = await runtimeFetch('/api/build-queue');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json() as BuildQueueSnapshot;
      if (!Array.isArray(data.active) || !Array.isArray(data.queued) || !Array.isArray(data.issues)) {
        throw new Error('Invalid build queue response');
      }
      setSnapshot(data);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  React.useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 3000);
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [refresh]);

  return { snapshot, error, refresh };
}
