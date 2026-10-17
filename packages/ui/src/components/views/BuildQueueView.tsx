import React from 'react';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { useBuildQueueDirectory } from '@/hooks/useEffectiveDirectory';
import { useBuildQueueSnapshot, type BuildQueueEntry } from '@/hooks/useBuildQueueSnapshot';
import { useBuildQueuePreferences } from '@/stores/buildQueuePreferences';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useDirectorySync } from '@/sync/sync-context';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { SettingsSection, SettingsStackedField, SETTINGS_SELECT_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { z } from 'zod';

const projectKey = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
const snippet = (value: string) => value.trim().split('\n').find(line => line.trim())?.trim() || 'Queued build';
const forceResponseSchema = z.object({ error: z.string().optional(), warning: z.string().optional() });

export const BuildQueueView: React.FC = () => {
  const directory = useBuildQueueDirectory() ?? '';
  const key = projectKey(directory);
  const enabled = useBuildQueuePreferences(state => state.enabled[key] === true);
  const setEnabled = useBuildQueuePreferences(state => state.setEnabled);
  const preferenceError = useBuildQueuePreferences(state => state.syncError);
  const { snapshot, error, refresh } = useBuildQueueSnapshot();
  const [busy, setBusy] = React.useState(false);
  const [confirmation, setConfirmation] = React.useState<{ directory: string; itemId: string; issue: string } | null>(null);
  const [resolveError, setResolveError] = React.useState<string | null>(null);
  const [forceTarget, setForceTarget] = React.useState<BuildQueueEntry | null>(null);
  const [forceError, setForceError] = React.useState<string | null>(null);
  const { t } = useI18n();
  const policy = useUIStore(state => state.buildQueueGitPolicy ?? (state.buildQueueRequireCleanGit ? 'pause' : 'continue'));
  const setPolicy = useUIStore(state => state.setBuildQueueGitPolicy);
  const preparation = snapshot?.preparation?.find(item => projectKey(item.directory) === key);
  const lastCommit = snapshot?.commits?.find(item => projectKey(item.directory) === key);

  const items = snapshot?.queued.filter(item => projectKey(item.directory) === key) ?? [];
  const active = snapshot?.active.find(item => projectKey(item.directory) === key);
  const forced = snapshot?.forced?.filter(item => projectKey(item.directory) === key) ?? [];
  const issue = snapshot?.issues.find(item => projectKey(item.directory) === key)?.issue;
  const paused = Boolean(issue || active?.needsReview);
  // Subscribed to the directory's own sync slice, not read imperatively: the
  // queue snapshot polls every three seconds, so a non-reactive read would keep
  // resolving titles against a session list that has since materialized,
  // leaving rows labelled "Session ses_...".
  const sessions = useDirectorySync(state => state.session, directory);
  const sessionTitle = (sessionId: string) =>
    sessions.find(session => session.id === sessionId)?.title || 'Session ' + sessionId.slice(0, 9);
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

  const togglePause = (item: BuildQueueEntry) =>
    mutate('/api/build-queue/sessions/' + encodeURIComponent(item.sessionId) +
      '/items/' + encodeURIComponent(item.id) + '/pause', 'PUT', { paused: !item.paused });

  const move = (index: number, delta: number) => {
    const order = items.map(item => item.id);
    const other = index + delta;
    if (other < 0 || other >= order.length) return;
    [order[index], order[other]] = [order[other], order[index]];
    void mutate('/api/build-queue/order', 'PUT', { directory, ids: order });
  };

  const continueQueue = async () => {
    if (!confirmation) return;
    setBusy(true);
    setResolveError(null);
    try {
      const response = await runtimeFetch('/api/build-queue/resolve', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory: confirmation.directory, itemId: confirmation.itemId, action: 'skip' }),
      });
      if (!response.ok) {
        const detail: { error?: string } = await response.json();
        throw new Error(detail.error || `HTTP ${response.status}`);
      }
      setConfirmation(null);
      await refresh();
    } catch (cause) {
      setResolveError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const forceBuild = async () => {
    if (!forceTarget) return;
    setBusy(true);
    setForceError(null);
    try {
      const response = await runtimeFetch('/api/build-queue/force', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ directory, sessionId: forceTarget.sessionId, itemId: forceTarget.id }),
      });
      const detail = forceResponseSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok) throw new Error((detail.success && detail.data.error) || `HTTP ${response.status}`);
      setForceTarget(null);
      await refresh();
      // The prompt may have been accepted despite the lost response; the item
      // stays queued, so say so rather than let a resend run it twice.
      if (detail.success && detail.data.warning) toast.error(detail.data.warning);
    } catch (cause) {
      setForceError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
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
              onCheckedChange={checked => { void setEnabled(directory, checked).catch(() => undefined); }} disabled={!directory} />
          </div>
        </div>
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          {enabled ? 'Build prompts are queued automatically. Each reply stays in its own chat.' :
            'Enable to queue Build prompts across this project. Plan sessions are unaffected.'}
        </p>
      </div>

      {preferenceError && <div role="alert" className="px-5 pt-3 text-xs text-[var(--error-text)]">{preferenceError}</div>}
      <div className="px-5 py-5 space-y-6">
        <SettingsSection divider={false} className="py-0">
          <SettingsStackedField label={t('settings.openchamber.buildQueue.policy.title')}>
            <Select value={policy} onValueChange={value => {
              if (value === 'continue' || value === 'commit' || value === 'pause') setPolicy(value);
            }}>
              <SelectTrigger className={SETTINGS_SELECT_TRIGGER_CLASS}
                aria-label={t('settings.openchamber.buildQueue.policy.title')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="continue">{t('settings.openchamber.buildQueue.policy.continue')}</SelectItem>
                <SelectItem value="commit">{t('settings.openchamber.buildQueue.policy.commit')}</SelectItem>
                <SelectItem value="pause">{t('settings.openchamber.buildQueue.policy.pause')}</SelectItem>
              </SelectContent>
            </Select>
          </SettingsStackedField>
          <p className="text-xs text-muted-foreground">{t('settings.openchamber.buildQueue.policy.scope')}</p>
          <p className="text-xs leading-5 text-muted-foreground">{t(policy === 'commit'
            ? 'settings.openchamber.buildQueue.policy.commitInfo'
            : policy === 'continue' ? 'settings.openchamber.buildQueue.policy.continueInfo'
              : 'settings.openchamber.buildQueue.policy.pauseInfo')}</p>
          {preparation && <p role="status" className="text-xs text-muted-foreground">{t(
            preparation.phase === 'staging' ? 'settings.openchamber.buildQueue.policy.staging'
              : preparation.phase === 'generating' ? 'settings.openchamber.buildQueue.policy.generating'
                : preparation.phase === 'committing' ? 'settings.openchamber.buildQueue.policy.committing'
                  : 'settings.openchamber.buildQueue.policy.preparing')}</p>}
          {lastCommit && <p className="text-xs text-muted-foreground" dir="auto"><code>{lastCommit.hash.slice(0, 9)}</code> {lastCommit.subject}</p>}
        </SettingsSection>
        {error && <div role="alert" className="rounded-lg border border-[var(--status-error)]/30 px-3 py-2 text-xs text-[var(--error-text)]">
          Could not update queue: {error}
        </div>}

        {paused && <section role="alert" className="rounded-lg border border-[var(--status-warning)]/40 bg-[color-mix(in_srgb,var(--status-warning)_7%,transparent)] px-3.5 py-3">
          <div className="flex items-center gap-2 font-semibold text-sm"><Icon name="time" className="size-4" /> Queue paused</div>
          <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{issue || 'Previous build needs review before continuing.'}</p>
          {!active && issue && <Button size="sm" variant="outline" className="mt-3" disabled={busy || Boolean(preparation)}
            onClick={() => void mutate('/api/build-queue/resolve', 'POST', { directory, action: 'retry' })}>
            {t('settings.openchamber.buildQueue.policy.retry')}
          </Button>}
          {active?.needsReview && <div className="flex flex-wrap gap-2 mt-3">
            <Button size="sm" variant="outline" onClick={() => openSession(active.sessionId)}>
              Open session
            </Button>
            <Button size="sm" variant="default" disabled={busy} onClick={() => {
              setResolveError(null);
              setConfirmation({ directory: active.directory, itemId: active.itemId,
                issue: issue || t('buildQueue.recovery.fallback') });
            }}>
              {t('buildQueue.recovery.continue')}
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
            className={'group w-full rounded-lg border px-4 py-3.5 text-start transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
              (active.needsReview ? 'border-[var(--status-error)]/50 bg-[color-mix(in_srgb,var(--status-error)_10%,transparent)]' : 'border-border bg-surface-elevated')}>
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

        {forced.length > 0 && <section aria-label={t('buildQueue.force.outsideQueue')}>
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm">{t('buildQueue.force.outsideQueue')}</h3>
            <span className="flex items-center gap-1.5 text-[11px] text-[var(--status-warning-text)]">
              <span className="size-1.5 rounded-full bg-[var(--status-warning)] animate-pulse" />{t('workBoard.active')}
            </span>
          </div>
          <div className="space-y-2">
            {forced.map(entry => <button key={entry.sessionId} type="button" onClick={() => openSession(entry.sessionId)}
              className="group w-full rounded-lg border border-[color-mix(in_srgb,var(--status-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--status-warning)_8%,transparent)] px-4 py-3.5 text-start transition-colors hover:bg-[color-mix(in_srgb,var(--status-warning)_14%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <div className="flex items-center gap-2">
                <span className="flex size-8 items-center justify-center rounded-md bg-[color-mix(in_srgb,var(--status-warning)_20%,transparent)] text-[var(--status-warning-text)]">
                  <Icon name="rocket" className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{sessionTitle(entry.sessionId)}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{t('buildQueue.force.outsideQueue')}</div>
                </div>
                <Icon name="arrow-right-s" className="size-4 text-muted-foreground group-hover:text-foreground" />
              </div>
            </button>)}
          </div>
        </section>}

        <section aria-label="Waiting builds">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold text-sm">Up next</h3>
            <span className="rounded-md bg-surface-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">{items.length} queued</span>
          </div>
          {items.length === 0 ? <div className="rounded-lg border border-dashed border-border px-4 py-6 text-center">
            <Icon name="route" className="size-5 mx-auto text-muted-foreground" />
            <div className="mt-2 text-xs font-medium">Queue is clear</div>
            <div className="mt-1 text-[11px] text-muted-foreground">Send a prompt to the Build agent to add one.</div>
          </div> : <div className="space-y-2">
            {items.map((item, index) => <div key={item.id} className="group relative rounded-lg border border-border bg-surface-elevated transition-colors hover:bg-interactive-hover focus-within:bg-interactive-hover">
              <div className="flex items-center gap-2 px-4 py-3.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-[var(--interactive-selection)] text-xs font-semibold tabular-nums text-muted-foreground">
                  {index + 1}
                </span>
                <button type="button" onClick={() => openSession(item.sessionId)} className="min-w-0 flex-1 text-start focus-visible:outline-none focus-visible:underline">
                  <div dir="auto" className="truncate oc-ui-start-align text-sm font-semibold">{sessionTitle(item.sessionId)}</div>
                  <p dir="auto" className="mt-0.5 truncate oc-ui-start-align text-[11px] text-muted-foreground">{snippet(item.content)}</p>
                </button>
                <div className="flex shrink-0 items-center gap-1 transition-opacity sm:pointer-events-none sm:opacity-0 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 sm:group-focus-within:pointer-events-auto sm:group-focus-within:opacity-100">
                  <Button size="icon" variant="ghost" disabled={busy}
                    aria-label={item.paused ? t('settings.openchamber.buildQueue.item.resume') : t('settings.openchamber.buildQueue.item.pause')}
                    title={item.paused ? t('settings.openchamber.buildQueue.item.resume') : t('settings.openchamber.buildQueue.item.pause')}
                    onClick={() => togglePause(item)}>
                    <Icon name={item.paused ? 'play' : 'time'} className="size-4" />
                  </Button>
                  <Button size="icon" variant="ghost" disabled={busy}
                    aria-label={t('buildQueue.force.action')} title={t('buildQueue.force.action')}
                    onClick={() => { setForceError(null); setForceTarget(item); }}>
                    <Icon name="rocket" className="size-4" />
                  </Button>
                  <button type="button" aria-label={`Move build ${index + 1} up`} title="Move up" disabled={busy || index === 0}
                    onClick={() => move(index, -1)} className="size-7 rounded-md inline-flex items-center justify-center hover:bg-surface-muted disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Icon name="arrow-up-s" className="size-4" />
                  </button>
                  <button type="button" aria-label={`Move build ${index + 1} down`} title="Move down" disabled={busy || index === items.length - 1}
                    onClick={() => move(index, 1)} className="size-7 rounded-md inline-flex items-center justify-center hover:bg-surface-muted disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Icon name="arrow-down-s" className="size-4" />
                  </button>
                  <span className="mx-0.5 h-4 w-px bg-border" />
                  <button type="button" aria-label={`Cancel build ${index + 1}`} title="Cancel" disabled={busy}
                    onClick={() => void cancel(item)} className="size-7 rounded-md inline-flex items-center justify-center text-muted-foreground hover:bg-surface-muted hover:text-[var(--error-text)] disabled:opacity-25 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    <Icon name="close" className="size-4" />
                  </button>
                </div>
              </div>
            </div>)}
          </div>}
        </section>

      </div>
      <Dialog open={confirmation !== null} onOpenChange={open => { if (!open && !busy) setConfirmation(null); }}>
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>{t('buildQueue.recovery.title')}</DialogTitle>
            <DialogDescription>{t('buildQueue.recovery.description')}</DialogDescription>
          </DialogHeader>
          <p className="text-sm text-muted-foreground whitespace-pre-wrap">{confirmation?.issue}</p>
          {resolveError && <p role="alert" className="text-sm text-[var(--error-text)]">{resolveError}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setConfirmation(null)}>{t('dialog.common.actions.cancel')}</Button>
            <Button disabled={busy} onClick={() => void continueQueue()}>{t('buildQueue.recovery.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={forceTarget !== null} onOpenChange={open => { if (!open && !busy) setForceTarget(null); }}>
        <DialogContent showCloseButton={!busy}>
          <DialogHeader>
            <DialogTitle>{t('buildQueue.force.title')}</DialogTitle>
            <DialogDescription>{t('buildQueue.force.description')}</DialogDescription>
          </DialogHeader>
          {forceTarget && <p className="text-sm text-muted-foreground" dir="auto">{sessionTitle(forceTarget.sessionId)}</p>}
          {forceError && <p role="alert" className="text-sm text-[var(--error-text)]">{forceError}</p>}
          <DialogFooter>
            <Button variant="outline" disabled={busy} onClick={() => setForceTarget(null)}>{t('dialog.common.actions.cancel')}</Button>
            <Button disabled={busy} onClick={() => void forceBuild()}>{t('buildQueue.force.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
};
