import React from 'react';
import { fetchWorkBoardSnapshot, type WorkBoardSnapshot } from '@/lib/workBoardApi';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

/**
 * The board projection for one directory: reads the server snapshot, keeps the
 * last good one while a read is in flight or failed, and re-reads on the
 * server's own work-board/queue events, on visibility, and on a reconnect
 * interval. No history poll — the server derives activity once.
 */
export function useWorkBoardSnapshot(directory: string, includeOlder = false, enabled = true) {
  const [snapshot, setSnapshot] = React.useState<WorkBoardSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const sequence = React.useRef(0);

  const refresh = React.useCallback(async () => {
    if (!enabled || !directory) return;
    const request = ++sequence.current;
    const runtime = getRuntimeKey();
    try {
      const next = await fetchWorkBoardSnapshot(directory, includeOlder);
      if (request !== sequence.current || runtime !== getRuntimeKey()) return;
      if (next.directory !== directory) return;
      setSnapshot(next);
      setError(null);
    } catch (cause) {
      if (request !== sequence.current || runtime !== getRuntimeKey()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [directory, enabled, includeOlder]);

  React.useEffect(() => {
    // A new board starts empty; the fetch below fills it. The previous board's
    // cards must not show through for a different project.
    setSnapshot(null);
    setError(null);
    if (!enabled || !directory) return;
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      sequence.current += 1;
      setSnapshot(null);
      setError(null);
      void refresh();
    });
    // The server derives every board change and broadcasts a work-board event
    // for the directory that moved; a queue mutation and a card write both ride
    // their own events. Re-reading on those is what keeps the board current
    // without a poll. The interval stays only as a reconnect safety net.
    const unsubscribeEvents = subscribeOpenchamberEvents(event => {
      if (event.type === 'build-queue-updated' || event.type === 'work-board-updated') void refresh();
    });
    void refresh();
    const interval = setInterval(() => void refresh(), 15000);
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      sequence.current += 1;
      unsubscribe();
      unsubscribeEvents();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [directory, enabled, includeOlder, refresh]);

  return { snapshot, error, refresh };
}
