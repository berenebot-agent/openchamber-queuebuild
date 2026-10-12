import React from 'react';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useBuildQueuePreferences } from '@/stores/buildQueuePreferences';
import { useSessionUIStore } from '@/sync/session-ui-store';

export interface BuildQueueEntry {
  id: string;
  sessionId: string;
  directory: string;
  content: string;
  createdAt: number;
  order: number;
}
export interface BuildQueueSnapshot {
  revision: number;
  active: Array<{ directory: string; sessionId: string; itemId: string; startedAt: number }>;
  queued: BuildQueueEntry[];
  issues: Array<{ directory: string; issue: string }>;
}

/** Server is authoritative; polling is also a recovery path for missed broadcasts. */
export function useBuildQueueSnapshot() {
  const [snapshot, setSnapshot] = React.useState<BuildQueueSnapshot | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const refresh = React.useCallback(async () => {
    try {
      const response = await runtimeFetch('/api/build-queue');
      if (!response.ok) throw new Error('HTTP ' + response.status);
      setSnapshot(await response.json() as BuildQueueSnapshot);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  React.useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 3000);
    return () => clearInterval(interval);
  }, [refresh]);
  return { snapshot, error, refresh };
}

export const BuildQueueView: React.FC = () => {
  const directory = useEffectiveDirectory() ?? '';
  const directoryKey = directory.replace(/\\/g, '/').replace(/\/+$/, '');
  const enabled = useBuildQueuePreferences(state => state.enabled[directoryKey] === true);
  const setEnabled = useBuildQueuePreferences(state => state.setEnabled);
  const { snapshot, error, refresh } = useBuildQueueSnapshot();
  const [working, setWorking] = React.useState(false);
  const items = snapshot?.queued.filter(item => item.directory === directory) ?? [];
  const active = snapshot?.active.find(item => item.directory === directory);
  const issue = snapshot?.issues.find(item => item.directory === directory)?.issue;

  const cancel = async (item: BuildQueueEntry) => {
    setWorking(true);
    try {
      const response = await runtimeFetch('/api/build-queue/sessions/' + encodeURIComponent(item.sessionId) +
        '/items/' + encodeURIComponent(item.id), { method: 'DELETE' });
      if (!response.ok) throw new Error('Could not cancel queued build');
      await refresh();
    } catch (e) { window.alert(e instanceof Error ? e.message : String(e)); }
    finally { setWorking(false); }
  };
  const move = async (index: number, change: number) => {
    const updated = items.map(item => item.id);
    const other = index + change;
    if (other < 0 || other >= updated.length) return;
    [updated[index], updated[other]] = [updated[other], updated[index]];
    setWorking(true);
    try {
      const response = await runtimeFetch('/api/build-queue/order', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory, ids: updated }),
      });
      if (!response.ok) throw new Error('Could not reorder builds');
      await refresh();
    } catch (e) { window.alert(e instanceof Error ? e.message : String(e)); }
    finally { setWorking(false); }
  };
  const openSession = (sessionId: string) => useSessionUIStore.getState().setCurrentSession(sessionId, directory);

  return <div className="h-full overflow-y-auto p-4 text-sm space-y-4">
    <div className="flex justify-between items-center gap-3">
      <div>
        <h2 className="font-semibold text-base">Project build queue</h2>
        <div className="text-xs opacity-60">One Build agent turn at a time, per project.</div>
      </div>
      <label className="flex items-center gap-2 cursor-pointer whitespace-nowrap">
        <input aria-label="Queue builds for this project" type="checkbox" checked={enabled} onChange={e => setEnabled(directory, e.target.checked)} />
        Enabled
      </label>
    </div>
    <p className="text-xs opacity-70">Plan sessions continue normally. Build prompts are queued automatically when enabled. Each build stays in its original chat. Builds commit their changes before finishing; uncommitted files pause the next one.</p>
    {error && <p role="alert" className="text-red-500">Queue unavailable: {error}</p>}
    {issue && <div role="status" className="rounded-md border border-amber-600/50 p-3 text-amber-600">Paused: {issue}</div>}
    <section>
      <h3 className="font-semibold mb-2">Running</h3>
      {active ? <button type="button" className="w-full rounded-md border p-3 text-left hover:bg-surface-muted"
        onClick={() => openSession(active.sessionId)}>
        <span className="font-medium">Build running</span>
        <div className="text-xs opacity-60">Session {active.sessionId.slice(0, 12)} · Open chat</div>
      </button> : <p className="opacity-60 text-xs">No active queued build.</p>}
    </section>
    <section>
      <h3 className="font-semibold mb-2">Waiting ({items.length})</h3>
      {items.length === 0 && <p className="opacity-60 text-xs">Nothing queued.</p>}
      <div className="space-y-2">
        {items.map((item, i) => <div key={item.id} className="rounded-md border p-3">
          <button className="text-left w-full" onClick={() => openSession(item.sessionId)}>
            <div className="font-medium">#{i + 1} · Session {item.sessionId.slice(0, 12)}</div>
            <div className="text-xs opacity-70 break-words line-clamp-2">{item.content || 'Queued build'}</div>
          </button>
          <div className="flex justify-end gap-2 mt-2">
            <button disabled={working || i === 0} onClick={() => void move(i, -1)} className="text-xs disabled:opacity-30 underline">Up</button>
            <button disabled={working || i === items.length - 1} onClick={() => void move(i, 1)} className="text-xs disabled:opacity-30 underline">Down</button>
            <button disabled={working} onClick={() => void cancel(item)} className="text-xs text-red-500 disabled:opacity-30 underline">Cancel</button>
          </div>
        </div>)}
      </div>
    </section>
  </div>;
};
