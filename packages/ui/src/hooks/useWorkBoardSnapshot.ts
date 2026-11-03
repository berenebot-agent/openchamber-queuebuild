import React from 'react';
import { fetchWorkBoardSnapshot, type WorkBoardSnapshot } from '@/lib/workBoardApi';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

/**
 * The last good snapshot per runtime, directory and day window. A board that
 * mounts again (a tab switch, or coming back from a card's session) starts from
 * this and revalidates, so it never opens empty. It is a display cache only:
 * every mount still fetches, and the server's answer replaces the entry.
 */
const snapshotCache = new Map<string, WorkBoardSnapshot>();

const cacheKey = (directory: string, days: number) => `${getRuntimeKey()}\n${directory}\n${days}`;

subscribeRuntimeEndpointChanged(() => snapshotCache.clear());

/**
 * The board projection for one directory: reads the server snapshot, keeps the
 * last good one while a read is in flight or failed, and re-reads on the
 * server's own work-board/queue events, on visibility, and on a reconnect
 * interval. No history poll — the server derives activity once.
 *
 * `warmDirectories` are the other open boards. They are read into the cache on
 * the same triggers so switching to one shows its last state at once.
 */
export function useWorkBoardSnapshot(directory: string, days = 30, enabled = true, warmDirectories: readonly string[] = []) {
  const [state, setState] = React.useState<{ key: string; snapshot: WorkBoardSnapshot | null }>(() => {
    const key = cacheKey(directory, days);
    return { key, snapshot: snapshotCache.get(key) ?? null };
  });
  const [error, setError] = React.useState<string | null>(null);
  const sequence = React.useRef(0);
  const warmKey = warmDirectories.join('\n');

  // A different board shows its cached snapshot, or nothing: the previous
  // board's cards must not show through for another project.
  const currentKey = cacheKey(directory, days);
  if (state.key !== currentKey) {
    setState({ key: currentKey, snapshot: snapshotCache.get(currentKey) ?? null });
  }
  const snapshot = state.key === currentKey ? state.snapshot : (snapshotCache.get(currentKey) ?? null);

  const refresh = React.useCallback(async () => {
    if (!enabled || !directory) return;
    const request = ++sequence.current;
    const runtime = getRuntimeKey();
    const key = cacheKey(directory, days);
    try {
      const next = await fetchWorkBoardSnapshot(directory, days);
      if (runtime !== getRuntimeKey()) return;
      if (next.directory !== directory) return;
      snapshotCache.set(key, next);
      if (request !== sequence.current) return;
      setState({ key, snapshot: next });
      setError(null);
    } catch (cause) {
      if (request !== sequence.current || runtime !== getRuntimeKey()) return;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [directory, enabled, days]);

  const refreshWarm = React.useCallback(() => {
    if (!enabled || !warmKey) return;
    const runtime = getRuntimeKey();
    for (const other of warmKey.split('\n')) {
      if (!other || other === directory) continue;
      const key = cacheKey(other, days);
      // A failed warm read keeps the cached entry; the board reads again when
      // it becomes the active one.
      void fetchWorkBoardSnapshot(other, days).then(next => {
        if (runtime === getRuntimeKey() && next.directory === other) snapshotCache.set(key, next);
      }).catch(() => undefined);
    }
  }, [directory, days, enabled, warmKey]);

  React.useEffect(() => {
    setError(null);
    if (!enabled || !directory) return;
    const refreshAll = () => { void refresh(); refreshWarm(); };
    const unsubscribe = subscribeRuntimeEndpointChanged(() => {
      sequence.current += 1;
      setState({ key: cacheKey(directory, days), snapshot: null });
      setError(null);
      refreshAll();
    });
    // The server derives every board change and broadcasts a work-board event
    // for the directory that moved; a queue mutation and a card write both ride
    // their own events. Re-reading on those is what keeps the board current
    // without a poll. The interval stays only as a reconnect safety net.
    const unsubscribeEvents = subscribeOpenchamberEvents(event => {
      if (event.type === 'build-queue-updated' || event.type === 'work-board-updated') refreshAll();
    });
    refreshAll();
    const interval = setInterval(refreshAll, 15000);
    const onVisibilityChange = () => { if (document.visibilityState === 'visible') refreshAll(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      sequence.current += 1;
      unsubscribe();
      unsubscribeEvents();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [directory, enabled, days, refresh, refreshWarm]);

  return { snapshot, error, refresh };
}
