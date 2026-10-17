import React from 'react';
import { workBoardSessions } from './workBoardSessions';
import { readWorkBoardMemory, rememberWorkBoard, type BoardSnapshot } from './workBoardMemory';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { workBoardCardTitle } from './workBoardCardTitle';
import { Icon } from '@/components/icon/Icon';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { useSessionTurnActivity, useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useI18n } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { prepareLocalAttachments } from '@/sync/input-store';
import { createSession, setSessionWorkState } from '@/sync/session-actions';
import { hasActiveSubagent } from '@/sync/global-session-status';
import { hasRunningShell, useBackgroundShellsStore } from '@/sync/background-shells';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isAutoModel } from '@/lib/routing/autoModel';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { useBuildQueueSnapshot } from '@/hooks/useBuildQueueSnapshot';
import { fetchWorkBoard, updateWorkBoardCard, saveSessionToTodo, deleteWorkBoardCard, placeWorkBoardCard, placeWorkBoardCards, markWorkBoardCardViewed, WorkBoardRequestError, type WorkBoardCard, type WorkBoardAttachment } from '@/lib/workBoardApi';
import { readWorkBoardCards, persistWorkBoardCards } from '@/sync/persist-cache';
import { workBoardLane, workBoardMoved, workBoardOrderNeighbour, workBoardCompletionTime, workBoardFeedback, workBoardShowsCompletionMark, workBoardReviewConfirmWording, startWorkBoardPlan, captureWorkBoardAttachments, workBoardQueueRows, workBoardReordered, workBoardBuildBadges, workBoardDirectoryKey, workBoardActiveEntries, type WorkBoardActivity, type WorkBoardActiveEntry, type WorkBoardCardLane, type WorkBoardLane, type WorkBoardQueueRow, type WorkBoardQueueState, type WorkBoardQueueWrite } from './workBoardWorkflow';
import { DndContext, DragOverlay, MouseSensor, TouchSensor, pointerWithin, rectIntersection, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { WorkBoardProjectTabs } from './WorkBoardProjectTabs';
import { removeWorkBoardProjectTab, reorderWorkBoardProjectTabs } from './workBoardProjectState';
import { useWorkBoardSavedTodo } from './workBoardSavedTodo';
import { SavedTodoBrief } from './SavedTodoBrief';

const lanes: WorkBoardLane[] = ['todo', 'plan', 'queue', 'build', 'done'];

// The drag's own id prefix, so a lane droppable and a card draggable never
// collide in dnd-kit's id space.
const LANE_PREFIX = 'lane:';

type WorkBoardDrag = { type: 'card'; id: string; lane: WorkBoardCardLane; title: string }
  | { type: 'queue'; id: string; title: string };

/**
 * A lane accepts everything dropped on it, and a card beats the lane droppable
 * it sits in, so dropping a card onto another card lands it in that card's
 * place. `pointerWithin` follows the pointer, which is what makes an empty lane
 * still a target; the intersection fallback covers a pointer that sits in the
 * gap between two cards.
 */
const collide: CollisionDetection = args => {
  const over = pointerWithin(args);
  return over.length ? over : rectIntersection(args);
};

const queueErrorSchema = z.object({ error: z.string().optional(), warning: z.string().optional() });

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

/**
 * The card and the line under it must agree about the notice, so the card reads
 * its own feedback through the same two hooks the line uses. The hooks stay
 * unconditional, like `WorkBoardCardMark`, so render order never changes.
 */
function useWorkBoardCardFeedback(card: WorkBoardCard, activity: WorkBoardActivity | undefined, unavailable: boolean, needsReview: boolean): 'unknown' | 'blocked' | undefined {
  const sessionId = card.sessionId ?? '';
  const unseenCount = useSessionUnseenCount(sessionId);
  const liveActivity = useSessionTurnActivity(sessionId);
  return card.sessionId
    ? workBoardFeedback(activity, unavailable, needsReview, unseenCount > 0 && liveActivity === null)
    : undefined;
}

function WorkBoardSessionFeedback({ feedback }: { feedback: 'unknown' | 'blocked' | undefined }) {
  const { t } = useI18n();
  return feedback ? <p className={'min-h-[1lh] text-xs leading-5 ' + (feedback === 'blocked' ? 'text-[var(--status-warning-text)]' : 'text-muted-foreground')}>{t(`workBoard.${feedback}`)}</p> : null;
}

/**
 * One waiting queue row. It is sortable so the order the user drags it into is
 * the order the queue dispatches; the buttons stay as the keyboard path.
 */
function WorkBoardQueueRowItem({ row, index, order, busy, disabled, onOpen, onMove, onTogglePause, onForce, onCancel }: {
  row: WorkBoardQueueRow;
  index: number;
  order: string[];
  busy: boolean;
  disabled: boolean;
  onOpen: (sessionId: string) => void;
  onMove: (itemId: string, delta: number) => void;
  onTogglePause: (row: { itemId: string; sessionId: string; paused: boolean }) => void;
  onForce: (row: { itemId: string; sessionId: string }) => void;
  onCancel: (row: { itemId: string; sessionId: string }) => void;
}) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: row.itemId, disabled });
  return <div ref={setNodeRef} data-work-board-dragging={isDragging ? '' : undefined}
    style={{ transform: CSS.Translate.toString(transform), transition }}
    className={'group relative flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-surface-elevated px-2.5 py-2 touch-none select-none '
      + (isDragging ? 'opacity-60' : '')}>
    <button type="button" {...attributes} {...listeners} disabled={disabled}
      className="flex min-w-0 flex-1 items-center gap-1.5 text-start"
      aria-label={t('workBoard.openQueued', { title: row.title })} title={row.title}
      onClick={() => onOpen(row.sessionId)}>
      <span className="flex size-5 shrink-0 items-center justify-center rounded bg-[var(--interactive-selection)] text-[10px] font-semibold tabular-nums text-muted-foreground">{index + 1}</span>
      <span className="min-w-0 flex-1">
        <span dir="auto" className="block truncate text-xs font-medium leading-5 hover:underline">{row.title}</span>
        {/* One line of subtitle space, reserved: a row keeps its height
            whether it shows the prompt, "Paused", or a fallback session id. */}
        <span dir="auto" className="block min-h-[1lh] truncate text-[11px] leading-5 text-muted-foreground">{row.paused ? t('workBoard.paused') : row.snippet || row.sessionId.slice(0, 9)}</span>
      </span>
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
      <Button size="icon" variant="ghost" className="size-6" disabled={busy}
        aria-label={t('workBoard.force', { title: row.title })} title={t('workBoard.force', { title: row.title })}
        onClick={() => onForce(row)}><Icon name="rocket" className="size-3.5" /></Button>
      <Button size="icon" variant="ghost" className="size-6 hover:text-[var(--status-error-text)]" disabled={busy}
        aria-label={t('workBoard.cancelBuild', { title: row.title })} title={t('workBoard.cancelBuild', { title: row.title })}
        onClick={() => onCancel(row)}><Icon name="close" className="size-3.5" /></Button>
    </div>
  </div>;
}

/**
 * The Build queue lane. The running lease and builds started outside the queue
 * sit above the gap. Waiting items keep the queue's dispatch order and controls.
 */
function WorkBoardQueueColumn({ rows, active, activeTitle, entries, order, busy, error, dragged, onOpen, onMove, onTogglePause, onForce, onCancel, onNewBuild }: {
  rows: WorkBoardQueueRow[];
  active: { sessionId: string; needsReview?: boolean; startedAt: number } | undefined;
  activeTitle: string;
  entries: WorkBoardActiveEntry[];
  order: string[];
  busy: boolean;
  error: string;
  dragged: string | null;
  onOpen: (sessionId: string) => void;
  onMove: (itemId: string, delta: number) => void;
  onTogglePause: (row: { itemId: string; sessionId: string; paused: boolean }) => void;
  onForce: (row: { itemId: string; sessionId: string }) => void;
  onCancel: (row: { itemId: string; sessionId: string }) => void;
  onNewBuild: () => void;
}) {
  const { t } = useI18n();
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
    {error && <p role="alert" className="mb-2 px-1 text-xs text-[var(--status-error-text)]">{error}</p>}
    {active && <WorkBoardActiveBuild title={activeTitle} needsReview={Boolean(active.needsReview)} onOpen={() => onOpen(active.sessionId)} />}
    {entries.map(entry => <WorkBoardActiveBuild key={entry.sessionId} title={entry.title} needsReview={false} checking={entry.checking} unavailable={entry.unavailable} forced={entry.forced} onOpen={() => onOpen(entry.sessionId)} />)}
    {!active && !entries.length && <Button size="xs" variant="ghost" disabled={busy} onClick={onNewBuild}
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
    <SortableContext items={order} strategy={verticalListSortingStrategy}>
      <div className="space-y-3">
        {rows.map((row, index) => <WorkBoardQueueRowItem key={row.itemId} row={row} index={index} order={order}
          busy={busy} disabled={busy || dragged !== null} onOpen={onOpen} onMove={onMove}
          onTogglePause={onTogglePause} onForce={onForce} onCancel={onCancel} />)}
      </div>
    </SortableContext>
  </div>;
}

/**
 * The build the project is running now. A lease awaiting review keeps the error
 * treatment — the server will not release it on its own — while a lease that is
 * actually running gets the moving band, so "working" and "stuck" never look
 * the same.
 */
function WorkBoardActiveBuild({ title, needsReview, checking = false, unavailable = false, forced = false, onOpen }: { title: string; needsReview: boolean; checking?: boolean; unavailable?: boolean; forced?: boolean; onOpen: () => void }) {
  const { t } = useI18n();
  return <button type="button" onClick={onOpen}
    className={'relative w-full overflow-hidden rounded-md border px-2.5 py-2 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring '
      + (needsReview
        ? 'border-[color-mix(in_srgb,var(--status-error)_50%,transparent)] bg-[var(--status-error-background)]'
        : forced
          ? 'border-[color-mix(in_srgb,var(--status-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--status-warning)_12%,var(--surface-elevated))] hover:bg-[color-mix(in_srgb,var(--status-warning)_18%,var(--surface-elevated))]'
          : 'border-[color-mix(in_srgb,var(--status-info)_42%,transparent)] bg-[color-mix(in_srgb,var(--status-info)_12%,var(--surface-elevated))] hover:bg-[color-mix(in_srgb,var(--status-info)_18%,var(--surface-elevated))]')}
    aria-label={checking ? t('workBoard.openSession') : t('workBoard.openBuild', { title })} title={title}>
    {!needsReview && !checking && !forced && <span aria-hidden="true" className="oc-build-stripes pointer-events-none absolute inset-0" />}
    <span className="relative flex min-w-0 items-center gap-2">
      <span className={'flex size-6 shrink-0 items-center justify-center rounded ' + (needsReview ? 'bg-[var(--status-error-background)] text-[var(--status-error-text)]' : forced ? 'bg-[color-mix(in_srgb,var(--status-warning)_26%,transparent)] text-[var(--status-warning-text)]' : 'bg-[color-mix(in_srgb,var(--status-info)_26%,transparent)] text-[var(--status-info)]')}>
          <Icon name={needsReview ? 'alert' : forced ? 'rocket' : 'terminal-box'} className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span dir="auto" className="block truncate text-xs font-semibold leading-5">{title}</span>
        <span className="block truncate text-[11px] leading-5 text-muted-foreground">{t(unavailable ? 'workBoard.unknown' : checking ? 'common.loading' : needsReview ? 'workBoard.needsReview' : forced ? 'workBoard.outsideQueue' : 'workBoard.buildingNow')}</span>
      </span>
      {!needsReview && !checking && <span className={'flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] ' + (forced ? 'text-[var(--status-warning-text)]' : 'text-[var(--status-info)]')}>
        <span className="size-1.5 rounded-full bg-[var(--status-success)] motion-safe:animate-pulse" />{t('workBoard.active')}
      </span>}
    </span>
  </button>;
}

/**
 * One lane. Everything a card lane can accept a drop, so a card dragged into an
 * empty lane still lands; the Build queue keeps its own membership and takes no
 * drops. The header holds the lane's own actions.
 */
function WorkBoardLaneColumn({ lane, droppable, count, children }: {
  lane: WorkBoardLane;
  droppable: boolean;
  count: number;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: LANE_PREFIX + lane, disabled: !droppable });
  return <section ref={setNodeRef} data-work-board-lane={lane} data-work-board-over={isOver ? '' : undefined}
    aria-label={t(`workBoard.${lane}`)} data-count={count}
    className={'flex min-w-[240px] flex-1 flex-col rounded-lg bg-surface-muted '
      + (isOver ? 'ring-2 ring-[var(--interactive-selection)] ' : '')}>
    {children}
  </section>;
}

/**
 * One lane card. It is a component rather than inline markup because the card's
 * own notice reads session state through hooks, and hooks cannot be called from
 * inside a collection's map: the hook would be counted per row and the render
 * order would change the moment a card appeared or left.
 *
 * A card is both draggable and a drop target: dragging moves it between lanes
 * and reorders it inside one, and dropping another card on it is how a place in
 * the middle of a lane is named.
 */
function WorkBoardCard({ card, lane, activity, checking, statusUnknown, needsReview, title, large, draggable, editing, text, setText, files, setFiles, busy, loading, error, editVersion, actions, onOpenCard, onStartEditing, onSaveEdits, onCancelEdits, onAddFiles, onAcknowledge }: {
  card: WorkBoardCard;
  lane: WorkBoardLane;
  activity: WorkBoardActivity | undefined;
  checking: boolean;
  statusUnknown: boolean;
  needsReview: boolean;
  title: string;
  large: boolean;
  draggable: boolean;
  editing: boolean;
  text: string;
  setText: (text: string) => void;
  files: WorkBoardAttachment[];
  setFiles: (files: WorkBoardAttachment[]) => void;
  busy: boolean;
  loading: boolean;
  error: string;
  editVersion: number | null;
  actions?: React.ReactNode;
  onOpenCard: () => void;
  onStartEditing: () => void;
  onSaveEdits: (version: number) => void;
  onCancelEdits: () => void;
  onAddFiles: (list: FileList | null) => void;
  onAcknowledge: () => void;
}) {
  const { t } = useI18n();
  // The card and the notice under it read the same inputs, so the amber
  // treatment and the notice it belongs to can never disagree.
  const feedback = useWorkBoardCardFeedback(card, activity, statusUnknown, needsReview);
  // A plan turn running now: its card carries the band and the green treatment,
  // and it is one of the two states that take the larger box.
  const activePlan = lane === 'plan' && Boolean(activity?.busy);
  // A card being edited has a textarea inside it: taking the drag here would
  // steal text selection, so the drag handle is off while the card is open.
  const sortable = useSortable({ id: card.id, disabled: !draggable || editing });
  const droppable = useDroppable({ id: card.id, disabled: !draggable });
  const setNodeRef = (node: HTMLElement | null) => { sortable.setNodeRef(node); droppable.setNodeRef(node); };
  const dragging = sortable.isDragging;
  return <article
    ref={setNodeRef}
    style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }}
    data-work-board-feedback={feedback ?? undefined}
    data-work-board-working={activePlan ? '' : undefined}
    data-work-board-dragging={dragging ? '' : undefined}
    className={'group relative overflow-hidden rounded-md border bg-surface-elevated '
      + (dragging ? 'opacity-60 ' : '')
      + (activePlan ? '' : 'border-border ')
      + (large ? 'px-2.5 py-2 ' : 'px-2.5 py-1.5 ')}>
    {activePlan && <span aria-hidden="true" className="oc-build-stripes oc-build-stripes-plan pointer-events-none absolute inset-0" />}
    <div className="relative">
    {editing ? <>
      <label className="text-xs font-medium">{t('workBoard.brief')}<textarea value={text} onChange={event => setText(event.target.value)} className="mt-2 min-h-32 w-full rounded-md border border-border bg-background p-2 text-sm" /></label>
      <label className="mt-2 block text-xs">{t('workBoard.addFiles')}<input type="file" multiple disabled={busy} onChange={event => { onAddFiles(event.target.files); event.target.value = ''; }} className="mt-1 block w-full text-xs" /></label>
      {files.map(file => <div key={file.id} className="mt-2 flex items-center justify-between gap-2 text-xs"><span className="truncate">{file.filename}</span><Button size="xs" variant="ghost" disabled={busy} onClick={() => setFiles(files.filter(item => item.id !== file.id))} aria-label={t('workBoard.remove')}><Icon name="close" className="size-3" /></Button></div>)}
      <div className="mt-3 flex gap-2"><Button size="xs" disabled={busy || editVersion === null || (!text.trim() && !files.length)} onClick={() => { if (editVersion !== null) onSaveEdits(editVersion); }}>{t('workBoard.save')}</Button><Button size="xs" variant="ghost" disabled={busy} onClick={onCancelEdits}>{t('workBoard.cancel')}</Button></div>
    </> : <div className="flex min-w-0 items-center gap-1">
      {/* The grip is the drag handle, and it is a button so the card still
          carries keyboard-reachable drag semantics. */}
      <button type="button" {...sortable.attributes} {...sortable.listeners} disabled={!draggable}
        aria-label={t('workBoard.dragCard', { title })} title={t('workBoard.dragCard', { title })}
        onClick={event => event.preventDefault()}
        className={'flex h-5 w-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 touch-none select-none '
          + (draggable ? 'cursor-grab hover:text-foreground active:cursor-grabbing' : 'opacity-30')}>
        <Icon name="drag-move-2" className="size-3.5" />
      </button>
      <WorkBoardCardMark card={card} />
      <button type="button" className="min-w-0 flex-1 truncate text-start text-xs font-medium leading-5 hover:underline" title={title} onClick={() => {
        onAcknowledge();
        if (card.sessionId) { onOpenCard(); return; }
        if (loading || error) return;
        onStartEditing();
      }}>{title}</button>
      {actions}
    </div>}
    {checking ? <p className="min-h-[1lh] text-xs leading-5 text-muted-foreground">{t('common.loading')}</p>
      : <WorkBoardSessionFeedback feedback={feedback} />}
    </div>
  </article>;
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
  // Reordering rearranges the tabs only: the project the user is looking at
  // stays the one on screen.
  const reorderProjectTab = (draggedProjectId: string, overProjectId: string) => {
    setWorkBoardProjectTabs(runtimeKey, {
      projectIds: reorderWorkBoardProjectTabs(visibleProjectTabs.map(project => project.id), draggedProjectId, overProjectId),
      activeProjectId: projectId,
    });
  };
  const directory = projects.find(project => project.id === projectId)?.path ?? '';
  const includeOlder = useUIStore(state => state.workBoardOlderSessions[JSON.stringify([runtimeKey, directory])] ?? false);
  const activeSessionIds = useGlobalSessionStatusStore(state => state.activeSessionIds);
  const shellSessionIds = useBackgroundShellsStore(state => state.sessionIds);
  const [boardActive, setBoardActive] = React.useState<{ directory: string; ids: Set<string> }>({ directory: '', ids: new Set() });
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
  const [editing, setEditing] = React.useState<string | null>(null);
  const [editVersion, setEditVersion] = React.useState<number | null>(null);
  const [editConflict, setEditConflict] = React.useState<WorkBoardCard | null>(null);
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
  const [resolveConfirm, setResolveConfirm] = React.useState<{ action: 'skip' | 'retry'; issue: string } | null>(null);
  const [forceConfirm, setForceConfirm] = React.useState<{ itemId: string; sessionId: string; title: string } | null>(null);
  const [drag, setDrag] = React.useState<WorkBoardDrag | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const generation = React.useRef(0);
  const refreshSequence = React.useRef(0);
  const [verifiedActivities, setVerifiedActivities] = React.useState<Set<string>>(new Set());
  const visibleCards = React.useMemo(() => {
    const linked = new Set(cards.map(card => card.sessionId));
    const active = new Set([...activeSessionIds, ...shellSessionIds,
      ...(boardActive.directory === directory ? boardActive.ids : []),
      ...(queue?.active.map(item => item.sessionId) ?? []), ...(queue?.queued.map(item => item.sessionId) ?? []),
      ...(queue?.forced?.map(item => item.sessionId) ?? [])]);
    const existing: WorkBoardCard[] = workBoardSessions(sessions, directory, includeOlder, active, Date.now()).filter(session => !linked.has(session.id))
      .map(session => ({ id: `session:${session.id}`, directory, text: session.title, attachments: [],
        sessionId: session.id, stage: 'plan', createdAt: session.time.created, updatedAt: session.time.updated }));
    return [...cards, ...existing];
  }, [cards, sessions, directory, includeOlder, activeSessionIds, shellSessionIds, boardActive, queue]);
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
  const historyBusy = React.useRef(new Set<string>());
  const [placements, setPlacements] = React.useState<BoardSnapshot['placements']>(new Map());
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

  React.useEffect(() => useWorkBoardSavedTodo.subscribe((state, previousState) => {
    const latestSave = state.latestSave;
    if (latestSave === previousState.latestSave) return;
    if (latestSave?.runtimeKey !== runtimeKey || latestSave.card.directory !== directory) return;
    const updated = latestSave.card;
    setCards(previous => previous.some(card => card.id === updated.id)
      ? previous.map(card => card.id === updated.id ? updated : card) : [...previous, updated]);
    void refresh();
  }), [directory, runtimeKey, refresh]);

  const lastBoard = React.useRef<BoardSnapshot>({ cards, activities, versions: new Map(), placements: new Map() });
  React.useLayoutEffect(() => {
    generation.current += 1;
    // Paint the board's own cards from the last visit before the fetch lands,
    // so the first frame already shows the user their board instead of an empty
    // one that fills in. The fetch replaces this seed with authoritative cards.
    const remembered = readWorkBoardMemory(runtimeKey, directory);
    setCards(remembered?.cards ?? (directory ? readWorkBoardCards(directory) ?? [] : []));
    setLoading(true);
    setError('');
    setActionError('');
    setActivities(new Map([...remembered?.activities ?? []].map(([id, activity]) => [id, { ...activity, busy: false }])));
    setPlacements(remembered?.placements ?? new Map());
    setVerifiedActivities(new Set());
    setBoardActive({ directory, ids: new Set() });
    setUnavailable(new Set());
    sessionVersions.current = new Map(remembered?.versions);
    messageCache.current = new Map([...remembered?.activities ?? []].map(([id, activity]) => [id, activity.messages]));
    historyBusy.current = new Set([...remembered?.activities ?? []].filter(([, activity]) => activity.busy).map(([id]) => id));
    setEditing(null);
    setEditVersion(null);
    setEditConflict(null);
    void refresh();
    const onFocus = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    const timer = setInterval(onFocus, 30000);
    return () => {
      rememberWorkBoard(runtimeKey, directory, lastBoard.current);
      generation.current += 1; clearInterval(timer); window.removeEventListener('focus', onFocus);
    };
  }, [directory, refresh, runtimeKey]);

  // History identifies the agent that actually ran. Live status decides whether
  // a completed step can be treated as a settled turn.
  React.useEffect(() => {
    let cancelled = false;
    let refreshing = false;
    const readActivity = async () => {
      if (refreshing || !directory || document.visibilityState !== 'visible') return;
      refreshing = true;
      const runtime = getRuntimeKey();
      const token = generation.current;
      const next = new Map<string, WorkBoardActivity>();
      const failed = new Set<string>();
      try {
        const status = await opencodeClient.getActiveSessionStatuses(directory);
        if (cancelled || token !== generation.current || runtime !== getRuntimeKey()) return;
        const activeIds = new Set(Object.keys(status ?? {}));
        if (status !== null) setBoardActive({ directory, ids: activeIds });
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
            if (cached && !running && !historyBusy.current.has(card.id) && version !== undefined && sessionVersions.current.get(card.id) === version) {
              next.set(card.id, { busy: false, messages: cached });
              return;
            }
            const page = await opencodeClient.getSessionMessages(card.sessionId, { limit: 32, order: 'desc', partShells: true }, card.directory);
            const messages = page.items.map(item => item.info).reverse();
            if (!cancelled && runtime === getRuntimeKey() && token === generation.current) {
              if (version !== undefined) sessionVersions.current.set(card.id, version);
              messageCache.current.set(card.id, messages);
              if (running) historyBusy.current.add(card.id);
              else historyBusy.current.delete(card.id);
            }
            next.set(card.id, { busy: running, messages });
          } catch { failed.add(card.id); }
        }));
        if (!cancelled && token === generation.current && runtime === getRuntimeKey()) {
          setActivities(previous => {
            const merged = new Map([...previous, ...next]);
            for (const id of failed) {
              const activity = merged.get(id);
              if (activity) merged.set(id, { ...activity, busy: false });
            }
            return merged;
          });
          setUnavailable(failed);
          setVerifiedActivities(new Set(next.keys()));
        }
      } finally { refreshing = false; }
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
  const saveEditedCard = async (expectedUpdatedAt: number) => {
    if (!editing) return;
    const cardId = editing;
    const editedText = text;
    const editedFiles = files;
    setBusy(true);
    setActionError('');
    try {
      await updateWorkBoardCard(cardId, {
        text: editedText, attachments: editedFiles, expectedUpdatedAt,
      });
      setEditing(null);
      setEditVersion(null);
      setEditConflict(null);
      await refresh();
    } catch (cause) {
      if (cause instanceof WorkBoardRequestError && cause.status === 409) {
        try {
          const latest = (await fetchWorkBoard(directory)).find(card => card.id === cardId);
          if (!latest) {
            setActionError(t('workBoard.failed'));
            setEditConflict(null);
            return;
          }
          setCards(previous => previous.map(card => card.id === latest.id ? latest : card));
          setEditConflict(latest);
        } catch (loadError) {
          setActionError(loadError instanceof Error ? loadError.message : t('workBoard.failed'));
        }
      } else {
        setActionError(cause instanceof Error ? cause.message : t('workBoard.failed'));
      }
    } finally {
      setBusy(false);
    }
  };
  const useSavedEditVersion = () => {
    if (!editConflict) return;
    setCards(previous => previous.map(card => card.id === editConflict.id ? editConflict : card));
    setEditing(null);
    setEditVersion(null);
    setEditConflict(null);
  };
  // Acknowledges the completion the user just opened, so every client clears
  // the mark. Only stored cards have a server record; an inherited card is
  // completed on demand and gains one then.
  const acknowledge = (card: WorkBoardCard) => {
    if (!workBoardShowsCompletionMark(card) || card.id.startsWith('session:')) return;
    void markWorkBoardCardViewed(card.id).then(() => { void refresh(); }).catch(() => {});
  };
  // Opening a session from the board always leaves the board. The queue rows
  // and the running-build banner route through here too: the board is a
  // full-surface overlay, so a session switch that does not dismiss it looks
  // like a dead click, and leaves the tab-reconcile effect to rewrite the
  // board out from under the user. The session's own directory wins over the
  // board's active tab, which may be a different project than the build's.
  const open = (sessionId: string, fallbackDirectory: string) => {
    const actualDirectory = sessions.find(session => session.id === sessionId)?.directory ?? fallbackDirectory;
    useSessionUIStore.getState().setCurrentSession(sessionId, actualDirectory);
    useUIStore.getState().closeMainSurfaces();
  };
  const promote = (card: WorkBoardCard) => void mutate(async () => {
    if (card.sessionId) { open(card.sessionId, card.directory); return; }
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
    () => (queueError || !queue ? [] : queue.queued.filter(item => workBoardDirectoryKey(item.directory) === workBoardDirectoryKey(directory))),
    [directory, queue, queueError],
  );
  // Every open tab carries its own project's build count, so the header reads as
  // an overview of which projects are building without switching tabs.
  const buildBadges = React.useMemo(
    () => workBoardBuildBadges(visibleProjectTabs, queue, Boolean(queueError)),
    [visibleProjectTabs, queue, queueError],
  );
  const activeBuild = React.useMemo(
    () => (!queueError && queue ? queue.active.find(item => workBoardDirectoryKey(item.directory) === workBoardDirectoryKey(directory)) : undefined),
    [directory, queue, queueError],
  );
  const sessionTitleFor = React.useCallback(
    (sessionId: string) => sessions.find(session => session.id === sessionId)?.title
      || t('workBoard.sessionFallback', { id: sessionId.slice(0, 9) }),
    [sessions, t],
  );
  const queueRows = React.useMemo(() => workBoardQueueRows(queuedItems, sessionTitleFor), [queuedItems, sessionTitleFor]);
  const queueOrder = React.useMemo(() => queuedItems.map(item => item.id), [queuedItems]);
  // Forced builds have no lease and no queue row; the server names them, and
  // their titles come from the same session list the rows use.
  const forcedBuilds = React.useMemo(
    () => (!queueError && queue ? (queue.forced ?? [])
      .filter(item => workBoardDirectoryKey(item.directory) === workBoardDirectoryKey(directory))
      .map(item => ({ sessionId: item.sessionId, title: sessionTitleFor(item.sessionId) })) : []),
    [directory, queue, queueError, sessionTitleFor],
  );

  // The active project's own paused state, if any. A review-frozen lease needs
  // the user to look at that session; a Git hold only needs the tree cleaned or
  // the policy changed. The two carry different actions below.
  const queueIssue = React.useMemo(
    () => (!queueError && queue ? queue.issues.find(item => workBoardDirectoryKey(item.directory) === workBoardDirectoryKey(directory))?.issue : undefined),
    [directory, queue, queueError],
  );
  const needsReview = Boolean(activeBuild?.needsReview);
  // A review-frozen lane whose session is running again is continued by adopting
  // that live turn, not by releasing into a void. The board only knows what it
  // sees, so this is a wording hint: the server decides.
  const reviewSessionBusy = React.useMemo(() => {
    const sessionId = activeBuild?.sessionId;
    if (!sessionId) return false;
    const card = cards.find(entry => entry.sessionId === sessionId);
    return card ? Boolean(activities.get(card.id)?.busy) : false;
  }, [activeBuild?.sessionId, cards, activities]);
  const reviewConfirmWording = workBoardReviewConfirmWording(resolveConfirm?.action, reviewSessionBusy);

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

  const rememberedPlacement = (card: WorkBoardCard) => {
    if (verifiedActivities.has(card.id)) return undefined;
    const placement = placements.get(card.id);
    return placement?.updatedAt === card.updatedAt && placement.sessionId === card.sessionId ? placement : undefined;
  };
  const laneFor = (card: WorkBoardCard): WorkBoardLane => queueStateFor(card) ? 'queue'
    : rememberedPlacement(card)?.lane ?? workBoardLane(card, activities.get(card.id), undefined);
  const completionTimeFor = (card: WorkBoardCard) => rememberedPlacement(card)?.completedAt
    ?? workBoardCompletionTime(card, activities.get(card.id));

  /**
   * Every lane's cards, in the order the board shows them. A card's stored
   * `placementOrder` wins where it exists; anything else follows in the board's
   * own order, so a new card lands at the end of an arrangement the user set
   * rather than in the middle. An unarranged lane falls back to its own rule —
   * newest completion first in Done.
   */
  const orderedLanes = React.useMemo(() => {
    const byLane = new Map<WorkBoardLane, WorkBoardCard[]>(lanes.map(lane => [lane, []]));
    for (const card of visibleCards) byLane.get(laneFor(card))?.push(card);
    byLane.get('done')?.sort((a, b) => completionTimeFor(b) - completionTimeFor(a) || a.id.localeCompare(b.id));
    const ordered = new Map<WorkBoardLane, WorkBoardCard[]>();
    for (const [lane, cardsInLane] of byLane) {
      const arranged = cardsInLane.filter(card => card.placementOrder !== undefined)
        .sort((a, b) => (a.placementOrder ?? 0) - (b.placementOrder ?? 0));
      ordered.set(lane, [...arranged, ...cardsInLane.filter(card => card.placementOrder === undefined)]);
    }
    return ordered;
    // laneFor and completionTimeFor read the current cards, activities and queue
    // state, all of which are dependencies here.
  }, [visibleCards, activities, queue, queueError, verifiedActivities, placements]); // eslint-disable-line react-hooks/exhaustive-deps

  React.useLayoutEffect(() => {
    const ids = new Set(visibleCards.map(card => card.id));
    lastBoard.current = {
      cards,
      activities: new Map([...activities].filter(([id]) => ids.has(id)).map(([id, activity]) =>
        [id, { ...activity, busy: activity.busy || historyBusy.current.has(id) }])),
      versions: new Map([...sessionVersions.current].filter(([id]) => ids.has(id))),
      placements: new Map(visibleCards.map(card => [card.id, {
        lane: laneFor(card), completedAt: completionTimeFor(card), updatedAt: card.updatedAt, sessionId: card.sessionId,
      }])),
    };
  });
  // A lease awaiting review is unfinished work the server will not release on
  // its own; completing its card would hide that resolution. Manual Done stays
  // out of reach for it.
  const canComplete = (card: WorkBoardCard) => {
    if (loading || error) return false;
    const lane = laneFor(card);
    if (lane !== 'todo' && lane !== 'plan' && lane !== 'build') return false;
    if (!card.sessionId) return true;
    return verifiedActivities.has(card.id) && Boolean(activities.get(card.id)) && !activities.get(card.id)?.busy && !unavailable.has(card.id)
      && !queueError && queue !== null;
  };
  // Every lane's own card moves into Done together, from its own menu. Done has
  // no such action: its cards are already there.
  const completeAllIn = (lane: WorkBoardLane) => {
    const inLane = orderedLanes.get(lane) ?? [];
    const eligible = inLane.filter(canComplete);
    if (!eligible.length) return;
    place(eligible, 'done', null);
  };
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
  const queueMutate = async (url: string, method: 'PUT' | 'DELETE' | 'POST', body?: WorkBoardQueueWrite) => {
    setQueueBusy(true);
    setQueueActionError('');
    try {
      const init: RequestInit = { method };
      if (body) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(body);
      }
      const response = await runtimeFetch(url, init);
      const payload = queueErrorSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok) throw new Error((payload.success && payload.data.error) || `HTTP ${response.status}`);
      // A forced build can report that its prompt was not confirmed: the item
      // stays queued, so say so instead of reading as a clean success.
      if (payload.success && payload.data.warning) setQueueActionError(payload.data.warning);
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
  const reorderQueued = (activeId: string, overId: string | null) => {
    const from = queueOrder.indexOf(activeId);
    if (from < 0) return;
    const overIndex = overId === null ? queueOrder.length - 1 : queueOrder.indexOf(overId);
    if (overIndex < 0 || overIndex === from) return;
    const order = [...queueOrder];
    const [moved] = order.splice(from, 1);
    order.splice(overIndex, 0, moved);
    void queueMutate('/api/build-queue/order', 'PUT', { directory, ids: order });
  };
  const toggleQueuedPause = (row: { itemId: string; sessionId: string; paused: boolean }) =>
    void queueMutate('/api/build-queue/sessions/' + encodeURIComponent(row.sessionId) +
      '/items/' + encodeURIComponent(row.itemId) + '/pause', 'PUT', { paused: !row.paused });
  const cancelQueued = (row: { itemId: string; sessionId: string }) =>
    void queueMutate('/api/build-queue/sessions/' + encodeURIComponent(row.sessionId) +
      '/items/' + encodeURIComponent(row.itemId), 'DELETE');
  // Continue drops the frozen item and releases the lane, so it confirms first:
  // a mis-click on a header control must not silently discard queued work. The
  // itemId pins the confirmation to the lease the user was looking at.
  const confirmResolve = () => {
    if (!resolveConfirm || !directory) return;
    const body: WorkBoardQueueWrite = resolveConfirm.action === 'skip'
      ? { directory, itemId: activeBuild?.itemId, action: 'skip' }
      : { directory, action: 'retry' };
    setResolveConfirm(null);
    void queueMutate('/api/build-queue/resolve', 'POST', body);
  };
  // Force starts one waiting build outside the queue, so it confirms first: a
  // mis-click must not start a second build in a project that is already
  // building. The captured session and item pin the confirmation to that row.
  const forceQueued = (row: { itemId: string; sessionId: string }) =>
    setForceConfirm({ itemId: row.itemId, sessionId: row.sessionId, title: sessionTitleFor(row.sessionId) });
  const confirmForce = () => {
    if (!forceConfirm || !directory) return;
    const body: WorkBoardQueueWrite = { directory, sessionId: forceConfirm.sessionId, itemId: forceConfirm.itemId };
    setForceConfirm(null);
    void queueMutate('/api/build-queue/force', 'POST', body);
  };

  /**
   * Move one card to a lane, or to a place inside one. The board write and the
   * session-work write are separate steps on purpose: the card is placed even
   * when the session cannot be reached, and a failed session write is reported
   * on its own rather than rolled back.
   */
  const place = (cards: WorkBoardCard[], lane: WorkBoardCardLane, before: string | null) => void mutate(async () => {
    if (!cards.length) return;
    const at = Date.now();
    const targets = cards.map(card => ({
      id: card.id, updatedAt: card.updatedAt, text: card.text, sessionId: card.sessionId,
    }));
    const result: { placed: WorkBoardCard[]; failed: { id: string; error: string }[] } = cards.length === 1
      ? { placed: [await placeWorkBoardCard(cards[0], lane, at, before)], failed: [] }
      : await placeWorkBoardCards(directory, lane, at, targets);
    const failures = result.failed.map(failure => `${workBoardCardTitle(cards.find(card => card.id === failure.id)?.text ?? failure.id, [])}: ${failure.error}`);
    // A linked session follows its card: into Done means the work is done and
    // the session leaves In work; out of Done puts it back.
    for (const card of cards) {
      if (!card.sessionId || !result.placed.some(placed => placed.id === card.id)) continue;
      const sessionDirectory = sessions.find(session => session.id === card.sessionId)?.directory ?? card.directory;
      try { await setSessionWorkState(card.sessionId, sessionDirectory, lane === 'done' ? 'done' : 'open'); }
      catch (cause) { failures.push(`${workBoardCardTitle(card.text, card.attachments)}: ${cause instanceof Error ? cause.message : t('workBoard.failed')}`); }
    }
    if (!failures.length) return;
    throw new Error(t('workBoard.placeFailed', { count: failures.length }) + '\n' + failures.join('\n'));
  });

  const dragStart = (event: DragStartEvent) => {
    const id = String(event.active.id);
    const row = queueRows.find(candidate => candidate.itemId === id);
    if (row) { setDrag({ type: 'queue', id, title: row.title }); return; }
    const card = visibleCards.find(candidate => candidate.id === id);
    const lane = card ? laneFor(card) : 'queue';
    if (!card || lane === 'queue') return;
    setDrag({ type: 'card', id, lane, title: card.briefRemoved && card.sessionId
      ? sessionTitleFor(card.sessionId) : workBoardCardTitle(card.text, card.attachments) });
  };
  const dragEnd = (event: DragEndEvent) => {
    const held = drag;
    const overId = event.over ? String(event.over.id) : null;
    setDrag(null);
    if (!held || overId === null) return;
    // A lane droppable names the lane; a card names a place inside its own lane.
    if (held.type === 'card' && overId.startsWith(LANE_PREFIX)) {
      // SAFETY: every lane droppable id is a LANE_PREFIX plus a lane name, and
      // only card lanes are droppable, so the suffix is a card lane.
      const target = overId.slice(LANE_PREFIX.length) as WorkBoardCardLane;
      if (target === held.lane) return;
      const card = visibleCards.find(candidate => candidate.id === held.id);
      if (card) place([card], target, null);
      return;
    }
    if (held.type === 'queue') {
      if (overId.startsWith(LANE_PREFIX)) return;
      reorderQueued(held.id, overId === held.id ? null : overId);
      return;
    }
    const card = visibleCards.find(candidate => candidate.id === held.id);
    if (!card) return;
    const overCard = visibleCards.find(candidate => candidate.id === overId);
    const overLane = overCard ? laneFor(overCard) : undefined;
    const targetLane: WorkBoardCardLane = overLane === undefined || overLane === 'queue' ? held.lane : overLane;
    const current = laneCards(targetLane);
    const before = overId === held.id || overId.startsWith(LANE_PREFIX) ? null
      : targetLane === held.lane
        ? workBoardOrderNeighbour(workBoardMoved(current, held.id, current.indexOf(overId)), held.id)
        : overId;
    place([card], targetLane, before);
  };
  const laneCards = (lane: WorkBoardLane) => (orderedLanes.get(lane) ?? []).map(card => card.id);

  return <div className="absolute inset-0 z-10 flex flex-col bg-background" aria-label={t('workBoard.title')}>
    {/* items-end + pt-3-only puts the project tabs on the header's lower edge, so
        a selected tab can flow into the board; the title and controls carry their
        own bottom padding and stay vertically centred. The header owns a surface
        because the selected tab is filled with the board's colour — against the
        bare board background the connection would read as an outline. */}
    <header className="flex flex-wrap items-end gap-3 border-b border-border bg-surface-muted px-4 pt-3">
      <h1 className="pb-3 text-lg font-semibold">{t('workBoard.title')}</h1>
      <WorkBoardProjectTabs
        projects={projects}
        openProjectIds={visibleProjectTabs.map(project => project.id)}
        activeProjectId={projectId}
        disabled={busy}
        badges={buildBadges}
        onSelect={nextProjectId => setWorkBoardProjectTabs(runtimeKey, {
          projectIds: visibleProjectTabs.map(project => project.id),
          activeProjectId: nextProjectId,
        })}
        onAdd={addProjectTab}
        onClose={closeProjectTab}
        onReorder={reorderProjectTab}
      />
      <label className="flex items-center gap-2 pb-3 text-xs text-muted-foreground">
        <input type="checkbox" checked={includeOlder} disabled={!directory || busy}
          onChange={event => useUIStore.getState().setWorkBoardOlderSessions(runtimeKey, directory, event.target.checked)} />
        {t('workBoard.includeOlderSessions')}
      </label>
      <Button size="sm" variant="ghost" className="mb-2" onClick={() => useUIStore.getState().setWorkBoardOpen(false)} aria-label={t('workBoard.cancel')}><Icon name="close" className="size-4" /></Button>
    </header>
    {(needsReview || queueIssue) && <section role="alert" className="mx-4 mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-[var(--status-warning)]/40 bg-[color-mix(in_srgb,var(--status-warning)_7%,transparent)] px-3 py-2">
      <Icon name="alert" className="size-4 shrink-0 text-status-warning" />
      <p className="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">{queueIssue || t('workBoard.needsReview')}</p>
      {needsReview && <Button size="sm" variant="outline" disabled={!directory || queueBusy}
        onClick={() => setResolveConfirm({ action: 'skip', issue: queueIssue || t('workBoard.needsReview') })}>
        {t('buildQueue.recovery.continue')}
      </Button>}
      {!needsReview && queueIssue && <Button size="sm" variant="outline" disabled={!directory || queueBusy}
        onClick={() => setResolveConfirm({ action: 'retry', issue: queueIssue })}>
        {t('settings.openchamber.buildQueue.policy.retry')}
      </Button>}
    </section>}
    {(actionError || error || queueError || sessionsError) && <div role="alert" className="px-4 py-2 text-sm text-[var(--status-error-text)]">{actionError || error || queueError || t('workBoard.unknown')}</div>}
    {!directory ? <p className="p-4">{t('workBoard.noProject')}</p> : <DndContext sensors={sensors} collisionDetection={collide} onDragStart={dragStart} onDragEnd={dragEnd} onDragCancel={() => setDrag(null)}>
    <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-4">
      {lanes.map(lane => {
        const inLane = orderedLanes.get(lane) ?? [];
        // The queue snapshot owns managed rows. Live builds without a queue
        // entry must also render, once per session, with no queue mutations.
        const liveBuilds = new Map<string, { sessionId: string; title: string; checking: boolean; unavailable: boolean }>();
        if (lane === 'queue') {
          for (const card of inLane) {
            if (card.sessionId && !queueStateFor(card)) {
              liveBuilds.set(card.sessionId, { sessionId: card.sessionId, title: sessionTitleFor(card.sessionId), checking: !verifiedActivities.has(card.id), unavailable: unavailable.has(card.id) });
            }
          }
        }
        const activeEntries = lane === 'queue' ? workBoardActiveEntries(forcedBuilds, [...liveBuilds.values()]) : [];
        const count = lane === 'queue' ? queueRows.length + (activeBuild ? 1 : 0) + activeEntries.length : inLane.length;
        return <WorkBoardLaneColumn key={lane} lane={lane} droppable={lane !== 'queue'} count={count}>
          <div className="flex items-center gap-2 px-3 py-3">
            <h2 className="flex flex-1 items-center gap-2 text-sm font-semibold">{t(`workBoard.${lane}`)}<span className="text-muted-foreground">{count}</span></h2>
            {(lane === 'todo' || lane === 'plan') && <Button size="sm" variant="ghost" disabled={!directory || busy || (lane === 'plan' && !agents.some(agent => agent.name === 'plan'))} onClick={() => newCard(lane)} aria-label={t(lane === 'todo' ? 'workBoard.newTodo' : 'workBoard.newPlan')} title={t(lane === 'todo' ? 'workBoard.newTodo' : 'workBoard.newPlan')}><Icon name="add" className="size-4" /></Button>}
            {lane !== 'queue' && <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" disabled={busy || !inLane.length} aria-label={t('workBoard.laneActions')} title={t('workBoard.laneActions')}><Icon name="more" className="size-4" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => completeAllIn(lane)}>{t('workBoard.completeAll')}</DropdownMenuItem></DropdownMenuContent>
            </DropdownMenu>}
          </div>
          {lane === 'queue' ? <WorkBoardQueueColumn
            rows={queueRows}
            active={activeBuild}
            activeTitle={activeBuild ? sessionTitleFor(activeBuild.sessionId) : ''}
            entries={activeEntries}
            order={queueOrder}
            busy={queueBusy}
            error={queueActionError}
            dragged={drag?.type === 'queue' ? drag.id : null}
            onOpen={sessionId => open(sessionId, directory)}
            onMove={moveQueued}
            onTogglePause={toggleQueuedPause}
            onForce={forceQueued}
            onCancel={cancelQueued}
            onNewBuild={() => newCard('queue')}
          /> : <SortableContext items={inLane.map(card => card.id)} strategy={verticalListSortingStrategy}>
            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-3">
            {!inLane.length && <p className="px-2 py-4 text-xs text-muted-foreground">{
              loading ? t('common.loading')
                : error ? t('workBoard.unknown')
                : lane === 'plan' && sessionsLoading ? t('common.loading')
                : t('workBoard.empty')
            }</p>}
            {inLane.map(card => {
              const activity = activities.get(card.id);
              const checking = Boolean(card.sessionId) && !verifiedActivities.has(card.id) && !unavailable.has(card.id);
              const statusUnknown = Boolean(card.sessionId) && (!verifiedActivities.has(card.id) || unavailable.has(card.id));
              const hasRunningTurn = Boolean(activity?.busy);
              const canReturnToTodo = !loading && !error && Boolean(card.sessionId) && lane !== 'todo' && !hasRunningTurn
                && !statusUnknown && !queueError && queue !== null;
              const canRemove = !loading && !error && lane === 'todo' && !hasRunningTurn
                && (!card.sessionId || (!statusUnknown && !queueError && queue !== null));
              const title = card.briefRemoved && card.sessionId
                ? sessionTitleFor(card.sessionId) : workBoardCardTitle(card.text, card.attachments);
              // A card is one of two sizes. Every card that can carry a status
              // line — a working plan, or any card linked to a session, which
              // can gain "Needs attention" or a loading line — takes the larger
              // box. That is what makes the running build, the waiting rows and
              // a working plan card in the queue column one height. A card with
              // nothing to report, and an unstarted To-do with no session to
              // report on, stays compact.
              const large = (lane === 'plan' && hasRunningTurn) || lane !== 'todo' || Boolean(card.sessionId);
              return <WorkBoardCard
                key={card.id}
                card={card}
                lane={lane}
                activity={activity}
                checking={checking}
                statusUnknown={statusUnknown}
                needsReview={Boolean(queueStateFor(card)?.needsReview)}
                title={title}
                large={large}
                draggable={!loading && !error && !busy}
                editing={editing === card.id}
                text={text}
                setText={setText}
                files={files}
                setFiles={setFiles}
                busy={busy}
                loading={loading}
                error={error}
                editVersion={editVersion}
                onOpenCard={() => open(card.sessionId!, card.directory)}
                onStartEditing={() => { setEditing(card.id); setEditVersion(card.updatedAt); setText(card.text); setFiles(card.attachments); }}
                onAcknowledge={() => acknowledge(card)}
                onAddFiles={list => { void addFiles(list); }}
                onCancelEdits={() => { setEditing(null); setEditVersion(null); }}
                onSaveEdits={version => void saveEditedCard(version)}
                actions={<>
                  {canComplete(card) && <button type="button"
                    disabled={busy || loading || Boolean(error)}
                    aria-label={t('workBoard.moveToDone', { title })}
                    title={t('workBoard.moveToDone', { title })}
                    onClick={() => place([card], 'done', null)}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-40 transition-opacity hover:text-[var(--status-success-text)] hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    <Icon name="check" className="size-3.5" />
                  </button>}
                  {(!card.sessionId || canReturnToTodo || canRemove) ? <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <button type="button" disabled={busy || loading || Boolean(error)} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-40 transition-opacity hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100" title="Card actions" aria-label={`Actions for ${title}`}>
                      <Icon name="more" className="size-3.5" />
                    </button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {!card.sessionId && <DropdownMenuItem onClick={() => promote(card)}>{t('workBoard.startPlan')}</DropdownMenuItem>}
                    {canReturnToTodo && <DropdownMenuItem onClick={() => void mutate(async () => {
                      const actualDirectory = sessions.find(session => session.id === card.sessionId)?.directory ?? card.directory;
                      await saveSessionToTodo(card.sessionId!, card.directory, actualDirectory, card.text, []);
                    })}>{t('workBoard.backTodo')}</DropdownMenuItem>}
                    {canRemove && <DropdownMenuItem onClick={() => void mutate(async () => {
                      await deleteWorkBoardCard(card.id);
                    })}>{t('workBoard.remove')}</DropdownMenuItem>}
                  </DropdownMenuContent>
                </DropdownMenu> : null}
                </>}
              />;
            })}
          </div>
          </SortableContext>}
        </WorkBoardLaneColumn>;
      })}
    </div>
    <DragOverlay dropAnimation={null}>
      {drag ? <div className="flex max-w-[260px] items-center gap-2 rounded-md border border-border bg-surface-elevated px-2.5 py-1.5 text-xs font-medium shadow-lg">
        <Icon name={drag.type === 'queue' ? 'terminal-box' : 'drag-move-2'} className="size-3.5 shrink-0 text-muted-foreground" />
        <span dir="auto" className="truncate">{drag.title}</span>
      </div> : null}
    </DragOverlay>
    </DndContext>}
    <Dialog open={editConflict !== null} onOpenChange={open => { if (!open && !busy) setEditConflict(null); }}>
      <DialogContent>
        <DialogTitle>{t('workBoard.editConflictTitle')}</DialogTitle>
        <DialogDescription>{t('workBoard.editConflictDescription')}</DialogDescription>
        <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border border-border bg-surface-muted p-3">
          {editConflict?.text && <p dir="auto" className="whitespace-pre-wrap break-words text-sm">{editConflict.text}</p>}
          {editConflict?.attachments.map(file => <p key={file.id} className="break-all text-xs text-muted-foreground">{file.filename}</p>)}
        </div>
        {editConflict?.briefRemoved && <p className="text-sm text-muted-foreground">{t('workBoard.editConflictBriefRemoved')}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={useSavedEditVersion}>{t('workBoard.useSavedVersion')}</Button>
          {!editConflict?.sessionId && !editConflict?.briefRemoved && <Button disabled={busy || !editConflict} onClick={() => { if (editConflict) void saveEditedCard(editConflict.updatedAt); }}>{t('workBoard.keepMyEdits')}</Button>}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={savedCard !== null} onOpenChange={open => { if (!open) useWorkBoardSavedTodo.setState({ confirmation: null }); }}>
      <DialogContent className="max-w-2xl">
        <DialogTitle>{t('workBoard.saved')}</DialogTitle>
        <div className="max-h-[65vh] overflow-y-auto">{savedCard && <SavedTodoBrief card={savedCard} />}</div>
      </DialogContent>
    </Dialog>
    <Dialog open={resolveConfirm !== null} onOpenChange={open => { if (!open && !queueBusy) setResolveConfirm(null); }}>
      <DialogContent showCloseButton={!queueBusy}>
        <DialogTitle>{resolveConfirm?.action === 'retry'
          ? t('settings.openchamber.buildQueue.policy.retry')
          : reviewConfirmWording === 'adopt'
            ? t('buildQueue.adopt.title')
            : t('buildQueue.recovery.continue')}</DialogTitle>
        <DialogDescription>{reviewConfirmWording === 'adopt'
          ? t('buildQueue.adopt.description')
          : resolveConfirm?.issue}</DialogDescription>
        <DialogFooter>
          <Button variant="outline" disabled={queueBusy} onClick={() => setResolveConfirm(null)}>{t('workBoard.cancel')}</Button>
          <Button disabled={queueBusy} onClick={confirmResolve}>{t('workBoard.resume')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={forceConfirm !== null} onOpenChange={open => { if (!open && !queueBusy) setForceConfirm(null); }}>
      <DialogContent showCloseButton={!queueBusy}>
        <DialogTitle>{t('buildQueue.force.title')}</DialogTitle>
        <DialogDescription>{t('buildQueue.force.description')}</DialogDescription>
        {forceConfirm && <p className="text-sm text-muted-foreground" dir="auto">{forceConfirm.title}</p>}
        <DialogFooter>
          <Button variant="outline" disabled={queueBusy} onClick={() => setForceConfirm(null)}>{t('workBoard.cancel')}</Button>
          <Button disabled={queueBusy} onClick={confirmForce}>{t('buildQueue.force.confirm')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
