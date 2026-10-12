import React from 'react';
import { useBuildQueueSnapshot } from '@/components/views/BuildQueueView';
import { useBuildQueuePreferences } from '@/stores/buildQueuePreferences';
import { useUIStore } from '@/stores/useUIStore';
import { runtimeFetch } from '@/lib/runtime-fetch';

/** Own row above the composer, separate from OpenChamber's same-session follow-up queue. */
export const BuildQueueBanner: React.FC<{ sessionId: string | null; directory: string | null }> = ({ sessionId, directory }) => {
  const { snapshot, refresh } = useBuildQueueSnapshot();
  const directoryKey = (directory ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const enabled = useBuildQueuePreferences(state => state.enabled[directoryKey] === true);
  if (!directory || !sessionId || !snapshot) return null;
  const projectItems = snapshot.queued.filter(item => item.directory === directory);
  const index = projectItems.findIndex(item => item.sessionId === sessionId);
  const active = snapshot.active.find(item => item.directory === directory);
  const issue = snapshot.issues.find(item => item.directory === directory)?.issue;
  if (index < 0 && active?.sessionId !== sessionId && !(enabled && (active || issue))) return null;
  const queuedItem = index >= 0 ? projectItems[index] : null;
  const status = queuedItem
    ? 'Queued for build · #' + (index + 1) + ' of ' + projectItems.length
    : active?.sessionId === sessionId ? 'Build running'
    : issue ? 'Build queue paused: working tree is not clean'
    : 'Build running in another chat';
  const open = () => useUIStore.getState().openContextSurface(directory, 'build-queue');
  const cancel = async () => {
    if (!queuedItem) return;
    const response = await runtimeFetch('/api/build-queue/sessions/' + encodeURIComponent(sessionId) +
      '/items/' + encodeURIComponent(queuedItem.id), { method: 'DELETE' });
    if (response.ok) void refresh();
  };
  return <div role="status" className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-xs">
    <span className="min-w-0 truncate">{status}</span>
    <span className="flex gap-3 shrink-0">
      {queuedItem && <button type="button" className="underline" onClick={() => void cancel()}>Cancel</button>}
      <button type="button" className="underline" onClick={open}>Queue</button>
    </span>
  </div>;
};
