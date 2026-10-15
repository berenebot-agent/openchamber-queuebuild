import React from 'react';
import { Button } from '@/components/ui/button';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { fetchSessionWorkBoardCards, type WorkBoardCard } from '@/lib/workBoardApi';
import { SavedTodoBrief } from './SavedTodoBrief';
import { useWorkBoardSavedTodo } from './workBoardSavedTodo';

/** Board-backed transcript entries. Saving them never creates an OpenCode turn. */
export function SessionSavedTodos({ sessionId }: { sessionId: string }) {
  const { t } = useI18n();
  const runtimeKey = React.useSyncExternalStore(subscribeRuntimeEndpointChanged, getRuntimeKey);
  const latestSave = useWorkBoardSavedTodo(state => state.latestSave);
  const [retry, setRetry] = React.useState(0);
  const [result, setResult] = React.useState<{ scope: string; cards: WorkBoardCard[]; failed: boolean; save: WorkBoardCard | null } | null>(null);
  const scope = `${runtimeKey}:${sessionId}`;

  React.useEffect(() => {
    if (isVSCodeRuntime()) return;
    let cancelled = false;
    let sequence = 0;
    const load = async () => {
      const request = ++sequence;
      try {
        const cards = await fetchSessionWorkBoardCards(sessionId);
        if (!cancelled && request === sequence && runtimeKey === getRuntimeKey()) setResult({ scope, cards, failed: false, save: latestSave?.card ?? null });
      } catch {
        if (!cancelled && request === sequence && runtimeKey === getRuntimeKey()) {
          setResult(previous => ({ scope, cards: previous?.scope === scope ? previous.cards : [], failed: true, save: previous?.scope === scope ? previous.save : null }));
        }
      }
    };
    void load();
    window.addEventListener('focus', load);
    return () => { cancelled = true; window.removeEventListener('focus', load); };
  }, [sessionId, runtimeKey, scope, latestSave, retry]);

  if (isVSCodeRuntime()) return null;
  const current = result?.scope === scope ? result : null;
  const saved = latestSave?.runtimeKey === runtimeKey && latestSave.card.sessionId === sessionId ? latestSave.card : null;
  // An accepted save is newer than an in-flight read. Keep it visible even if
  // the refresh fails; the next successful read reconciles the server contents.
  const cards = saved && current?.save !== saved
    ? [...(current?.cards.filter(card => card.id !== saved.id) ?? []), saved]
    : current?.cards ?? (saved ? [saved] : []);
  // A parked brief is a pending message. Once the card is promoted, its text is
  // a real user turn in the transcript, so the footer entry would duplicate it.
  // Only a card still in To-do carries text the session has not received.
  const pending = cards.filter(card => card.stage === 'todo');
  if (!pending.length && !current?.failed) return null;
  return <div className="mx-auto w-full max-w-3xl space-y-3 px-4 py-3">
    {pending.map(card => <SavedTodoBrief key={card.id} card={card} />)}
    {current?.failed && <div role="alert" className="text-sm text-muted-foreground">
      {t('workBoard.loadSavedFailed')}
      <Button size="sm" variant="ghost" onClick={() => setRetry(value => value + 1)}>{t('workBoard.retry')}</Button>
    </div>}
  </div>;
}
