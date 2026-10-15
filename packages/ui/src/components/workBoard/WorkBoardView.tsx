import React from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { workBoardCardTitle } from './workBoardCardTitle';
import { Icon } from '@/components/icon/Icon';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { useSessionTurnActivity } from '@/sync/global-session-status';
import { useSessionUnseenCount } from '@/sync/notification-store';
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
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isAutoModel } from '@/lib/routing/autoModel';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useBuildQueueSnapshot } from '@/hooks/useBuildQueueSnapshot';
import { fetchWorkBoard, updateWorkBoardCard, saveSessionToTodo, deleteWorkBoardCard, completeWorkBoardCards, markWorkBoardCardViewed, type WorkBoardCard, type WorkBoardAttachment } from '@/lib/workBoardApi';
import { readWorkBoardCards, persistWorkBoardCards } from '@/sync/persist-cache';
import { workBoardLane, workBoardCompletionTime, workBoardFeedback, workBoardShowsCompletionMark, startWorkBoardPlan, captureWorkBoardAttachments, workBoardQueueRows, workBoardReordered, type WorkBoardActivity, type WorkBoardLane, type WorkBoardQueueRow, type WorkBoardQueueState, type WorkBoardQueueWrite } from './workBoardWorkflow';
import { WorkBoardProjectTabs } from './WorkBoardProjectTabs';
import { removeWorkBoardProjectTab } from './workBoardProjectState';
import { useWorkBoardSavedTodo } from './workBoardSavedTodo';
import { SavedTodoBrief } from './SavedTodoBrief';

const lanes: WorkBoardLane[] = ['todo', 'plan', 'queue', 'done'];

const queueErrorSchema = z.object({ error: z.string() });

/**
 * The one mark a card can show before its title: live activity, or — for a
 * finished card the user has not acknowledged — the session list's green
 * completion checkbox. The two are mutually exclusive so a card never carries
 * two marks that mean different things.
 */
function WorkBoardCardMark({ card }: { card: WorkBoardCard }) {
  // An unlinked card has no session to look up; the empty id matches nothing in
  // either index. The hooks stay unconditional so render order never changes.
  const sessionId = card.sessionId ?? '';
  const activity = useSessionTurnActivity(sessionId);
  const unseenCount = useSessionUnseenCount(sessionId);
  const state = activity ?? (unseenCount > 0 ? 'unread' : null) ?? (workBoardShowsCompletionMark(card) ? 'unread' : null);
  return state ? <SessionActivityIndicator state={state} tooltip /> : null;
}

function WorkBoardSessionFeedback({ sessionId, activity, unavailable, needsReview }: {
  sessionId: string;
  activity: WorkBoardActivity | undefined;
  unavailable: boolean;
  needsReview: boolean;
}) {
  const { t } = useI18n();
  const unseenCount = useSessionUnseenCount(sessionId);
  const liveActivity = useSessionTurnActivity(sessionId);
  const feedback = workBoardFeedback(activity, unavailable, needsReview, unseenCount > 0 && liveActivity === null);
  return feedback ? <p className={feedback === 'blocked' ? 'text-xs text-[var(--status-warning-text)]' : 'text-xs text-muted-foreground'}>{t(`workBoard.${feedback}`)}</p> : null;
}

/**
 * The Build queue lane. The project runs one build at a time, so the running
 * lease sits above the gap and everything waiting sits below it, in the order
 * the queue will dispatch them. A queued row carries the same controls the
 * Build queue pane offers, because it is the same queue.
 */
function WorkBoardQueueColumn({ rows, active, activeTitle, order, busy, error, onOpen, onMove, onTogglePause, onCancel, onNewBuild }: {
  rows: WorkBoardQueueRow[];
  active: { sessionId: string; needsReview?: boolean; startedAt: number } | undefined;
  activeTitle: string;
  order: string[];
  busy: boolean;
  error: string;
  onOpen: (sessionId: string) => void;
  onMove: (itemId: string, delta: number) => void;
  onTogglePause: (row: { itemId: string; sessionId: string; paused: boolean }) => void;
  onCancel: (row: { itemId: string; sessionId: string }) => void;
  onNewBuild: () => void;
}) {
  const { t } = useI18n();
  // The active slot keeps its height whether or not a build is running, so the
  // rows below it do not jump when one starts or finishes.
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
    {error && <p role="alert" className="mb-2 px-1 text-xs text-[var(--status-error-text)]">{error}</p>}
    {active
      ? <WorkBoardActiveBuild title={activeTitle} needsReview={Boolean(active.needsReview)} onOpen={() => onOpen(active.sessionId)} />
      : <Button size="xs" variant="ghost" disabled={busy} onClick={onNewBuild}
          className="mb-1 h-auto w-full flex-col items-start gap-1 rounded-md border border-dashed border-border px-2.5 py-3 text-xs font-normal text-muted-foreground"
          aria-label={t('workBoard.newBuild')}>
          <span className="flex items-center gap-1.5 font-medium"><Icon name="add" className="size-3.5" />{t('workBoard.newBuild')}</span>
          <span>{t('workBoard.noneRunning')}</span>
        </Button>}
    <div className="flex items-center gap-2 px-1 pb-2 pt-3 text-[10px] font-semibold uppercase tracking-[0.08em] text-muted-foreground" aria-hidden="true">
      {t('workBoard.upNext')}
      <span className="h-px flex-1 bg-border" />
      <span className="font-medium normal-case tracking-normal">{t('workBoard.queuedCount', { count: rows.length })}</span>
    </div>
    {!rows.length && <p className="px-1 py-3 text-xs text-muted-foreground">{t('workBoard.queueEmpty')}</p>}
    <div className="space-y-3">
      {rows.map((row, index) => <div key={row.itemId}
        className="group relative flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5">
        <span className="flex size-5 shrink-0 items-center justify-center rounded bg-[var(--interactive-selection)] text-[10px] font-semibold tabular-nums text-muted-foreground">{index + 1}</span>
        <button type="button" className="min-w-0 flex-1 truncate text-start"
          onClick={() => onOpen(row.sessionId)}>
          <span dir="auto" className="block truncate text-xs font-medium leading-5 hover:underline">{row.title}</span>
          <span dir="auto" className="block truncate text-[11px] text-muted-foreground">{row.paused ? t('workBoard.paused') : row.snippet || row.sessionId.slice(0, 9)}</span>
        </button>
        <div className="flex shrink-0 items-center gap-0.5 opacity-40 transition-opacity focus-within:opacity-100 group-hover:opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100">
          <Button size="icon" variant="ghost" className="size-6" disabled={busy || index === 0}
            aria-label={t('workBoard.moveUp', { title: row.title })} title={t('workBoard.moveUp', { title: row.title })}
            onClick={() => onMove(row.itemId, -1)}><Icon name="arrow-up-s" className="size-3.5" /></Button>
          <Button size="icon" variant="ghost" className="size-6" disabled={busy || index === order.length - 1}
            aria-label={t('workBoard.moveDown', { title: row.title })} title={t('workBoard.moveDown', { title: row.title })}
            onClick={() => onMove(row.itemId, 1)}><Icon name="arrow-down-s" className="size-3.5" /></Button>
          <Button size="icon" variant="ghost" className="size-6" disabled={busy}
            aria-label={t(row.paused ? 'workBoard.resume' : 'workBoard.pause', { title: row.title })}
            title={t(row.paused ? 'workBoard.resume' : 'workBoard.pause', { title: row.title })}
            onClick={() => onTogglePause(row)}><Icon name={row.paused ? 'play' : 'time'} className="size-3.5" /></Button>
          <Button size="icon" variant="ghost" className="size-6 hover:text-[var(--status-error-text)]" disabled={busy}
            aria-label={t('workBoard.cancelBuild', { title: row.title })} title={t('workBoard.cancelBuild', { title: row.title })}
            onClick={() => onCancel(row)}><Icon name="close" className="size-3.5" /></Button>
        </div>
      </div>)}
    </div>
  </div>;
}

/**
 * The build the project is running now. A lease awaiting review keeps the error
 * treatment — the server will not release it on its own — while a lease that is
 * actually running gets the moving band, so "working" and "stuck" never look
 * the same.
 */
function WorkBoardActiveBuild({ title, needsReview, onOpen }: { title: string; needsReview: boolean; onOpen: () => void }) {
  const { t } = useI18n();
  return <button type="button" onClick={onOpen}
    className={'relative w-full overflow-hidden rounded-md border px-2.5 py-2 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring '
      + (needsReview
        ? 'border-[color-mix(in_srgb,var(--status-error)_50%,transparent)] bg-[var(--status-error-background)]'
        : 'border-[color-mix(in_srgb,var(--status-info)_42%,transparent)] bg-[color-mix(in_srgb,var(--status-info)_12%,var(--surface-elevated))] hover:bg-[color-mix(in_srgb,var(--status-info)_18%,var(--surface-elevated))]')}
    aria-label={t('workBoard.openBuild', { title })}>
    {!needsReview && <span aria-hidden="true" className="oc-build-stripes pointer-events-none absolute inset-0" />}
    <span className="relative flex min-w-0 items-center gap-2">
      <span className={'flex size-6 shrink-0 items-center justify-center rounded ' + (needsReview ? 'bg-[var(--status-error-background)] text-[var(--status-error-text)]' : 'bg-[color-mix(in_srgb,var(--status-info)_26%,transparent)] text-[var(--status-info)]')}>
        <Icon name={needsReview ? 'alert' : 'terminal-box'} className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span dir="auto" className="block truncate text-xs font-semibold leading-5">{title}</span>
        <span className="block truncate text-[11px] text-muted-foreground">{t(needsReview ? 'workBoard.needsReview' : 'workBoard.buildingNow')}</span>
      </span>
      {!needsReview && <span className="flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--status-info)]">
        <span className="size-1.5 rounded-full bg-[var(--status-success)] motion-safe:animate-pulse" />{t('workBoard.active')}
      </span>}
    </span>
  </button>;
}

export function WorkBoardView() {
  const { t } = useI18n();
  const projects = useProjectsStore(state => state.projects);
  const activeProjectId = useProjectsStore(state => state.activeProjectId);
  const hasServerSnapshot = useProjectsStore(state => state.hasServerSnapshot);
  const runtimeKey = getRuntimeKey();
  const confirmation = useWorkBoardSavedTodo(state => state.confirmation);
  const storedProjectTabs = useUIStore(state => state.workBoardProjectTabsByRuntime[runtimeKey]);
  const setWorkBoardProjectTabs = useUIStore(state => state.setWorkBoardProjectTabs);
  const projectIds = storedProjectTabs?.projectIds ?? [];
  const projectsById = React.useMemo(() => new Map(projects.map(project => [project.id, project])), [projects]);
  const visibleProjectTabs = projectIds.flatMap(id => {
    const project = projectsById.get(id);
    return project ? [project] : [];
  });
  const projectId = visibleProjectTabs.some(project => project.id === storedProjectTabs?.activeProjectId)
    ? storedProjectTabs?.activeProjectId ?? ''
    : visibleProjectTabs[0]?.id ?? '';
  React.useEffect(() => {
    if (storedProjectTabs || (!projects.length && !hasServerSnapshot)) return;
    const initialProjectId = projects.find(project => project.id === activeProjectId)?.id ?? projects[0]?.id ?? null;
    setWorkBoardProjectTabs(runtimeKey, {
      projectIds: initialProjectId ? [initialProjectId] : [],
      activeProjectId: initialProjectId,
    });
  }, [activeProjectId, hasServerSnapshot, projects, runtimeKey, setWorkBoardProjectTabs, storedProjectTabs]);
  React.useEffect(() => {
    if (!storedProjectTabs || !hasServerSnapshot) return;
    const validIds = storedProjectTabs.projectIds.filter(id => projectsById.has(id));
    const activeId = validIds.includes(storedProjectTabs.activeProjectId ?? '')
      ? storedProjectTabs.activeProjectId
      : validIds[0] ?? null;
    if (validIds.length !== storedProjectTabs.projectIds.length || activeId !== storedProjectTabs.activeProjectId) {
      setWorkBoardProjectTabs(runtimeKey, { projectIds: validIds, activeProjectId: activeId });
    }
  }, [hasServerSnapshot, projects, projectsById, runtimeKey, setWorkBoardProjectTabs, storedProjectTabs]);
  const addProjectTab = (nextProjectId: string) => {
    const nextIds = [...new Set([...visibleProjectTabs.map(project => project.id), nextProjectId])];
    setWorkBoardProjectTabs(runtimeKey, { projectIds: nextIds, activeProjectId: nextProjectId });
  };
  const closeProjectTab = (closedProjectId: string) => {
    const next = removeWorkBoardProjectTab(visibleProjectTabs.map(project => project.id), projectId, closedProjectId);
    setWorkBoardProjectTabs(runtimeKey, next);
  };
  const directory = projects.find(project => project.id === projectId)?.path ?? '';
  const savedCard = confirmation?.runtimeKey === runtimeKey && confirmation.card.directory === directory ? confirmation.card : null;
  // Remember which board the user is on so any chat can return to it, and so a
  // New to-do draft is rooted in this project rather than the sidebar's.
  React.useEffect(() => {
    if (!projectId) return;
    if (useUIStore.getState().workBoardProjectId === projectId) return;
    useUIStore.getState().setWorkBoardProjectId(projectId);
  }, [projectId]);
  const [cards, setCards] = React.useState<WorkBoardCard[]>([]);
  const [activities, setActivities] = React.useState<Map<string, WorkBoardActivity>>(new Map());
  const [unavailable, setUnavailable] = React.useState<Set<string>>(new Set());
  const [error, setError] = React.useState('');
  const [actionError, setActionError] = React.useState('');
  const [loading, setLoading] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [completion, setCompletion] = React.useState<{ cards: WorkBoardCard[]; skipped: number } | null>(null);
  const [editing, setEditing] = React.useState<string | null>(null);
  const [text, setText] = React.useState('');
  const [files, setFiles] = React.useState<WorkBoardAttachment[]>([]);
  const agents = useConfigStore(state => state.agents);
  const sessions = useGlobalSessionsStore(state => state.activeSessions);
  const sessionsError = useGlobalSessionsStore(state => state.status === 'error');
  // The store seeds from localStorage and only then loads pages, so `status`
  // still reports idle/loading while the sidebar list fills in. Session-derived
  // board cards arrive with it, and a lane that will fill should say so rather
  // than claim to be empty and then gain cards.
  const sessionsLoading = useGlobalSessionsStore(state => !state.hasLoaded && state.status !== 'error');
  const { snapshot: queue, error: queueError, refresh: refreshQueue } = useBuildQueueSnapshot();
  const [queueBusy, setQueueBusy] = React.useState(false);
  const [queueActionError, setQueueActionError] = React.useState('');
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
  // A stable identity for the linked card set, so the activity read reruns when
  // the set itself changes rather than only when its size does.
  const visibleCardIds = React.useMemo(
    () => visibleCards.filter(card => card.sessionId).map(card => card.id).sort().join('\n'),
    [visibleCards],
  );
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
      persistWorkBoardCards(directory, next);
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
    // Paint the board's own cards from the last visit before the fetch lands,
    // so the first frame already shows the user their board instead of an empty
    // one that fills in. The fetch replaces this seed with authoritative cards.
    setCards(directory ? readWorkBoardCards(directory) ?? [] : []);
    setLoading(true);
    setError('');
    setActionError('');
    setActivities(new Map());
    setUnavailable(new Set());
    sessionVersions.current.clear();
    messageCache.current.clear();
    setEditing(null);
    setCompletion(null);
    void refresh();
    const onFocus = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    const timer = setInterval(onFocus, 30000);
    return () => { generation.current += 1; clearInterval(timer); window.removeEventListener('focus', onFocus); };
  }, [directory, refresh]);

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
        // Every linked card's history is an independent request. Run them
        // together so the first paint of a lane waits on one round trip rather
        // than one per batch, which is what made cards settle in visible steps.
        await Promise.all(linked.map(async card => {
          if (!card.sessionId) return;
          if (status === null) { failed.add(card.id); return; }
          try {
            const version = versionsRef.current.get(card.sessionId);
            const cached = messageCache.current.get(card.id);
            const running = Boolean(status[card.sessionId]) || hasActiveSubagent(card.sessionId, activeIds) || hasRunningShell(card.sessionId);
            // The session's update time is the history's identity. If it has not
            // moved and no turn is running, the cached history is still what the
            // server would return, so a settled lane does not refetch every tick.
            if (cached && !running && version !== undefined && sessionVersions.current.get(card.id) === version) {
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
        if (!cancelled && token === generation.current && runtime === getRuntimeKey()) {
          setActivities(previous => new Map([...previous, ...next]));
          setUnavailable(failed);
        }
      } finally { refreshing.current = false; }
    };
    void readActivity();
    const timer = setInterval(() => void readActivity(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
    // The linked card set, not just its size: the history cache is keyed by card
    // id, so a same-length replacement would otherwise keep serving the previous
    // card's read. A card entering or leaving the queue changes what its turn
    // means, and the read must follow that.
  }, [directory, visibleCardIds]);

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
  // Acknowledges the completion the user just opened, so every client clears
  // the mark. Only stored cards have a server record; an inherited card is
  // completed on demand and gains one then.
  const acknowledge = (card: WorkBoardCard) => {
    if (!workBoardShowsCompletionMark(card) || card.id.startsWith('session:')) return;
    void markWorkBoardCardViewed(card.id).then(() => { void refresh(); }).catch(() => {});
  };
  const open = (card: WorkBoardCard) => {
    if (!card.sessionId) return;
    const actualDirectory = sessions.find(session => session.id === card.sessionId)?.directory ?? card.directory;
    useSessionUIStore.getState().setCurrentSession(card.sessionId, actualDirectory);
    useUIStore.getState().closeMainSurfaces();
  };
  const promote = (card: WorkBoardCard) => void mutate(async () => {
    if (card.sessionId) { open(card); return; }
    // The board no longer carries a model picker: a promoted card starts on the
    // model the Plan agent would use in a fresh chat. Auto is still refused here
    // because the server resolves it later and could land on another agent.
    const planModel = useConfigStore.getState().resolveAgentModel('plan');
    if (!planModel || isAutoModel(planModel.providerId, planModel.modelId)
      || !agents.some(agent => agent.name === 'plan')) {
      throw new Error(t('workBoard.needsModel'));
    }
    const selection = { providerID: planModel.providerId, modelID: planModel.modelId, variant: planModel.variant };
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

  // The queue column shows one project's work. Membership and order come from
  // the server snapshot, never from card order, so a queued build the board has
  // no card for still appears, and a move sends the queue's own order.
  const queuedItems = React.useMemo(
    () => (queueError || !queue ? [] : queue.queued.filter(item => item.directory === directory)),
    [directory, queue, queueError],
  );
  const activeBuild = React.useMemo(
    () => (!queueError && queue ? queue.active.find(item => item.directory === directory) : undefined),
    [directory, queue, queueError],
  );
  const sessionTitleFor = React.useCallback(
    (sessionId: string) => sessions.find(session => session.id === sessionId)?.title
      || t('workBoard.sessionFallback', { id: sessionId.slice(0, 9) }),
    [sessions, t],
  );
  const queueRows = React.useMemo(() => workBoardQueueRows(queuedItems, sessionTitleFor), [queuedItems, sessionTitleFor]);
  const queueOrder = React.useMemo(() => queuedItems.map(item => item.id), [queuedItems]);

  const queueStateFor = (card: WorkBoardCard): WorkBoardQueueState | undefined => {
    if (queueError || !queue || !card.sessionId) return undefined;
    const index = queuedItems.findIndex(item => item.sessionId === card.sessionId);
    if (index >= 0) {
      const item = queuedItems[index];
      return { itemId: item.id, paused: Boolean(item.paused), active: false, needsReview: false, order: queueOrder };
    }
    const active = queue.active.find(item => item.sessionId === card.sessionId);
    if (!active) return undefined;
    return { itemId: active.itemId, paused: false, active: true, needsReview: Boolean(active.needsReview), order: queueOrder };
  };

  const laneFor = (card: WorkBoardCard) => workBoardLane(card,
    unavailable.has(card.id) ? undefined : activities.get(card.id), queueStateFor(card));
  // A lease awaiting review is unfinished work the server will not release on
  // its own; completing its card would hide that resolution. Manual Done stays
  // out of reach for it.
  const canComplete = (card: WorkBoardCard) => {
    const lane = laneFor(card);
    if (lane !== 'todo' && lane !== 'plan') return false;
    if (!card.sessionId) return true;
    return Boolean(activities.get(card.id)) && !activities.get(card.id)?.busy && !unavailable.has(card.id)
      && !queueError && queue !== null;
  };
  const complete = (targets: WorkBoardCard[]) => void mutate(async () => {
    const token = generation.current;
    const result = await completeWorkBoardCards(directory, targets.map(card => ({
      id: card.id, updatedAt: card.updatedAt, text: card.text, sessionId: card.sessionId,
      sessionDirectory: sessions.find(session => session.id === card.sessionId)?.directory ?? card.directory,
    })));
    if (token !== generation.current) return;
    setCompletion(null);
    if (result.failed.length) throw new Error(t('workBoard.completeFailed', { count: result.failed.length }) + '\n'
      + result.failed.map(failure => `${workBoardCardTitle(targets.find(card => card.id === failure.id)?.text ?? failure.id, [])}: ${failure.error}`).join('\n'));
  });
  const newCard = (lane: 'todo' | 'plan' | 'queue') => {
    useSessionUIStore.getState().openNewSessionDraft({
      selectedProjectId: projectId, target: 'project', directoryOverride: directory,
      origin: lane === 'todo' ? 'workBoard' : lane === 'plan' ? 'workBoardPlan' : 'workBoardBuild',
    });
    useUIStore.getState().closeMainSurfaces();
  };

  // Queue rows act on the queue itself. The board is a second surface on the
  // same server state, so every one of these refreshes the snapshot rather than
  // guessing the result.
  const queueMutate = async (url: string, method: 'PUT' | 'DELETE', body?: WorkBoardQueueWrite) => {
    setQueueBusy(true);
    setQueueActionError('');
    try {
      const init: RequestInit = { method };
      if (body) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const response = await runtimeFetch(url, init);
      if (!response.ok) {
        const detail = queueErrorSchema.safeParse(await response.json().catch(() => null));
        throw new Error(detail.success ? detail.data.error : `HTTP ${response.status}`);
      }
      await refreshQueue();
    } catch (cause) {
      setQueueActionError(cause instanceof Error ? cause.message : t('workBoard.failed'));
    } finally {
      setQueueBusy(false);
    }
  };
  const moveQueued = (itemId: string, delta: number) => {
    const index = queueOrder.indexOf(itemId);
    const order = workBoardReordered(queueOrder, index, delta);
    if (!order) return;
    void queueMutate('/api/build-queue/order', 'PUT', { directory, ids: order });
  };
  const toggleQueuedPause = (row: { itemId: string; sessionId: string; paused: boolean }) =>
    void queueMutate('/api/build-queue/sessions/' + encodeURIComponent(row.sessionId) +
      '/items/' + encodeURIComponent(row.itemId) + '/pause', 'PUT', { paused: !row.paused });
  const cancelQueued = (row: { itemId: string; sessionId: string }) =>
    void queueMutate('/api/build-queue/sessions/' + encodeURIComponent(row.sessionId) +
      '/items/' + encodeURIComponent(row.itemId), 'DELETE');

  return <div className="absolute inset-0 z-10 flex flex-col bg-background" aria-label={t('workBoard.title')}>
    <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
      <h1 className="text-lg font-semibold">{t('workBoard.title')}</h1>
      <WorkBoardProjectTabs
        projects={projects}
        openProjectIds={visibleProjectTabs.map(project => project.id)}
        activeProjectId={projectId}
        disabled={busy}
        onSelect={nextProjectId => setWorkBoardProjectTabs(runtimeKey, {
          projectIds: visibleProjectTabs.map(project => project.id),
          activeProjectId: nextProjectId,
        })}
        onAdd={addProjectTab}
        onClose={closeProjectTab}
      />
      <Button size="sm" variant="ghost" onClick={() => useUIStore.getState().setWorkBoardOpen(false)} aria-label={t('workBoard.cancel')}><Icon name="close" className="size-4" /></Button>
    </header>
    <p className="px-4 py-2 text-xs text-muted-foreground">{t('workBoard.newBrief')}</p>
    {(actionError || error || queueError || sessionsError) && <div role="alert" className="px-4 py-2 text-sm text-[var(--status-error-text)]">{actionError || error || queueError || t('workBoard.unknown')}</div>}
    {!directory ? <p className="p-4">{t('workBoard.noProject')}</p> : <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
      {lanes.map(lane => {
        const inLane = visibleCards.filter(card => laneFor(card) === lane);
        if (lane === 'done') inLane.sort((a, b) => workBoardCompletionTime(b, activities.get(b.id)) - workBoardCompletionTime(a, activities.get(a.id)) || a.id.localeCompare(b.id));
        return <section key={lane} className="flex min-w-[240px] flex-1 flex-col rounded-lg bg-surface-muted" aria-label={t(`workBoard.${lane}`)}>
          <div className="flex items-center gap-2 px-3 py-3">
            <h2 className="flex flex-1 items-center gap-2 text-sm font-semibold">{t(`workBoard.${lane}`)}<span className="text-muted-foreground">{inLane.length}</span></h2>
            {(lane === 'todo' || lane === 'plan') && <Button size="sm" variant="ghost" disabled={!directory || busy || (lane === 'plan' && !agents.some(agent => agent.name === 'plan'))} onClick={() => newCard(lane)} aria-label={t(lane === 'todo' ? 'workBoard.newTodo' : 'workBoard.newPlan')} title={t(lane === 'todo' ? 'workBoard.newTodo' : 'workBoard.newPlan')}><Icon name="add" className="size-4" /></Button>}
            {lane === 'plan' && <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" disabled={busy || !inLane.length} aria-label={t('workBoard.laneActions')}><Icon name="more" className="size-4" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => {
                const eligible = inLane.filter(canComplete);
                setCompletion({ cards: eligible, skipped: inLane.length - eligible.length });
              }}>{t('workBoard.completeAll')}</DropdownMenuItem></DropdownMenuContent>
            </DropdownMenu>}
          </div>
          {lane === 'queue' ? <WorkBoardQueueColumn
            rows={queueRows}
            active={activeBuild}
            activeTitle={activeBuild ? sessionTitleFor(activeBuild.sessionId) : ''}
            order={queueOrder}
            busy={queueBusy}
            error={queueActionError}
            onOpen={sessionId => useSessionUIStore.getState().setCurrentSession(sessionId, directory)}
            onMove={moveQueued}
            onTogglePause={toggleQueuedPause}
            onCancel={cancelQueued}
            onNewBuild={() => newCard('queue')}
          /> : <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-3">
            {!inLane.length && <p className="px-2 py-4 text-xs text-muted-foreground">{
              loading ? t('common.loading')
                : error ? t('workBoard.unknown')
                : lane === 'plan' && sessionsLoading ? t('common.loading')
                : t('workBoard.empty')
            }</p>}
            {inLane.map(card => {
              const activity = activities.get(card.id);
              const statusUnknown = Boolean(card.sessionId) && (!activity || unavailable.has(card.id));
              const hasRunningTurn = Boolean(activity?.busy);
              const canReturnToTodo = Boolean(card.sessionId) && lane !== 'todo' && !hasRunningTurn
                && !statusUnknown && !queueError && queue !== null;
              const canRemove = lane === 'todo' && !hasRunningTurn
                && (!card.sessionId || (!statusUnknown && !queueError && queue !== null));
              const title = workBoardCardTitle(card.text, card.attachments);
              return <article key={card.id} className="group relative rounded-md border border-border bg-surface-elevated px-2.5 py-1.5">
                {editing === card.id ? <>
                  <label className="text-xs font-medium">{t('workBoard.brief')}<textarea value={text} onChange={event => setText(event.target.value)} className="mt-2 min-h-32 w-full rounded-md border border-border bg-background p-2 text-sm" /></label>
                  <label className="mt-2 block text-xs">{t('workBoard.addFiles')}<input type="file" multiple disabled={busy} onChange={event => { void addFiles(event.target.files); event.target.value = ''; }} className="mt-1 block w-full text-xs" /></label>
                  {files.map(file => <div key={file.id} className="mt-2 flex items-center justify-between gap-2 text-xs"><span className="truncate">{file.filename}</span><Button size="xs" variant="ghost" disabled={busy} onClick={() => setFiles(previous => previous.filter(item => item.id !== file.id))} aria-label={t('workBoard.remove')}><Icon name="close" className="size-3" /></Button></div>)}
                  <div className="mt-3 flex gap-2"><Button size="xs" disabled={busy || (!text.trim() && !files.length)} onClick={() => void mutate(async () => { await updateWorkBoardCard(card.id, { text, attachments: files }); setEditing(null); })}>{t('workBoard.save')}</Button><Button size="xs" variant="ghost" disabled={busy} onClick={() => setEditing(null)}>{t('workBoard.cancel')}</Button></div>
                </> : <div className="flex min-w-0 items-center gap-1">
                  <WorkBoardCardMark card={card} />
                  <button type="button" className="min-w-0 flex-1 truncate text-start text-xs font-medium leading-5 hover:underline" title={title} onClick={() => {
                    acknowledge(card);
                    if (card.sessionId) { open(card); return; }
                    setEditing(card.id); setText(card.text); setFiles(card.attachments);
                  }}>{title}</button>
                  {(!card.sessionId || canReturnToTodo || canRemove || canComplete(card)) && <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button type="button" disabled={busy} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-40 transition-opacity hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100" title="Card actions" aria-label={`Actions for ${title}`}>
                        <Icon name="more" className="size-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {canComplete(card) && <DropdownMenuItem onClick={() => complete([card])}>{t('workBoard.complete')}</DropdownMenuItem>}
                      {!card.sessionId && <DropdownMenuItem onClick={() => promote(card)}>{t('workBoard.startPlan')}</DropdownMenuItem>}
                      {canReturnToTodo && <DropdownMenuItem onClick={() => void mutate(async () => {
                        const actualDirectory = sessions.find(session => session.id === card.sessionId)?.directory ?? card.directory;
                        await saveSessionToTodo(card.sessionId!, card.directory, actualDirectory, card.text, []);
                      })}>{t('workBoard.backTodo')}</DropdownMenuItem>}
                      {canRemove && <DropdownMenuItem onClick={() => void mutate(async () => {
                        await deleteWorkBoardCard(card.id);
                      })}>{t('workBoard.remove')}</DropdownMenuItem>}
                    </DropdownMenuContent>
                  </DropdownMenu>}
                </div>}
                {card.sessionId && <WorkBoardSessionFeedback sessionId={card.sessionId} activity={activity} unavailable={statusUnknown} needsReview={Boolean(queueStateFor(card)?.needsReview)} />}
              </article>;
            })}
          </div>}
        </section>;
      })}
    </div>}
    <Dialog open={savedCard !== null} onOpenChange={open => { if (!open) useWorkBoardSavedTodo.setState({ confirmation: null }); }}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t('workBoard.saved')}</DialogTitle>
        <div className="max-h-[65vh] overflow-y-auto">{savedCard && <SavedTodoBrief card={savedCard} />}</div>
      </DialogContent>
    </Dialog>
    <Dialog open={completion !== null} onOpenChange={open => { if (!open && !busy) setCompletion(null); }}>
      <DialogContent showCloseButton={!busy}>
        <DialogTitle>{t('workBoard.completeAll')}</DialogTitle>
        <DialogDescription>{t('workBoard.completeConfirm', { count: completion?.cards.length ?? 0 })}</DialogDescription>
        {Boolean(completion?.skipped) && <p className="text-sm text-muted-foreground">{t('workBoard.completeSkipped', { count: completion?.skipped ?? 0 })}</p>}
        <ul className="max-h-64 overflow-y-auto space-y-1 text-sm">{completion?.cards.map(card => <li key={card.id} dir="auto">{workBoardCardTitle(card.text, card.attachments)}</li>)}</ul>
        <DialogFooter><Button variant="outline" disabled={busy} onClick={() => setCompletion(null)}>{t('workBoard.cancel')}</Button><Button disabled={busy || !completion?.cards.length} onClick={() => { if (completion) complete(completion.cards); }}>{t('workBoard.complete')}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
