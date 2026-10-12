import React from 'react';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { useBuildQueueSnapshot, type BuildQueueEntry } from '@/hooks/useBuildQueueSnapshot';
import { useBuildQueuePreferences } from '@/stores/buildQueuePreferences';
import { useSessionUIStore } from '@/sync/session-ui-store';

const projectKey = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
const snippet = (value: string) => value.trim().split('\n').find(line => line.trim())?.trim() || 'Queued build';

export const BuildQueueView: React.FC = () => {
  const directory = useEffectiveDirectory() ?? '';
  const key = projectKey(directory);
  const enabled = useBuildQueuePreferences(state => state.enabled[key] === true);
  const setEnabled = useBuildQueuePreferences(state => state.setEnabled);
  const { snapshot, error, refresh } = useBuildQueueSnapshot();
  const [busy, setBusy] = React.useState(false);

  const items = snapshot?.queued.filter(item => projectKey(item.directory) === key) ?? [];
  const active = snapshot?.active.find(item => projectKey(item.directory) === key);
  const issue = snapshot?.issues.find(item => projectKey(item.directory) === key)?.issue;
  const paused = Boolean(issue || active?.needsReview);
  const sessionTitle = (sessionId: string) =>
    useSessionUIStore.getState().getSessionsByDirectory(directory)
      .find(session => session.id === sessionId)?.title || 'Session ' + sessionId.slice(0, 9);
  const openSession = (sessionId: string) => useSessionUIStore.getState().setCurrentSession(sessionId, directory);

  const mutate = async (url: string, method: 'PUT' | 'POST' | 'DELETE', body?: object) => {
    setBusy(true);
    try {
      const response = await runtimeFetch(url, {
        method,
        ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        const detail = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(detail?.error || `Request failed (${response.status})`);
      }
      await refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const cancel = (item: BuildQueueEntry) =>
    mutate('/api/build-queue/sessions/' + encodeURIComponent(item.sessionId) +
      '/items/' + encodeURIComponent(item.id), 'DELETE');

  const move = (index: number, delta: number) => {
    const order = items.map(item => item.id);
    const other = index + delta;
    if (other < 0 || other >= order.length) return;
    [order[index], order[other]] = [order[other], order[index]];
    void mutate('/api/build-queue/order', 'PUT', { directory, ids: order });
  };

  const resolve = (action: 'skip' | 'retry') => {
    const prompt = action === 'retry'
      ? 'Retry this build? Check the session first: it may already have made changes.'
      : 'Continue the queue? Only do this after reviewing the previous build session and its changes.';
    if (!window.confirm(prompt)) return;
    void mutate('/api/build-queue/resolve', 'POST', { directory, action });
  };

  return (
    <div className="h-full overflow-y-auto bg-background text-foreground">
      <div className="px-5 pt-5 pb-4 border-b border-border/60">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Project workflow</div>
            <h2 className="mt-1 text-lg font-semibold tracking-tight">Build queue</h2>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Plan in parallel. Build in sequence.</p>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-border/70 px-3 py-2 bg-surface-elevated shrink-0">
            <span className="text-xs font-medium">{enabled ? 'On' : 'Off'}</span>
            <Switch aria-label="Queue Build agent prompts for this project" checked={enabled}
              onCheckedChange={checked => setEnabled(directory, checked)} disabled={!directory} />
          </div>
        </div>
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          {enabled ? 'Build prompts are queued automatically. Each reply stays in its own chat.' :
            'Enable to queue Build prompts across this project. Plan sessions are unaffected.'}
        </p>
      </div>

      <div className="px-5 py-5 space-y-6">
        {error && <div role="alert" className="rounded-lg border border-[var(--status-error)]/30 px-3 py-2 text-xs text-[var(--error-text)]">
          Could not update queue: {error}
        </div>}

        {paused && <section role="alert" className="rounded-lg border border-[var(--status-warning)]/40 bg-[color-mix(in_srgb,var(--status-warning)_7%,transparent)] px-3.5 py-3">
          <div className="flex items-center gap-2 font-semibold text-sm"><Icon name="time" className="size-4" /> Queue paused</div>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{issue || 'Previous build needs review before continuing.'}</p>
          {active?.needsReview && <div className="flex flex-wrap gap-2 mt-3">
            <Button size="sm" variant="outline" onClick={() => openSession(active.sessionId)}>
              Open session
            </Button>
            {active.retryAvailable && <Button size="sm" variant="outline" disabled={busy} onClick={() => resolve('retry')}>
              Retry
            </Button>}
            <Button size="sm" variant="default" disabled={busy} onClick={() => resolve('skip')}>
              Continue queue
            </Button>
          </div>}
        </section>}

        <section aria-label="Active build">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm">Now building</h3>
            {active && !active.needsReview && <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className="size-1.5 rounded-full bg-[var(--status-success)] animate-pulse" /> Active
            </span>}
          </div>
          {active ? <button type="button" onClick={() => openSession(active.sessionId)}
            className="group w-full rounded-lg border border-border bg-surface-elevated px-4 py-3.5 text-left transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-md bg-[var(--interactive-selection)]">
                <Icon name="terminal-box" className="size-4" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{sessionTitle(active.sessionId)}</div>
                <div className="mt-0.5 text-[11px] text-muted-foreground">
                  {active.needsReview ? 'Waiting for review' : 'Started ' + new Date(active.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                </div>
              </div>
              <Icon name="arrow-right-s" className="size-4 text-muted-foreground group-hover:text-foreground" />
            </div>
          </button> : <div className="rounded-lg border border-dashed border-border px-4 py-5 text-center">
            <div className="text-xs font-medium text-muted-foreground">No build running</div>
            <div className="mt-1 text-[11px] text-muted-foreground/70">The next queued build starts when the project is ready.</div>
          </div>}
        </section>

        <section aria-label="Waiting builds">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm">Up next</h3>
            <span className="rounded-md bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{items.length} queued</span>
          </div>
          {items.length === 0 ? <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
            <Icon name="route" className="size-5 mx-auto text-muted-foreground" />
            <div className="mt-2 text-xs font-medium">Queue is clear</div>
            <div className="mt-1 text-[11px] text-muted-foreground">Send a prompt to the Build agent to add one.</div>
          </div> : <div className="rounded-lg border border-border/70 overflow-hidden divide-y divide-border/60">
            {items.map((item, index) => <div key={item.id} className="px-3 py-3 group hover:bg-interactive-hover transition-colors">
              <div className="flex items-start gap-3">
                <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 text-xs font-semibold tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <button type="button" onClick={() => openSession(item.sessionId)} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:underline">
                  <div className="text-xs font-semibold truncate">{sessionTitle(item.sessionId)}</div>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground line-clamp-2 break-words">{snippet(item.content)}</p>
                </button>
              </div>
              <div className="mt-2.5 flex items-center justify-end gap-1">
                <button type="button" aria-label={`Move build ${index + 1} up`} title="Move up" disabled={busy || index === 0}
                  onClick={() => move(index, -1)} className="size-7 rounded-md inline-flex items-center justify-center hover:bg-surface-muted disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Icon name="arrow-up-s" className="size-4" />
                </button>
                <button type="button" aria-label={`Move build ${index + 1} down`} title="Move down" disabled={busy || index === items.length - 1}
                  onClick={() => move(index, 1)} className="size-7 rounded-md inline-flex items-center justify-center hover:bg-surface-muted disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Icon name="arrow-down-s" className="size-4" />
                </button>
                <span className="mx-1 h-4 w-px bg-border" />
                <button type="button" aria-label={`Cancel build ${index + 1}`} title="Cancel" disabled={busy}
                  onClick={() => void cancel(item)} className="size-7 rounded-md inline-flex items-center justify-center text-muted-foreground hover:bg-surface-muted hover:text-[var(--error-text)] disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  <Icon name="close" className="size-4" />
                </button>
              </div>
            </div>)}
          </div>}
        </section>

        <div className="flex gap-2 border-t border-border/60 pt-4 text-[11px] leading-5 text-muted-foreground">
          <Icon name="git-branch" className="size-4 mt-0.5 shrink-0" />
          <p>The next build waits for a clean Git working tree. No automatic staging, stashing or provisional commits.</p>
        </div>
      </div>
    </div>
  );
};
