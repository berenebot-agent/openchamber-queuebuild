import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { useI18n } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { prepareLocalAttachments } from '@/sync/input-store';
import { createSession } from '@/sync/session-actions';
import { hasActiveSubagent } from '@/sync/global-session-status';
import { hasRunningShell } from '@/sync/background-shells';
import { opencodeClient } from '@/lib/opencode/client';
import { isAutoModel } from '@/lib/routing/autoModel';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useBuildQueueSnapshot } from '@/hooks/useBuildQueueSnapshot';
import { fetchWorkBoard, createWorkBoardCard, updateWorkBoardCard, deleteWorkBoardCard, type WorkBoardCard, type WorkBoardAttachment } from '@/lib/workBoardApi';
import { workBoardLane, startWorkBoardPlan, captureWorkBoardAttachments, type WorkBoardActivity, type WorkBoardLane } from './workBoardWorkflow';

const lanes: WorkBoardLane[] = ['todo', 'plan', 'queued', 'building', 'done'];

export function WorkBoardView() {
  const { t } = useI18n();
  const projects = useProjectsStore(state => state.projects);
  const activeProjectId = useProjectsStore(state => state.activeProjectId);
  const [projectId, setProjectId] = React.useState(activeProjectId ?? projects[0]?.id ?? '');
  const directory = projects.find(project => project.id === projectId)?.path ?? '';
  const [cards, setCards] = React.useState<WorkBoardCard[]>([]);
  const [activities, setActivities] = React.useState<Map<string, WorkBoardActivity>>(new Map());
  const [unavailable, setUnavailable] = React.useState<Set<string>>(new Set());
  const [error, setError] = React.useState('');
  const [actionError, setActionError] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [text, setText] = React.useState('');
  const [files, setFiles] = React.useState<WorkBoardAttachment[]>([]);
  const configProvider = useConfigStore(state => state.currentProviderId);
  const configModel = useConfigStore(state => state.currentModelId);
  const agents = useConfigStore(state => state.agents);
  const sessions = useGlobalSessionsStore(state => state.activeSessions);
  const sessionsError = useGlobalSessionsStore(state => state.status === 'error');
  const [selection, setSelection] = React.useState({ providerID: configProvider, modelID: configModel });
  const { snapshot: queue, error: queueError } = useBuildQueueSnapshot();
  const generation = React.useRef(0);
  const refreshSequence = React.useRef(0);
  const refreshing = React.useRef(false);
  const visibleCards = React.useMemo(() => {
    const linked = new Set(cards.map(card => card.sessionId));
    const existing: WorkBoardCard[] = sessions.filter(session => session.directory === directory && !session.parentID && !linked.has(session.id))
      .map(session => ({ id: `session:${session.id}`, directory, text: session.title, attachments: [],
        sessionId: session.id, stage: 'plan', createdAt: session.time.created, updatedAt: session.time.updated }));
    return [...cards, ...existing];
  }, [cards, sessions, directory]);
  const cardsRef = React.useRef(visibleCards);
  cardsRef.current = visibleCards;
  const sessionVersions = React.useRef(new Map<string, number>());
  const messageCache = React.useRef(new Map<string, WorkBoardActivity['messages']>());
  const versionsRef = React.useRef(new Map(sessions.map(session => [session.id, session.time.updated])));
  versionsRef.current = new Map(sessions.map(session => [session.id, session.time.updated]));

  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    generation.current += 1;
    useUIStore.getState().setWorkBoardOpen(false);
  }), []);

  const refresh = React.useCallback(async () => {
    const token = generation.current;
    const sequence = ++refreshSequence.current;
    const runtime = getRuntimeKey();
    if (!directory) { setLoading(false); return; }
    try {
      const next = await fetchWorkBoard(directory);
      if (token !== generation.current || sequence !== refreshSequence.current || runtime !== getRuntimeKey()) return;
      setCards(next);
      setError('');
    } catch (cause) {
      if (token === generation.current && sequence === refreshSequence.current && runtime === getRuntimeKey()) {
        setError(cause instanceof Error ? cause.message : t('workBoard.failed'));
      }
    } finally {
      if (token === generation.current && sequence === refreshSequence.current && runtime === getRuntimeKey()) setLoading(false);
    }
  }, [directory, t]);

  React.useEffect(() => {
    generation.current += 1;
    setCards([]);
    setLoading(true);
    setError('');
    setActionError('');
    setActivities(new Map());
    setUnavailable(new Set());
    sessionVersions.current.clear();
    messageCache.current.clear();
    setEditing(null);
    void refresh();
    const onFocus = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    const timer = setInterval(onFocus, 30000);
    return () => { generation.current += 1; clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [refresh]);

  // History identifies the agent that actually ran. Live status decides whether
  // a completed step can be treated as a settled turn.
  React.useEffect(() => {
    let cancelled = false;
    const readActivity = async () => {
      if (refreshing.current || document.visibilityState !== 'visible') return;
      refreshing.current = true;
      const runtime = getRuntimeKey();
      const token = generation.current;
      const next = new Map<string, WorkBoardActivity>();
      const failed = new Set<string>();
      try {
        const status = await opencodeClient.getActiveSessionStatuses(directory);
        if (cancelled || token !== generation.current || runtime !== getRuntimeKey()) return;
        const activeIds = new Set(Object.keys(status ?? {}));
        const linked = cardsRef.current.filter(card => card.sessionId);
        for (let index = 0; index < linked.length; index += 4) {
          if (cancelled || token !== generation.current || runtime !== getRuntimeKey()) return;
          await Promise.all(linked.slice(index, index + 4).map(async card => {
            if (!card.sessionId) return;
            if (status === null) { failed.add(card.id); return; }
            try {
              const version = versionsRef.current.get(card.sessionId);
              const cached = messageCache.current.get(card.id);
              const running = Boolean(status[card.sessionId]) || hasActiveSubagent(card.sessionId, activeIds) || hasRunningShell(card.sessionId);
              if (cached?.at(-1)?.role === 'idle' && version !== undefined && sessionVersions.current.get(card.id) === version && !running) {
                next.set(card.id, { busy: false, messages: cached });
                return;
              }
              const page = await opencodeClient.getSessionMessages(card.sessionId, { limit: 32, order: 'desc', partShells: true }, card.directory);
              const messages = page.items.map(item => item.info).reverse();
              if (!cancelled && runtime === getRuntimeKey() && token === generation.current) {
                if (version !== undefined) sessionVersions.current.set(card.id, version);
                messageCache.current.set(card.id, messages);
              }
              next.set(card.id, { busy: running, messages });
            } catch { failed.add(card.id); }
          }));
        }
        if (!cancelled && token === generation.current && runtime === getRuntimeKey()) {
          setActivities(previous => new Map([...previous, ...next]));
          setUnavailable(failed);
        }
      } finally { refreshing.current = false; }
    };
    void readActivity();
    const timer = setInterval(() => void readActivity(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [directory, visibleCards.length]);

  const mutate = async (action: () => Promise<void>) => {
    const token = generation.current;
    const runtime = getRuntimeKey();
    setBusy(true);
    setActionError('');
    try { await action(); }
    catch (cause) {
      if (token === generation.current && runtime === getRuntimeKey()) setActionError(cause instanceof Error ? cause.message : t('workBoard.failed'));
    }
    finally {
      if (token === generation.current && runtime === getRuntimeKey()) await refresh();
      setBusy(false);
    }
  };
  const open = (card: WorkBoardCard) => {
    if (!card.sessionId) return;
    useSessionUIStore.getState().setCurrentSession(card.sessionId, card.directory);
    useUIStore.getState().closeMainSurfaces();
  };
  const promote = (card: WorkBoardCard) => void mutate(async () => {
    if (card.sessionId) { open(card); return; }
    if (!selection.providerID || !selection.modelID || isAutoModel(selection.providerID, selection.modelID)
      || !agents.some(agent => agent.name === 'plan')) {
      throw new Error(t('workBoard.needsModel'));
    }
    const runtime = getRuntimeKey();
    const checkRuntime = () => { if (runtime !== getRuntimeKey()) throw new Error('Runtime changed during promotion'); };
    await startWorkBoardPlan(card, selection, {
      create: async (path, title, model) => {
        const session = await createSession(title, path, undefined, undefined, {
          model: { providerID: model.providerID, id: model.modelID }, agent: 'plan',
        }, 'preserve');
        checkRuntime();
        if (!session) throw new Error(t('workBoard.failed'));
        return session;
      },
      link: async (id, sessionId) => { checkRuntime(); await updateWorkBoardCard(id, { sessionId }); },
      send: async (sessionId, path, brief, attachments, model) => {
        checkRuntime();
        await opencodeClient.sendMessage({
          runtimeKey: runtime, id: sessionId, directory: path, providerID: model.providerID,
          agent: 'plan', model: { providerID: model.providerID, id: model.modelID }, text: brief,
          files: attachments.map(file => ({ type: 'file', mime: file.mimeType, filename: file.filename, url: file.dataUrl })),
        });
      },
      accept: async id => { checkRuntime(); await updateWorkBoardCard(id, { stage: 'plan' }); },
    });
  });

  const addFiles = async (list: FileList | null) => {
    if (!list) return;
    setBusy(true);
    try {
      const added: WorkBoardAttachment[] = [];
      for (const file of Array.from(list)) {
        const prepared = await prepareLocalAttachments(file, [...files, ...added].map(item => item.filename));
        if (prepared) added.push(...captureWorkBoardAttachments(prepared));
      }
      setFiles(previous => [...previous, ...added]);
    } catch (cause) { setActionError(cause instanceof Error ? cause.message : t('workBoard.failed')); }
    finally { setBusy(false); }
  };

  return <div className="absolute inset-0 z-10 flex flex-col bg-background" aria-label={t('workBoard.title')}>
    <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
      <h1 className="text-lg font-semibold">{t('workBoard.title')}</h1>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        {t('workBoard.chooseProject')}
        <select value={projectId} disabled={busy} onChange={event => setProjectId(event.target.value)} className="rounded-md border border-border bg-surface-elevated p-1 text-foreground">
          {projects.map(project => <option key={project.id} value={project.id}>{project.label || project.path.split('/').at(-1)}</option>)}
        </select>
      </label>
      <ModelSelector providerId={selection.providerID} modelId={selection.modelID} onChange={(providerID, modelID) => setSelection({ providerID, modelID })} />
      <Button size="sm" variant="outline" disabled={!directory || busy} onClick={() => {
        useSessionUIStore.getState().openNewSessionDraft({ selectedProjectId: projectId, target: 'project', directoryOverride: directory });
        useUIStore.getState().closeMainSurfaces();
      }}>{t('workBoard.newTodo')}</Button>
      <Button size="sm" variant="ghost" onClick={() => useUIStore.getState().setWorkBoardOpen(false)} aria-label={t('workBoard.cancel')}><Icon name="close" className="size-4" /></Button>
    </header>
    <p className="px-4 py-2 text-xs text-muted-foreground">{t('workBoard.newBrief')}</p>
    {(actionError || error || queueError || sessionsError) && <div role="alert" className="px-4 py-2 text-sm text-[var(--status-error-text)]">{actionError || error || queueError || t('workBoard.unknown')}</div>}
    {!directory ? <p className="p-4">{t('workBoard.noProject')}</p> : <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
      {lanes.map(lane => {
        const inLane = visibleCards.filter(card => {
          const active = queue?.active.find(item => item.sessionId === card.sessionId);
          const queued = queue?.queued.some(item => item.sessionId === card.sessionId);
          const activity = unavailable.has(card.id) || queueError || !queue ? undefined : activities.get(card.id);
          return workBoardLane(card, activity, active ? 'building' : queued ? 'queued' : undefined) === lane;
        });
        return <section key={lane} className="flex min-w-[240px] flex-1 flex-col rounded-lg bg-surface-muted" aria-label={t(`workBoard.${lane}`)}>
          <h2 className="flex justify-between px-3 py-3 text-sm font-semibold">{t(`workBoard.${lane}`)}<span className="text-muted-foreground">{inLane.length}</span></h2>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-3">
            {!inLane.length && <p className="px-2 py-4 text-xs text-muted-foreground">{loading ? t('common.loading') : error ? t('workBoard.unknown') : t('workBoard.empty')}</p>}
            {inLane.map(card => {
              const activity = activities.get(card.id);
              const statusUnknown = Boolean(card.sessionId) && (!activity || unavailable.has(card.id) || Boolean(queueError));
              const active = queue?.active.find(item => item.sessionId === card.sessionId);
              const lastIdle = [...(activity?.messages ?? [])].reverse().find(message => message.role === 'idle');
              const lastPrompt = [...(activity?.messages ?? [])].reverse().find(message => message.role === 'user');
              const blocked = active?.needsReview || (!activity?.busy && lastIdle?.role === 'idle' && lastIdle.outcome !== 'succeeded'
                && lastIdle.time.created >= (lastPrompt?.time.created ?? 0));
              return <article key={card.id} className="rounded-lg border border-border bg-surface-elevated p-3">
                {editing === card.id ? <>
                  <label className="text-xs font-medium">{t('workBoard.brief')}<textarea value={text} onChange={event => setText(event.target.value)} className="mt-2 min-h-32 w-full rounded-md border border-border bg-background p-2 text-sm" /></label>
                  <label className="mt-2 block text-xs">{t('workBoard.addFiles')}<input type="file" multiple disabled={busy} onChange={event => { void addFiles(event.target.files); event.target.value = ''; }} className="mt-1 block w-full text-xs" /></label>
                  {files.map(file => <div key={file.id} className="mt-2 flex items-center justify-between gap-2 text-xs"><span className="truncate">{file.filename}</span><Button size="xs" variant="ghost" disabled={busy} onClick={() => setFiles(previous => previous.filter(item => item.id !== file.id))} aria-label={t('workBoard.remove')}><Icon name="close" className="size-3" /></Button></div>)}
                  <div className="mt-3 flex gap-2"><Button size="xs" disabled={busy || (!text.trim() && !files.length)} onClick={() => void mutate(async () => { await updateWorkBoardCard(card.id, { text, attachments: files }); setEditing(null); })}>{t('workBoard.save')}</Button><Button size="xs" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>{t('workBoard.cancel')}</Button></div>
                </> : <>
                  <button type="button" className="line-clamp-4 w-full whitespace-pre-wrap break-words text-start text-sm font-medium hover:underline" onClick={() => {
                    if (card.sessionId) { open(card); return; }
                    setEditing(card.id); setText(card.text); setFiles(card.attachments);
                  }}>{card.text || card.attachments[0]?.filename}</button>
                  {card.attachments.map(file => <p key={file.id} className="mt-2 truncate text-xs text-muted-foreground">{file.filename}</p>)}
                  {statusUnknown && <p className="mt-2 text-xs text-muted-foreground">{t('workBoard.unknown')}</p>}
                  {blocked && <p className="mt-2 text-xs text-[var(--status-warning-text)]">{t('workBoard.blocked')}</p>}
                  {lane === 'todo' && card.sessionId && <p className="mt-2 text-xs text-muted-foreground">{t('workBoard.inspect')}</p>}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {!card.sessionId && <Button size="xs" disabled={busy} onClick={() => promote(card)}>{t('workBoard.startPlan')}</Button>}
                    {card.sessionId && <Button size="xs" variant="outline" onClick={() => open(card)}>{t('workBoard.openSession')}</Button>}
                    {lane === 'todo' && <Button size="xs" variant="ghost" disabled={busy} onClick={() => { setEditing(card.id); setText(card.text); setFiles(card.attachments); }}>{t('workBoard.edit')}</Button>}
                    {card.sessionId && lane !== 'todo' && lane !== 'queued' && lane !== 'building' && !activity?.busy && !statusUnknown && <Button size="xs" variant="ghost" disabled={busy} onClick={() => void mutate(async () => {
                      if (cards.some(saved => saved.id === card.id)) await updateWorkBoardCard(card.id, { stage: 'todo' });
                      else {
                        const saved = await createWorkBoardCard(card.directory, card.text, []);
                        await updateWorkBoardCard(saved.id, { sessionId: card.sessionId, stage: 'todo' });
                      }
                    })}>{t('workBoard.backTodo')}</Button>}
                    {lane === 'todo' && !activity?.busy && <Button size="xs" variant="ghost" disabled={busy} onClick={() => void mutate(async () => { await deleteWorkBoardCard(card.id); })}>{t('workBoard.remove')}</Button>}
                  </div>
                </>}
              </article>;
            })}
          </div>
        </section>;
      })}
    </div>}
  </div>;
}
