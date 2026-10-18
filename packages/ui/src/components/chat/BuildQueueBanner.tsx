import React from 'react';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useBuildQueueSnapshot } from '@/hooks/useBuildQueueSnapshot';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { createMessageQueueTarget, useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { workBoardDirectoryKey } from '@/components/workBoard/workBoardWorkflow';
import { rememberWorkBoardReturn } from '@/components/workBoard/workBoardReturn';

/**
 * The in-session build queue row. Cancelling a queued build hands the prompt
 * back to the composer (`onMessageRestored`) so the typed message is not lost.
 */
export const BuildQueueBanner: React.FC<{
  sessionId: string | null;
  directory: string | null;
  onMessageRestored?: (message: QueuedMessage) => void;
}> = ({ sessionId, directory, onMessageRestored }) => {
  const { snapshot, refresh } = useBuildQueueSnapshot();
  const { t } = useI18n();
  if (!directory || !sessionId || !snapshot) return null;

  const projectKey = workBoardDirectoryKey(directory);
  const active = snapshot.active.find(item => workBoardDirectoryKey(item.directory) === projectKey);
  // The lease's own item can still sit in the queue while it dispatches, or when
  // a parked lane is adopted; it is the active build, not a waiting one.
  const projectItems = snapshot.queued.filter(item =>
    workBoardDirectoryKey(item.directory) === projectKey && item.id !== active?.itemId);
  const index = projectItems.findIndex(item => item.sessionId === sessionId);
  const sessionItems = projectItems.filter(item => item.sessionId === sessionId);
  const issue = snapshot.issues.find(item => workBoardDirectoryKey(item.directory) === projectKey)?.issue;
  if (index < 0 && active?.sessionId !== sessionId) return null;

  const queuedItem = index >= 0 ? projectItems[index] : null;
  const badge = queuedItem
    ? t('chat.buildQueue.queued', { position: index + 1, total: projectItems.length })
    : active?.needsReview ? t('chat.buildQueue.needsReview')
    : issue ? t('chat.buildQueue.paused')
    : t('chat.buildQueue.running');
  const detail = queuedItem && sessionItems.length > 1
    ? t('chat.buildQueue.sessionCount', { count: sessionItems.length })
    : null;

  const openBoard = () => {
    rememberWorkBoardReturn();
    useUIStore.getState().setWorkBoardOpen(true);
  };

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
      <div className="truncate text-xs font-semibold">{badge}</div>
      {detail && <div className="truncate text-[11px] text-muted-foreground">{detail}</div>}
    </div>
    {queuedItem && <Button type="button" variant="ghost" size="xs" onClick={() => void cancel()}>
      {t('chat.buildQueue.cancel')}
    </Button>}
    <Button type="button" variant="link" size="xs" onClick={openBoard}>
      {t('chat.buildQueue.openBoard')}
    </Button>
  </div>;
};
