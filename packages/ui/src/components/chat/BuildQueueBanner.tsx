import React from 'react';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { useBuildQueueSnapshot } from '@/hooks/useBuildQueueSnapshot';
import { useBuildQueuePreferences } from '@/stores/buildQueuePreferences';
import { useUIStore } from '@/stores/useUIStore';
import { createMessageQueueTarget, useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { workBoardDirectoryKey } from '@/components/workBoard/workBoardWorkflow';

/**
 * The in-session build queue row. Cancelling a queued build hands the prompt
 * back to the composer (`onMessageRestored`) so the typed message is not lost;
 * the project-wide pane and work board only remove it.
 */
export const BuildQueueBanner: React.FC<{
  sessionId: string | null;
  directory: string | null;
  onMessageRestored?: (message: QueuedMessage) => void;
}> = ({ sessionId, directory, onMessageRestored }) => {
  const { snapshot, refresh } = useBuildQueueSnapshot();
  const key = (directory ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
  const enabled = useBuildQueuePreferences(state => state.enabled[key] === true);
  if (!directory || !sessionId || !snapshot) return null;

  const projectItems = snapshot.queued.filter(item => workBoardDirectoryKey(item.directory) === workBoardDirectoryKey(directory));
  const index = projectItems.findIndex(item => item.sessionId === sessionId);
  const sessionItems = projectItems.filter(item => item.sessionId === sessionId);
  const active = snapshot.active.find(item => workBoardDirectoryKey(item.directory) === workBoardDirectoryKey(directory));
  const issue = snapshot.issues.find(item => workBoardDirectoryKey(item.directory) === workBoardDirectoryKey(directory))?.issue;
  if (index < 0 && active?.sessionId !== sessionId && !(enabled && (active || issue))) return null;

  const queuedItem = index >= 0 ? projectItems[index] : null;
  const status = queuedItem
    ? `Queued for build · #${index + 1} of ${projectItems.length}`
    : active?.sessionId === sessionId ? (active.needsReview ? 'Build needs review' : 'Build running')
    : issue ? 'Project build queue paused'
    : 'Building in another session';
  const detail = queuedItem && sessionItems.length > 1 ? `${sessionItems.length} builds from this chat` : null;

  const open = () => useUIStore.getState().openContextSurface(directory, 'build-queue');
  const cancel = async () => {
    if (!queuedItem) return;
    const target = createMessageQueueTarget(sessionId, directory);
    if (!target) return;
    try {
      const restored = await useMessageQueueStore.getState().cancelBuild(target, queuedItem.id);
      await refresh();
      if (restored) onMessageRestored?.(restored);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return <div role="status" className="flex items-center gap-2.5 border-b border-border/60 bg-[color-mix(in_srgb,var(--status-info)_4%,transparent)] px-3 py-2">
    <Icon name={queuedItem ? 'time' : 'route'} className="size-4 shrink-0 text-muted-foreground" />
    <div className="min-w-0 flex-1">
      <div className="truncate text-xs font-semibold">{status}</div>
      {detail && <div className="truncate text-[11px] text-muted-foreground">{detail}</div>}
    </div>
    {queuedItem && <button type="button" className="text-[11px] font-medium text-muted-foreground hover:text-foreground" onClick={() => void cancel()}>
      Cancel
    </button>}
    <button type="button" className="text-[11px] font-semibold text-[var(--info-text)] hover:underline" onClick={open}>
      View queue
    </button>
  </div>;
};
