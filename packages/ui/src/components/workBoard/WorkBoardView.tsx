import React from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { workBoardCardTitle } from './workBoardCardTitle';
import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { SessionActivityIndicator } from '@/components/session/SessionActivityIndicator';
import { useSessionTurnActivity } from '@/sync/global-session-status';
import { useSessionUnseenCount } from '@/sync/notification-store';
import { useI18n } from '@/lib/i18n';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { createSession, setSessionWorkState } from '@/sync/session-actions';
import { opencodeClient } from '@/lib/opencode/client';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isAutoModel } from '@/lib/routing/autoModel';
import { getProviderModelDisplayName } from '@/lib/modelDisplay';
import { getRuntimeKey, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { createChatDraftIdentity } from '@/lib/chatDraftPersistence';
import { useWorkBoardSnapshot } from '@/hooks/useWorkBoardSnapshot';
import { useBuildQueueSnapshot } from '@/hooks/useBuildQueueSnapshot';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { updateWorkBoardCard, saveSessionToTodo, deleteWorkBoardCard, placeWorkBoardCard, placeWorkBoardCards, markWorkBoardCardViewed, updateQueueSettings, type WorkBoardCard, type WorkBoardSnapshotCard, type WorkBoardQueuedModel, type WorkBoardWaitingKind } from '@/lib/workBoardApi';
import { workBoardMoved, workBoardOrderNeighbour, workBoardFeedback, workBoardShowsCompletionMark, workBoardReviewConfirmWording, startWorkBoardPlan, workBoardBuildBadges, workBoardTabAsks, workBoardsNeedingAttention, workBoardReordered, workBoardActiveEntries, workBoardCardLane, workBoardSnapshotRows, workBoardSnapshotOrder, workBoardQueueFromSnapshot, type WorkBoardActiveEntry, type WorkBoardActivity, type WorkBoardCardLane, type WorkBoardLane, type WorkBoardQueueRow, type WorkBoardQueueState, type WorkBoardQueueWrite } from './workBoardWorkflow';
import { DndContext, DragOverlay, MouseSensor, TouchSensor, pointerWithin, rectIntersection, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { WorkBoardProjectTabs } from './WorkBoardProjectTabs';
import { WorkBoardCardMenu } from './WorkBoardCardMenu';
import { readMobileWorkBoardLane, rememberMobileWorkBoardLane } from './workBoardMobileLane';
import { readRecentWorkBoardProjects, rememberWorkBoardProjectAccess } from './workBoardRecentProjects';
import { WorkBoardMobileProjectPicker } from './WorkBoardMobileProjectPicker';
import { removeWorkBoardProjectTab, reorderWorkBoardProjectTabs } from './workBoardProjectState';
import { requestTodoLoad, useWorkBoardSavedTodo } from './workBoardSavedTodo';

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
 * The cancel response: an error, or the removed item's payload so the prompt
 * can be put back into its session's draft. Only the text and file references
 * are restorable — a queued build captures no chips.
 */
const buildCancelResponseSchema = z.object({
  error: z.string().optional(),
  item: z.object({
    content: z.string(),
    attachments: z.array(z.object({
      filename: z.string(),
      mimeType: z.string(),
      dataUrl: z.string().optional(),
    })).optional(),
  }).optional(),
});

/**
 * The mark and the words a waiting session shows, reusing the sidebar's own
 * labels so the board and the session list name the same ask the same way.
 */
const ANSWER_PRESENTATION = {
  permission: { icon: 'shield', labelKey: 'sessions.sidebar.session.status.permissionRequired' },
  question: { icon: 'question', labelKey: 'sessions.sidebar.session.status.questionPending' },
} as const;

/**
 * The one mark a card can show before its title: live activity, or — for a
 * finished card the user has not acknowledged — the session list's green
 * completion checkbox. The two are mutually exclusive so a card never carries
 * two marks that mean different things.
 *
 * A session waiting for the user's answer outranks both: it is the only one of
 * the three the user can act on, and the turn is not working while it waits.
 */
function WorkBoardCardMark({ card, waitingFor }: { card: WorkBoardCard; waitingFor: WorkBoardWaitingKind | undefined }) {
  // An unlinked card has no session to look up; the empty id matches nothing in
  // either index. The hooks stay unconditional so render order never changes.
  const sessionId = card.sessionId ?? '';
  const activity = useSessionTurnActivity(sessionId);
  const unseenCount = useSessionUnseenCount(sessionId);
  const { t } = useI18n();
  if (waitingFor) {
    const label = t(ANSWER_PRESENTATION[waitingFor].labelKey);
    return <span className="inline-flex shrink-0 items-center text-[var(--status-warning-text)]" title={label} aria-label={label}>
      <Icon name={ANSWER_PRESENTATION[waitingFor].icon} className="size-3.5" />
    </span>;
  }
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
 * Hover detail for a Build queue card: the model the build was submitted with,
 * and the build message itself — the prompt that put the card in the queue, plus
 * any later Build prompts the server merged into the same item. A card whose
 * entry names neither renders on its own, without a tooltip.
 */
function WorkBoardQueueTooltip({ model, content, children }: {
  model: WorkBoardQueuedModel | null | undefined;
  content: string | null | undefined;
  children: React.ReactElement;
}) {
  const { t } = useI18n();
  const providers = useConfigStore(state => state.providers);
  const modelName = React.useMemo(() => {
    if (!model) return null;
    const provider = providers.find(candidate => candidate.id === model.providerID);
    return getProviderModelDisplayName(provider, model.id) || model.id;
  }, [model, providers]);
  if (!modelName && !content) return children;
  return <Tooltip>
    <TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="right" sideOffset={8} className="max-w-xs text-start">
      <div className="flex min-w-44 flex-col gap-1.5 text-start text-xs">
        {modelName && <div className="min-w-0 truncate text-muted-foreground">{t('workBoard.queuedModel', { model: modelName })}</div>}
        {content && <p className="min-w-0 line-clamp-4 whitespace-pre-wrap break-words">{content}</p>}
      </div>
    </TooltipContent>
  </Tooltip>;
}

/**
 * One waiting queue row. It is sortable so the order the user drags it into is
 * the order the queue dispatches; the buttons stay as the keyboard path.
 */
function WorkBoardQueueRowItem({ row, index, order, busy, disabled, mobile, onOpen, onMove, onTogglePause, onForce, onCancel }: {
  row: WorkBoardQueueRow;
  index: number;
  order: string[];
  busy: boolean;
  disabled: boolean;
  mobile?: boolean;
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
    <WorkBoardQueueTooltip model={row.model} content={row.content}>
      <button type="button" {...attributes} {...listeners} disabled={disabled}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-start"
        aria-label={t('workBoard.openQueued', { title: row.title })}
        onClick={() => onOpen(row.sessionId)}>
        <span className="flex size-5 shrink-0 items-center justify-center rounded bg-[var(--interactive-selection)] text-[10px] font-semibold tabular-nums text-muted-foreground">{index + 1}</span>
        <span className="min-w-0 flex-1">
          <span dir="auto" className="block truncate text-xs font-medium leading-5 hover:underline">{row.title}</span>
          {/* One line of subtitle space, reserved: a row keeps its height
              whether it shows the prompt, "Paused", or a fallback session id. */}
          <span dir="auto" className="block min-h-[1lh] truncate text-[11px] leading-5 text-muted-foreground">{row.paused ? t('workBoard.paused') : row.snippet || row.sessionId.slice(0, 9)}</span>
        </span>
      </button>
    </WorkBoardQueueTooltip>
    {/* A phone gets the same actions in a touch-sized menu. Five 24px icon
        buttons do not fit a row, and the hover reveal they rely on has no touch
        equivalent. */}
    {mobile ? <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" className="size-10 shrink-0" disabled={busy}
          aria-label={t('workBoard.laneActions')} title={t('workBoard.laneActions')}>
          <Icon name="more" className="size-5" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={busy || index === 0} onClick={() => onMove(row.itemId, -1)}>{t('workBoard.moveUp', { title: row.title })}</DropdownMenuItem>
        <DropdownMenuItem disabled={busy || index === order.length - 1} onClick={() => onMove(row.itemId, 1)}>{t('workBoard.moveDown', { title: row.title })}</DropdownMenuItem>
        <DropdownMenuItem disabled={busy} className={row.paused ? 'text-[var(--status-warning-text)]' : undefined} onClick={() => onTogglePause(row)}>{t(row.paused ? 'workBoard.resume' : 'workBoard.pause', { title: row.title })}</DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onClick={() => onForce(row)}>{t('workBoard.force', { title: row.title })}</DropdownMenuItem>
        <DropdownMenuItem disabled={busy} onClick={() => onCancel(row)}>{t('workBoard.cancelBuild', { title: row.title })}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu> : <div className={'flex shrink-0 items-center gap-0.5 transition-opacity ' + (row.paused
      // A paused row keeps its controls up so the resume control is visible
      // without hovering; every other row reveals them on hover as before.
      ? 'opacity-100 '
      : 'opacity-40 focus-within:opacity-100 group-hover:opacity-100 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100')}>
      <Button size="icon" variant="ghost" className="size-6" disabled={busy || index === 0}
        aria-label={t('workBoard.moveUp', { title: row.title })} title={t('workBoard.moveUp', { title: row.title })}
        onClick={() => onMove(row.itemId, -1)}><Icon name="arrow-up-s" className="size-3.5" /></Button>
      <Button size="icon" variant="ghost" className="size-6" disabled={busy || index === order.length - 1}
        aria-label={t('workBoard.moveDown', { title: row.title })} title={t('workBoard.moveDown', { title: row.title })}
        onClick={() => onMove(row.itemId, 1)}><Icon name="arrow-down-s" className="size-3.5" /></Button>
      <Button size="icon" variant="ghost" className={'size-6' + (row.paused ? ' text-[var(--status-warning-text)]' : '')} disabled={busy}
        aria-label={t(row.paused ? 'workBoard.resume' : 'workBoard.pause', { title: row.title })}
        title={t(row.paused ? 'workBoard.resume' : 'workBoard.pause', { title: row.title })}
        onClick={() => onTogglePause(row)}><Icon name={row.paused ? 'play' : 'pause'} className="size-3.5" /></Button>
      <Button size="icon" variant="ghost" className="size-6" disabled={busy}
        aria-label={t('workBoard.force', { title: row.title })} title={t('workBoard.force', { title: row.title })}
        onClick={() => onForce(row)}><Icon name="rocket" className="size-3.5" /></Button>
      <Button size="icon" variant="ghost" className="size-6 hover:text-[var(--status-error-text)]" disabled={busy}
        aria-label={t('workBoard.cancelBuild', { title: row.title })} title={t('workBoard.cancelBuild', { title: row.title })}
        onClick={() => onCancel(row)}><Icon name="close" className="size-3.5" /></Button>
    </div>}
  </div>;
}

/**
 * The Build queue lane. The running lease and builds started outside the queue
 * sit above the gap. Waiting items keep the queue's dispatch order and controls.
 */
function WorkBoardQueueColumn({ rows, active, activeTitle, entries, order, busy, error, dragged, mobile, waitingForOf, onOpen, onMove, onTogglePause, onForce, onCancel, onResolveForced, onNewBuild }: {
  rows: WorkBoardQueueRow[];
  active: { sessionId: string; needsReview?: boolean; startedAt: number; model?: WorkBoardQueuedModel | null; content?: string | null } | undefined;
  activeTitle: string;
  entries: WorkBoardActiveEntry[];
  order: string[];
  busy: boolean;
  error: string;
  dragged: string | null;
  mobile?: boolean;
  waitingForOf: (sessionId: string) => WorkBoardWaitingKind | undefined;
  onOpen: (sessionId: string) => void;
  onMove: (itemId: string, delta: number) => void;
  onTogglePause: (row: { itemId: string; sessionId: string; paused: boolean }) => void;
  onForce: (row: { itemId: string; sessionId: string }) => void;
  onCancel: (row: { itemId: string; sessionId: string }) => void;
  onResolveForced: (row: { itemId: string; sessionId: string }) => void;
  onNewBuild: () => void;
}) {
  const { t } = useI18n();
  return <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2 pb-3">
    {error && <p role="alert" className="mb-2 px-1 text-xs text-[var(--status-error-text)]">{error}</p>}
    {/* The running build and the builds outside the queue are peers, so they
        take the same 12px gap the waiting rows below use. */}
    {(active || entries.length > 0) && <div className="space-y-3">
      {active && <WorkBoardActiveBuild title={activeTitle} needsReview={Boolean(active.needsReview)} waitingFor={waitingForOf(active.sessionId)} model={active.model} content={active.content} onOpen={() => onOpen(active.sessionId)} />}
      {entries.map(entry => <WorkBoardActiveBuild key={entry.sessionId} title={entry.title}
        needsReview={Boolean(entry.needsReview)} checking={entry.checking} unavailable={entry.unavailable} forced={entry.forced}
        waitingFor={waitingForOf(entry.sessionId)} model={entry.model} content={entry.content}
        onOpen={() => onOpen(entry.sessionId)}
        resolve={entry.needsReview && entry.itemId ? { sessionId: entry.sessionId, itemId: entry.itemId } : undefined}
        busy={busy} onResolve={onResolveForced} />)}
    </div>}
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
          busy={busy} disabled={busy || dragged !== null} mobile={mobile} onOpen={onOpen} onMove={onMove}
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
 *
 * A build started outside the queue with an unconfirmed prompt (`resolve`) is
 * ambiguous: it may or may not have started, so it takes the error treatment and
 * carries its own recovery, rather than reading as a plain running build.
 */
function WorkBoardActiveBuild({ title, needsReview, checking = false, unavailable = false, forced = false, waitingFor, resolve, model, content, busy = false, onResolve, onOpen }: {
  title: string;
  needsReview: boolean;
  checking?: boolean;
  unavailable?: boolean;
  forced?: boolean;
  waitingFor?: WorkBoardWaitingKind;
  resolve?: { sessionId: string; itemId: string };
  model?: WorkBoardQueuedModel | null;
  content?: string | null;
  busy?: boolean;
  onResolve?: (row: { itemId: string; sessionId: string }) => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  if (resolve) {
    return <WorkBoardQueueTooltip model={model} content={content}>
      <div className="rounded-md border border-[color-mix(in_srgb,var(--status-error)_50%,transparent)] bg-[var(--status-error-background)] px-2.5 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="flex size-6 shrink-0 items-center justify-center rounded bg-[var(--status-error-background)] text-[var(--status-error-text)]"><Icon name="alert" className="size-3.5" /></span>
          <span className="min-w-0 flex-1">
            <button type="button" onClick={onOpen} dir="auto" className="block w-full truncate text-start text-xs font-semibold leading-5 hover:underline" title={title}>{title}</button>
            <span className="block truncate text-[11px] leading-5 text-muted-foreground">{t('workBoard.forcedUnconfirmed')}</span>
          </span>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => onResolve?.({ sessionId: resolve.sessionId, itemId: resolve.itemId })}>{t('buildQueue.recovery.continue')}</Button>
        </div>
      </div>
    </WorkBoardQueueTooltip>;
  }
  // The user's own answer is what the build waits for: no moving band, no
  // "Active" pill, and the ask named in place of "Building now". A review, a
  // forced build and an unread status are their own states above it.
  const waiting = !needsReview && !checking && !unavailable && !forced ? waitingFor : undefined;
  return <WorkBoardQueueTooltip model={model} content={content}>
    <button type="button" onClick={onOpen}
    className={'relative w-full overflow-hidden rounded-md border px-2.5 py-2 text-start transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring '
      + (needsReview
        ? 'border-[color-mix(in_srgb,var(--status-error)_50%,transparent)] bg-[var(--status-error-background)]'
        : forced || waiting
          ? 'border-[color-mix(in_srgb,var(--status-warning)_45%,transparent)] bg-[color-mix(in_srgb,var(--status-warning)_12%,var(--surface-elevated))] hover:bg-[color-mix(in_srgb,var(--status-warning)_18%,var(--surface-elevated))]'
          : 'border-[color-mix(in_srgb,var(--status-info)_42%,transparent)] bg-[color-mix(in_srgb,var(--status-info)_12%,var(--surface-elevated))] hover:bg-[color-mix(in_srgb,var(--status-info)_18%,var(--surface-elevated))]')}
    aria-label={checking ? t('workBoard.openSession') : t('workBoard.openBuild', { title })}>
    {!needsReview && !checking && !forced && !waiting && <span aria-hidden="true" className="oc-build-stripes pointer-events-none absolute inset-0" />}
    <span className="relative flex min-w-0 items-center gap-2">
      <span className={'flex size-6 shrink-0 items-center justify-center rounded ' + (needsReview ? 'bg-[var(--status-error-background)] text-[var(--status-error-text)]' : forced || waiting ? 'bg-[color-mix(in_srgb,var(--status-warning)_26%,transparent)] text-[var(--status-warning-text)]' : 'bg-[color-mix(in_srgb,var(--status-info)_26%,transparent)] text-[var(--status-info)]')}>
          <Icon name={needsReview ? 'alert' : forced ? 'rocket' : waiting ? ANSWER_PRESENTATION[waiting].icon : 'terminal-box'} className="size-3.5" />
      </span>
      <span className="min-w-0 flex-1">
        <span dir="auto" className="block truncate text-xs font-semibold leading-5">{title}</span>
        <span className="block truncate text-[11px] leading-5 text-muted-foreground">{t(unavailable ? 'workBoard.unknown' : checking ? 'common.loading' : needsReview ? 'workBoard.needsReview' : waiting ? ANSWER_PRESENTATION[waiting].labelKey : forced ? 'workBoard.outsideQueue' : 'workBoard.buildingNow')}</span>
      </span>
      {!needsReview && !checking && !waiting && <span className={'flex shrink-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.06em] ' + (forced ? 'text-[var(--status-warning-text)]' : 'text-[var(--status-info)]')}>
        <Spinner className="size-3 text-[var(--status-success)]" />{t('workBoard.active')}
      </span>}
      </span>
    </button>
  </WorkBoardQueueTooltip>;
}

/**
 * One lane. Everything a card lane can accept a drop, so a card dragged into an
 * empty lane still lands; the Build queue keeps its own membership and takes no
 * drops. The header holds the lane's own actions.
 */
function WorkBoardLaneColumn({ lane, droppable, count, mobile, children }: {
  lane: WorkBoardLane;
  droppable: boolean;
  count: number;
  mobile?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  const { setNodeRef, isOver } = useDroppable({ id: LANE_PREFIX + lane, disabled: !droppable });
  return <section ref={setNodeRef} data-work-board-lane={lane} data-work-board-over={isOver ? '' : undefined}
    aria-label={t(`workBoard.${lane}`)} data-count={count}
    className={'flex flex-col rounded-lg bg-surface-muted ' + (mobile ? 'min-h-0 w-full flex-1 ' : 'min-w-[240px] flex-1 ')
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
function WorkBoardCard({ card, lane, activity, waitingFor, checking, statusUnknown, needsReview, title, large, draggable, loading, error, actions, onOpenCard, onAcknowledge }: {
  card: WorkBoardCard;
  lane: WorkBoardLane;
  activity: WorkBoardActivity | undefined;
  waitingFor: WorkBoardWaitingKind | undefined;
  checking: boolean;
  statusUnknown: boolean;
  needsReview: boolean;
  title: string;
  large: boolean;
  draggable: boolean;
  loading: boolean;
  error: string;
  actions?: React.ReactNode;
  onOpenCard: () => void;
  onAcknowledge: () => void;
}) {
  const { t } = useI18n();
  // The card and the notice under it read the same inputs, so the amber
  // treatment and the notice it belongs to can never disagree.
  const feedback = useWorkBoardCardFeedback(card, activity, statusUnknown, needsReview);
  // A plan turn running now: its card carries the band and the green treatment,
  // and it is one of the two states that take the larger box. A turn waiting for
  // the user's answer is not running, however busy OpenCode reports it.
  const activePlan = lane === 'plan' && Boolean(activity?.busy) && !waitingFor;
  const waitingLabel = waitingFor ? t(ANSWER_PRESENTATION[waitingFor].labelKey) : '';
  const sortable = useSortable({ id: card.id, disabled: !draggable });
  const droppable = useDroppable({ id: card.id, disabled: !draggable });
  const setNodeRef = (node: HTMLElement | null) => { sortable.setNodeRef(node); droppable.setNodeRef(node); };
  const dragging = sortable.isDragging;
  // The whole card is the grab surface: a press that moves drags it, a press
  // and release opens it. The body is the drag handle, so the actions row keeps
  // its pointer events to itself. A brief is edited in the session's composer,
  // never here, so opening never turns the card into a form.
  const openCard = () => {
    onAcknowledge();
    if (loading || error) return;
    onOpenCard();
  };
  return <article
    ref={setNodeRef}
    {...(sortable.attributes)}
    {...(sortable.listeners ?? {})}
    aria-label={t('workBoard.dragCard', { title })}
    onClick={openCard}
    style={{ transform: CSS.Translate.toString(sortable.transform), transition: sortable.transition }}
    data-work-board-feedback={feedback ?? undefined}
    data-work-board-working={activePlan ? '' : undefined}
    data-work-board-waiting={waitingFor ?? undefined}
    data-work-board-dragging={dragging ? '' : undefined}
    className={'group relative overflow-hidden rounded-md border bg-surface-elevated cursor-grab select-none active:cursor-grabbing '
      + (dragging ? 'opacity-60 ' : '')
      + (activePlan ? '' : 'border-border ')
      + (large ? 'px-2.5 py-2 ' : 'px-2.5 py-1.5 ')}>
    {activePlan && <span aria-hidden="true" className="oc-build-stripes oc-build-stripes-plan pointer-events-none absolute inset-0" />}
    <div className="relative">
    <div className="flex min-w-0 items-center gap-1">
      <WorkBoardCardMark card={card} waitingFor={waitingFor} />
      <button type="button" className="min-w-0 flex-1 truncate text-start text-xs font-medium leading-5 hover:underline" title={title}>{title}</button>
      {actions ? <div className="flex items-center gap-1"
        onClick={event => event.stopPropagation()}
        onMouseDown={event => event.stopPropagation()}
        onTouchStart={event => event.stopPropagation()}
      >{actions}</div> : null}
    </div>
    {checking ? <p className="min-h-[1lh] text-xs leading-5 text-muted-foreground">{t('common.loading')}</p>
      : feedback ? <WorkBoardSessionFeedback feedback={feedback} />
      : waitingFor ? <p className="min-h-[1lh] text-xs leading-5 text-[var(--status-warning-text)]">{waitingLabel}</p>
      // A running plan reserves its status line even with nothing to say, so the
      // card matches the running build and the waiting rows in the queue lane.
      : activePlan ? <p aria-hidden="true" className="min-h-[1lh] text-xs leading-5" />
      : null}
    </div>
  </article>;
}

export function WorkBoardView({ mobile = false, onLeave, onAttentionCountChange, pickerOpen, onPickerOpenChange }: {
  mobile?: boolean;
  onLeave?: () => void;
  /** The shell's title badge shows this; only the phone reads it. */
  onAttentionCountChange?: (count: number) => void;
  /** The shell's title badge opens the same project picker the header draws. */
  pickerOpen?: boolean;
  onPickerOpenChange?: (open: boolean) => void;
} = {}) {
  const { t } = useI18n();
  // The phone and tablet shells show one lane at a time. The remembered lane
  // belongs to this client and the connected server, so each server reopens on
  // its own last lane.
  const [mobileLane, setMobileLane] = React.useState<WorkBoardLane>(() => readMobileWorkBoardLane(getRuntimeKey()));
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    setMobileLane(readMobileWorkBoardLane(getRuntimeKey()));
  }), []);
  const selectMobileLane = (lane: WorkBoardLane) => {
    setMobileLane(lane);
    rememberMobileWorkBoardLane(getRuntimeKey(), lane);
  };
  // The picker lists the boards this device opened first, most recent at the
  // top. Read per connected server, like the remembered lane.
  const [recentProjectIds, setRecentProjectIds] = React.useState<string[]>(() => readRecentWorkBoardProjects(getRuntimeKey()));
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    setRecentProjectIds(readRecentWorkBoardProjects(getRuntimeKey()));
  }), []);
  const projects = useProjectsStore(state => state.projects);
  const activeProjectId = useProjectsStore(state => state.activeProjectId);
  const hasServerSnapshot = useProjectsStore(state => state.hasServerSnapshot);
  const runtimeKey = getRuntimeKey();
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
  // Opening or switching a board on a phone is what makes the picker's list
  // recent-first; the read back keeps the list in step with what was just stored.
  React.useEffect(() => {
    if (!mobile || !projectId) return;
    rememberWorkBoardProjectAccess(runtimeKey, projectId);
    setRecentProjectIds(readRecentWorkBoardProjects(runtimeKey));
  }, [mobile, projectId, runtimeKey]);
  const directory = projects.find(project => project.id === projectId)?.path ?? '';
  const sessionDays = useUIStore(state => state.workBoardSessionDays);
  // Remember which board the user is on so any chat can return to it, and so a
  // New to-do draft is rooted in this project rather than the sidebar's.
  React.useEffect(() => {
    if (!projectId) return;
    if (useUIStore.getState().workBoardProjectId === projectId) return;
    useUIStore.getState().setWorkBoardProjectId(projectId);
  }, [projectId]);
  // The board is a server-owned projection: the client renders the lanes, order,
  // queue state and live activity the server derived, and never classifies
  // history or polls a five-second timer itself.
  const { snapshot, error: snapshotError, refresh } = useWorkBoardSnapshot(directory, sessionDays);
  const [error, setError] = React.useState('');
  const [actionError, setActionError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const agents = useConfigStore(state => state.agents);
  const sessions = useGlobalSessionsStore(state => state.activeSessions);
  const sessionsError = useGlobalSessionsStore(state => state.status === 'error');
  // The store seeds from localStorage and only then loads pages, so `status`
  // still reports idle/loading while the sidebar list fills in. Session-derived
  // board cards arrive with it, and a lane that will fill should say so rather
  // than claim to be empty and then gain cards.
  const sessionsLoading = useGlobalSessionsStore(state => !state.hasLoaded && state.status !== 'error');
  const [queueBusy, setQueueBusy] = React.useState(false);
  const [queueActionError, setQueueActionError] = React.useState('');
  const [resolveConfirm, setResolveConfirm] = React.useState<{ action: 'skip' | 'retry'; issue: string } | null>(null);
  const [forceConfirm, setForceConfirm] = React.useState<{ itemId: string; sessionId: string; title: string } | null>(null);
  const [drag, setDrag] = React.useState<WorkBoardDrag | null>(null);
  // Search hides cards, it never unsaves them: a card the query does not match
  // keeps its lane, its order and its actions, and returns when the query is
  // cleared. The query lives in this component only, so it is gone on reopen.
  const [search, setSearch] = React.useState('');
  const query = search.trim().toLowerCase();
  // The queue enablement toggle is optimistic: flipping it writes the setting and
  // shows the new state at once, and a failed write puts the old state back.
  const [queueEnabled, setQueueEnabled] = React.useState<boolean | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );
  const generation = React.useRef(0);
  const cards = React.useMemo<WorkBoardSnapshotCard[]>(() => snapshot?.cards ?? [], [snapshot]);
  const loading = snapshot === null && !snapshotError;
  React.useEffect(() => { setError(snapshotError ?? ''); }, [snapshotError]);
  // A saved to-do from the composer arrives as a card; the next snapshot carries
  // it, so the effect only nudges a refresh rather than merging cards by hand.
  React.useEffect(() => useWorkBoardSavedTodo.subscribe((state, previousState) => {
    const latestSave = state.latestSave;
    if (latestSave === previousState.latestSave) return;
    if (latestSave?.runtimeKey !== runtimeKey || latestSave.card.directory !== directory) return;
    void refresh();
  }), [directory, runtimeKey, refresh]);
  // A project or runtime switch clears whatever the last board was doing, so an
  // in-flight action's error cannot land on the next board.
  React.useLayoutEffect(() => {
    generation.current += 1;
    setActionError('');
  }, [directory, runtimeKey]);
  React.useEffect(() => subscribeRuntimeEndpointChanged(() => {
    generation.current += 1;
    useUIStore.getState().setWorkBoardOpen(false);
  }), []);
  // The projection's own enablement is authoritative once it arrives; before
  // that, the local optimistic value stands.
  React.useEffect(() => {
    if (snapshot?.queue.enabled !== null && snapshot?.queue.enabled !== undefined) setQueueEnabled(snapshot.queue.enabled);
  }, [snapshot]);

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
    // The mobile shell draws the board over the chat, so opening a session has
    // to dismiss the board for the session to show.
    onLeave?.();
  };
  // A card opens into its session, never into a form on the board. A saved
  // To-do brief is the session's draft, so it is put there for the user to edit
  // and is written back to the same card. A card with no session has no chat to
  // open, so it opens an unsaved draft rooted in the board's project, which the
  // save turns back into the card and the board.
  const openCardFor = (card: WorkBoardSnapshotCard) => {
    if (card.sessionId) {
      open(card.sessionId, card.directory);
      if (card.stage === 'todo' && !card.briefRemoved) requestTodoLoad(card);
      return;
    }
    useSessionUIStore.getState().openNewSessionDraft({
      selectedProjectId: projectId, target: 'project', directoryOverride: directory,
      origin: 'workBoard',
    });
    requestTodoLoad(card);
    useUIStore.getState().closeMainSurfaces();
    onLeave?.();
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

  // The queue column shows one project's work. Membership and order come from
  // the server projection, never from card order, so a queued build the board has
  // no card for still appears, and a move sends the queue's own order. The queue
  // section is unavailable only when its own read failed, which is not the same
  // as an empty queue.
  const queue = snapshot?.queue ?? null;
  const queueError = snapshot ? (queue?.known ? '' : t('workBoard.unknown')) : '';
  // Tab badges need every open project's queue at once, which the per-project
  // board snapshot does not carry; the global queue snapshot stays for them.
  const { snapshot: globalQueue, error: globalQueueError } = useBuildQueueSnapshot();
  const buildBadges = React.useMemo(
    () => workBoardBuildBadges(visibleProjectTabs, globalQueue, Boolean(globalQueueError)),
    [visibleProjectTabs, globalQueue, globalQueueError],
  );
  // The cross-directory index is the one place a session's pending asks are
  // known for a project this board never opened; the board's own snapshot only
  // covers the active project. A form or a page waiting for its answer is a
  // question, and a permission is its own ask, so the two travel separately.
  const blockingBySession = useGlobalBlockingRequestsStore(state => state.bySession);
  const tabAsks = React.useMemo(
    () => workBoardTabAsks(visibleProjectTabs, [...blockingBySession.values()].map(pending => ({
      directory: pending.directory,
      question: pending.forms.length > 0 || pending.pages.length > 0,
      permission: pending.permissions.length > 0,
    }))),
    [visibleProjectTabs, blockingBySession],
  );
  // How many open boards are waiting on the user — the number the phone's
  // title badge shows and the count it opens the picker with.
  const attentionCount = React.useMemo(
    () => workBoardsNeedingAttention(visibleProjectTabs.map(project => project.id), buildBadges, tabAsks),
    [visibleProjectTabs, buildBadges, tabAsks],
  );
  React.useEffect(() => onAttentionCountChange?.(attentionCount), [attentionCount, onAttentionCountChange]);
  const activeBuild = queue?.active ?? undefined;
  const snapshotTitles = snapshot?.sessionTitles;
  const sessionTitleFor = React.useCallback(
    (sessionId: string) => sessions.find(session => session.id === sessionId)?.title
      || snapshotTitles?.[sessionId]
      || t('workBoard.sessionFallback', { id: sessionId.slice(0, 9) }),
    [sessions, snapshotTitles, t],
  );
  // The title a card shows: its own brief, or the linked session's name once the
  // brief was removed, which is what the card renders and what search matches.
  const cardTitleFor = (card: WorkBoardSnapshotCard) => card.briefRemoved && card.sessionId
    ? sessionTitleFor(card.sessionId)
    : workBoardCardTitle(card.text, card.attachments);
  const queueRows = React.useMemo(() => workBoardSnapshotRows(snapshot, sessionTitleFor), [snapshot, sessionTitleFor]);
  const queueOrder = React.useMemo(() => queue?.order ?? [], [queue]);
  // Forced builds have no lease and no queue row; the server names them, and
  // their titles come from the same session list the rows use. A forced build
  // whose prompt may not have started carries needsReview and its item, so the
  // board can offer its recovery instead of showing it as a plain running build.
  const forcedBuilds = React.useMemo(
    () => (queue?.forced ?? []).map(item => ({
      sessionId: item.sessionId, title: sessionTitleFor(item.sessionId),
      needsReview: item.needsReview, itemId: item.itemId, model: item.model, content: item.content,
    })),
    [queue, sessionTitleFor],
  );
  // The active project's own paused state, if any. A review-frozen lease needs
  // the user to look at that session; a Git hold only needs the tree cleaned or
  // the policy changed. The two carry different actions below.
  const queueIssue = queue?.issue ?? undefined;
  const needsReview = Boolean(activeBuild?.needsReview);
  // A review-frozen lane whose session is running again is continued by adopting
  // that live turn, not by releasing into a void. The board only knows what it
  // sees, so this is a wording hint: the server decides.
  const reviewSessionBusy = React.useMemo(() => {
    const sessionId = activeBuild?.sessionId;
    if (!sessionId) return false;
    const card = cards.find(entry => entry.sessionId === sessionId);
    return card ? Boolean(snapshot?.activities[sessionId]?.busy) : false;
  }, [activeBuild?.sessionId, cards, snapshot]);
  const reviewConfirmWording = workBoardReviewConfirmWording(resolveConfirm?.action, reviewSessionBusy);

  const queueStateFor = (card: WorkBoardCard): WorkBoardQueueState | undefined => workBoardQueueFromSnapshot(snapshot, card);
  const laneFor = (card: WorkBoardCard): WorkBoardLane => workBoardCardLane(snapshot, card);
  // The ask a queue row's session waits on. The queue column shows sessions the
  // board has no card for, so its rows read the projection's own map.
  const waitingForOf = React.useCallback(
    (sessionId: string): WorkBoardWaitingKind | undefined => snapshot?.waitingFor[sessionId],
    [snapshot],
  );

  /**
   * Every lane's cards, in the order the board shows them. The server already
   * ordered each lane (stored placement order, then Done by newest completion),
   * so the client only follows the projection's own order and falls back to the
   * card list order for anything it does not name.
   */
  const orderedLanes = React.useMemo(() => {
    const byId = new Map(cards.map(card => [card.id, card]));
    const ordered = new Map<WorkBoardLane, WorkBoardSnapshotCard[]>();
    for (const lane of lanes) {
      const inLane = workBoardSnapshotOrder(snapshot, lane, cards).flatMap(id => {
        const card = byId.get(id);
        return card ? [card] : [];
      });
      ordered.set(lane, inLane);
    }
    return ordered;
  }, [cards, snapshot]);

  /**
   * The lanes the search leaves on screen: every card lane keeps the cards whose
   * title contains the query. The Build queue keeps its own rows: it shows what
   * the project is building now, so hiding a running build or a waiting row the
   * query does not name would misstate the queue.
   */
  const shownLanes = !query ? orderedLanes : new Map<WorkBoardLane, WorkBoardSnapshotCard[]>(
    [...orderedLanes].map(([lane, inLane]) => [lane,
      lane === 'queue' ? inLane : inLane.filter(card => cardTitleFor(card).toLowerCase().includes(query))]),
  );

  // A lease awaiting review is unfinished work the server will not release on
  // its own; completing its card would hide that resolution. Manual Done stays
  // out of reach for it.
  //
  // The server decides what each card can do; the board only reads it.
  const canDo = (card: WorkBoardSnapshotCard, action: WorkBoardSnapshotCard['availableActions'][number]) =>
    !loading && !error && card.availableActions.includes(action);
  const canComplete = (card: WorkBoardSnapshotCard) => canDo(card, 'complete');
  // Every lane's own card moves into Done together, from its own menu. Done has
  // no such action: its cards are already there.
  const completeAllIn = (lane: WorkBoardLane) => {
    // The cards the column shows, so a search narrows this action with it.
    const inLane = shownLanes.get(lane) ?? [];
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
    onLeave?.();
  };

  // One queue request, without the busy flag or the refresh, so a bulk action
  // can fan several of them out over a single refresh.
  const queueRequest = async (url: string, method: 'PUT' | 'DELETE' | 'POST', body?: WorkBoardQueueWrite) => {
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
  };
  // Queue rows act on the queue itself. The board is a second surface on the
  // same server state, so every one of these refreshes the snapshot rather than
  // guessing the result.
  const queueMutate = async (url: string, method: 'PUT' | 'DELETE' | 'POST', body?: WorkBoardQueueWrite) => {
    setQueueBusy(true);
    setQueueActionError('');
    try {
      await queueRequest(url, method, body);
      await refresh();
    } catch (cause) {
      setQueueActionError(cause instanceof Error ? cause.message : t('workBoard.failed'));
    } finally {
      setQueueBusy(false);
    }
  };
  // The project's queue enablement. The toggle is its own setting on the same
  // server route; flipping it writes the setting, and a failed write restores the
  // previous value so the switch never lies about what is stored.
  const toggleQueueEnabled = (next: boolean) => {
    if (!directory) return;
    const previous = queueEnabled;
    setQueueEnabled(next);
    setQueueActionError('');
    void updateQueueSettings(directory, next)
      .then(stored => { setQueueEnabled(stored); return refresh(); })
      .catch(cause => {
        setQueueEnabled(previous);
        setQueueActionError(cause instanceof Error ? cause.message : t('workBoard.failed'));
      });
  };
  // The board's settings are the project's own, so this opens this board's
  // project page on its Work board section, where the per-project overrides
  // live. Closing the board first keeps the two full-window surfaces from
  // stacking.
  const openBoardSettings = () => {
    useUIStore.getState().setWorkBoardOpen(false);
    useUIStore.getState().setSettingsProjectsSelectedId(projectId);
    useUIStore.getState().requestSettingsJump('projects', 'projects.work-board');
    useUIStore.getState().setSettingsDialogOpen(true);
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
  const queuePauseUrl = (row: { itemId: string; sessionId: string }) =>
    '/api/build-queue/sessions/' + encodeURIComponent(row.sessionId) +
    '/items/' + encodeURIComponent(row.itemId) + '/pause';
  const toggleQueuedPause = (row: { itemId: string; sessionId: string; paused: boolean }) =>
    void queueMutate(queuePauseUrl(row), 'PUT', { paused: !row.paused });
  // The server has no whole-queue pause, so this is the rows' own pause state
  // fanned out over one refresh: a resume-all also clears items the user paused
  // one at a time, and a build queued after a pause-all still dispatches.
  const allQueuedPaused = queueRows.length > 0 && queueRows.every(row => row.paused);
  const toggleAllQueuedPause = async () => {
    const paused = !allQueuedPaused;
    const targets = queueRows.filter(row => row.paused !== paused);
    if (!targets.length) return;
    setQueueBusy(true);
    setQueueActionError('');
    try {
      await Promise.all(targets.map(row => queueRequest(queuePauseUrl(row), 'PUT', { paused })));
      await refresh();
    } catch (cause) {
      setQueueActionError(cause instanceof Error ? cause.message : t('workBoard.failed'));
    } finally {
      setQueueBusy(false);
    }
  };
  const adoptCancelledBuild = (
    sessionId: string,
    item: { content: string; attachments?: Array<{ filename: string; mimeType: string; dataUrl?: string }> },
  ) => {
    // The session's own directory, not the board's: a worktree keeps its own
    // queue and its own drafts.
    const sessionDirectory = useSessionUIStore.getState().getDirectoryForSession(sessionId) ?? directory;
    const target = sessionDirectory ? createChatDraftIdentity(getRuntimeKey(), sessionDirectory, sessionId) : null;
    if (!target) return;
    const files = (item.attachments ?? []).flatMap((attachment) => attachment.dataUrl
      ? [{ url: attachment.dataUrl, mimeType: attachment.mimeType, filename: attachment.filename }]
      : []);
    useInputStore.getState().adoptPrompt(target, { text: item.content, files });
    toast.info(t('workBoard.cancelBuildKeptDraft'));
  };
  // Cancelling a build hands its prompt back to the draft of the session that
  // held it, so the text the user typed is never lost. It appends, after
  // whatever that session's draft already holds.
  const cancelBuild = async (row: { itemId: string; sessionId: string }) => {
    setQueueBusy(true);
    setQueueActionError('');
    try {
      const response = await runtimeFetch('/api/build-queue/sessions/' + encodeURIComponent(row.sessionId) +
        '/items/' + encodeURIComponent(row.itemId), { method: 'DELETE' });
      const payload = buildCancelResponseSchema.safeParse(await response.json().catch(() => null));
      if (!response.ok) throw new Error((payload.success && payload.data.error) || `HTTP ${response.status}`);
      const item = payload.success ? payload.data.item : undefined;
      if (item) adoptCancelledBuild(row.sessionId, item);
      await refresh();
    } catch (cause) {
      setQueueActionError(cause instanceof Error ? cause.message : t('workBoard.failed'));
    } finally {
      setQueueBusy(false);
    }
  };
  const cancelQueued = (row: { itemId: string; sessionId: string }) => void cancelBuild(row);
  // Continue drops the frozen item and releases the lane, so it confirms first:
  // a mis-click on a header control must not silently discard queued work. The
  // itemId pins the confirmation to the lease the user was looking at.
  const confirmResolve = () => {
    if (!resolveConfirm || !directory) return;
    const body: WorkBoardQueueWrite = resolveConfirm.action === 'skip'
      ? { directory, itemId: activeBuild?.itemId ?? undefined, action: 'skip' }
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
  // A forced build whose prompt was not confirmed is resolved like a parked
  // lease: acknowledge it and release the lane. The item it targeted pins the
  // request to the build the user is looking at.
  const resolveForcedBuild = (row: { itemId: string; sessionId: string }) =>
    void queueMutate('/api/build-queue/resolve', 'POST', { directory, itemId: row.itemId, action: 'skip' });

  /**
   * Move one card to a lane, or to a place inside one. The board write and the
   * session-work write are separate steps on purpose: the card is placed even
   * when the session cannot be reached, and a failed session write is reported
   * on its own rather than rolled back.
   */
  const place = (cards: WorkBoardCard[], lane: WorkBoardCardLane, before: string | null) => void mutate(async () => {
    if (!cards.length) return;
    // The server stamps the placement with its own clock; each card carries its
    // version so a concurrent change elsewhere is a reported conflict.
    const targets = cards.map(card => ({
      id: card.id, updatedAt: card.updatedAt, text: card.text, sessionId: card.sessionId,
    }));
    const result: { placed: WorkBoardCard[]; failed: { id: string; error: string }[] } = cards.length === 1
      ? { placed: [await placeWorkBoardCard(cards[0], lane, before)], failed: [] }
      : await placeWorkBoardCards(directory, lane, targets);
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
    const card = cards.find(candidate => candidate.id === id);
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
      const card = cards.find(candidate => candidate.id === held.id);
      if (card) place([card], target, null);
      return;
    }
    if (held.type === 'queue') {
      if (overId.startsWith(LANE_PREFIX)) return;
      reorderQueued(held.id, overId === held.id ? null : overId);
      return;
    }
    const card = cards.find(candidate => candidate.id === held.id);
    if (!card) return;
    const overCard = cards.find(candidate => candidate.id === overId);
    const overLane = overCard ? laneFor(overCard) : undefined;
    // A drag never moves a card into or out of the queue: the queue lane is not a
    // drop target, so a card whose lane is queue is not draggable and an over
    // card in the queue falls back to the dragged card's own lane.
    const targetLane: WorkBoardCardLane = overLane === undefined || overLane === 'queue' ? held.lane : overLane;
    const current = laneCards(targetLane);
    const before = overId === held.id || overId.startsWith(LANE_PREFIX) ? null
      : targetLane === held.lane
        ? workBoardOrderNeighbour(workBoardMoved(current, held.id, current.indexOf(overId)), held.id)
        : overId;
    place([card], targetLane, before);
  };
  const laneCards = (lane: WorkBoardLane) => (orderedLanes.get(lane) ?? []).map(card => card.id);
  // The queue's live builds feed the queue column and the lane tabs, and the
  // mobile tabs show the same number as the lane they open, so both read one
  // count. The queue snapshot owns managed rows; a live build without a queue
  // entry must also render, once per session, with no queue mutations.
  const queueLiveBuilds = new Map<string, { sessionId: string; title: string; checking: boolean; unavailable: boolean }>();
  for (const card of orderedLanes.get('queue') ?? []) {
    if (card.sessionId && !queueStateFor(card)) {
      queueLiveBuilds.set(card.sessionId, {
        sessionId: card.sessionId,
        title: sessionTitleFor(card.sessionId),
        checking: card.status !== 'known',
        unavailable: card.status === 'unavailable',
      });
    }
  }
  const queueActiveEntries = workBoardActiveEntries(forcedBuilds, [...queueLiveBuilds.values()]);
  const laneCounts = new Map<WorkBoardLane, number>(lanes.map(lane => [lane,
    lane === 'queue'
      ? queueRows.length + (activeBuild ? 1 : 0) + queueActiveEntries.length
      : (shownLanes.get(lane) ?? []).length]));
  const visibleLanes = mobile ? lanes.filter(lane => lane === mobileLane) : lanes;

  return <div className={mobile ? 'flex h-full min-h-0 flex-col bg-background' : 'absolute inset-0 z-10 flex flex-col bg-background'} aria-label={t('workBoard.title')}>
    {/* items-end + pt-3-only puts the project tabs on the header's lower edge, so
        a selected tab can flow into the board; the title and controls carry their
        own bottom padding and stay vertically centred. The header owns a surface
        because the selected tab is filled with the board's colour — against the
        bare board background the connection would read as an outline.
        A phone has no room for a tab strip and five lanes at once, so the tabs
        become a lane picker whose counts show where the work is. The fullscreen
        surface already carries the board's title and its close. */}
    <header className={mobile
      ? 'flex shrink-0 flex-col gap-3 border-b border-border bg-surface-muted px-3 py-3'
      : 'relative flex flex-wrap items-end gap-3 bg-surface-muted px-4 pt-3'}>
      {/* The strip's separator is drawn behind the tabs rather than as the
          header's own border, so a selected tab's fill paints over it and the
          line breaks under that tab alone. The strip is lifted above it. */}
      {!mobile && <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-px bg-border" />}
      {!mobile && <h1 className="pb-3 text-lg font-semibold">{t('workBoard.title')}</h1>}
      {mobile ? <>
        <WorkBoardMobileProjectPicker
          projects={projects}
          activeProjectId={projectId}
          recentProjectIds={recentProjectIds}
          badges={buildBadges}
          asks={tabAsks}
          open={pickerOpen}
          onOpenChange={onPickerOpenChange}
          onSelect={addProjectTab}
        />
        {/* The queue switch stays on the board. It is the same server setting the
            desktop header shows, and it decides whether a Build prompt from this
            phone joins the queue. */}
        <div className="flex min-h-11 items-center justify-between rounded-md border border-border bg-background px-3">
          <span className="text-sm text-foreground">{t('workBoard.queueEnabledLabel')}</span>
          <Switch aria-label={t('workBoard.queueEnabledLabel')} checked={queueEnabled === true}
            disabled={!directory || busy} onCheckedChange={toggleQueueEnabled} />
        </div>
        <div role="tablist" aria-label={t('workBoard.title')} className="grid grid-cols-5 gap-1">
          {lanes.map(lane => <button type="button" key={lane} role="tab" aria-selected={mobileLane === lane}
            onClick={() => selectMobileLane(lane)}
            className={'flex min-h-12 flex-col items-center justify-center rounded-md border px-1 py-1 text-xs '
              + (mobileLane === lane ? 'border-[var(--interactive-selection)] bg-background font-semibold text-foreground' : 'border-transparent text-muted-foreground')}>
            <span>{t(`workBoard.${lane}`)}</span><span className="tabular-nums">{laneCounts.get(lane) ?? 0}</span>
          </button>)}
        </div>
      </> : <WorkBoardProjectTabs
        projects={projects}
        openProjectIds={visibleProjectTabs.map(project => project.id)}
        activeProjectId={projectId}
        disabled={busy}
        badges={buildBadges}
        asks={tabAsks}
        onSelect={nextProjectId => setWorkBoardProjectTabs(runtimeKey, {
          projectIds: visibleProjectTabs.map(project => project.id),
          activeProjectId: nextProjectId,
        })}
        onAdd={addProjectTab}
        onClose={closeProjectTab}
        onReorder={reorderProjectTab}
      />}
      {/* The board's own controls sit in one right-aligned cluster: the search
          field, the project queue's on/off switch, the way into its Settings
          page, and Close. The header keeps items-end so a selected project tab
          still flows into the board; the cluster centres its own children
          against that baseline. Mobile drops the cluster. The fullscreen surface
          closes itself, the queue switch sits in the picker above, board
          Settings is reachable from the mobile Settings list, and the search
          field goes with it: a phone shows one lane at a time. */}
      {!mobile && <div className="mb-2 ms-auto flex items-center gap-2">
        <div role="search" className="relative">
          <Icon name="search" className="pointer-events-none absolute inset-s-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input inputSize="compact" value={search} className="w-48 ps-7"
            placeholder={t('workBoard.search')} aria-label={t('workBoard.search')}
            onChange={event => setSearch(event.target.value)}
            // Escape clears the query, so the board comes back without hunting
            // for a clear control, and never leaves the field mid-composition.
            onKeyDown={event => {
              if (event.key === 'Escape' && !event.nativeEvent.isComposing) { event.preventDefault(); setSearch(''); }
            }} />
        </div>
        <div className="flex items-center gap-2 rounded-md border border-border px-2.5 py-1">
          <span className="text-xs font-medium">{t(queueEnabled ? 'workBoard.queueOn' : 'workBoard.queueOff')}</span>
          <Switch aria-label={t('workBoard.queueEnabledLabel')} checked={queueEnabled === true}
            disabled={!directory || busy} onCheckedChange={toggleQueueEnabled} />
        </div>
        <Button size="icon" variant="ghost" aria-label={t('workBoard.settings')} title={t('workBoard.settings')}
          onClick={() => openBoardSettings()}>
          <Icon name="settings-3" className="size-4" />
        </Button>
        <Button size="icon" variant="ghost" onClick={() => useUIStore.getState().setWorkBoardOpen(false)} aria-label={t('workBoard.cancel')} title={t('workBoard.cancel')}>
          <Icon name="close" className="size-4" />
        </Button>
      </div>}
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
    <div className={mobile ? 'flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-3' : 'flex min-h-0 flex-1 gap-3 overflow-x-auto p-4'}>
      {visibleLanes.map(lane => {
        const inLane = shownLanes.get(lane) ?? [];
        const activeEntries = lane === 'queue' ? queueActiveEntries : [];
        const count = laneCounts.get(lane) ?? inLane.length;
        return <WorkBoardLaneColumn key={lane} lane={lane} droppable={lane !== 'queue'} count={count} mobile={mobile}>
          <div className="flex items-center gap-2 px-3 py-3">
            <h2 className="flex flex-1 items-center gap-2 text-sm font-semibold">{t(`workBoard.${lane}`)}<span className="text-muted-foreground">{count}</span></h2>
            {(lane === 'todo' || lane === 'plan') && <Button size="sm" variant="ghost" disabled={!directory || busy || (lane === 'plan' && !agents.some(agent => agent.name === 'plan'))} onClick={() => newCard(lane)} aria-label={t(lane === 'todo' ? 'workBoard.newTodo' : 'workBoard.newPlan')} title={t(lane === 'todo' ? 'workBoard.newTodo' : 'workBoard.newPlan')}><Icon name="add" className="size-4" /></Button>}
            {/* Pauses or resumes every waiting build at once. It only appears
                with rows to act on, and lights up once the whole queue waits. */}
            {lane === 'queue' && queueRows.length > 0 && <Button size="sm" variant="ghost"
              disabled={!directory || busy || queueBusy}
              className={allQueuedPaused ? 'text-[var(--status-warning-text)]' : undefined}
              onClick={() => void toggleAllQueuedPause()}
              aria-label={t(allQueuedPaused ? 'workBoard.resumeAll' : 'workBoard.pauseAll')}
              title={t(allQueuedPaused ? 'workBoard.resumeAll' : 'workBoard.pauseAll')}>
              <Icon name={allQueuedPaused ? 'play' : 'pause'} className="size-4" />
            </Button>}
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
            mobile={mobile}
            waitingForOf={waitingForOf}
            onOpen={sessionId => open(sessionId, directory)}
            onMove={moveQueued}
            onTogglePause={toggleQueuedPause}
            onForce={forceQueued}
            onCancel={cancelQueued}
            onResolveForced={resolveForcedBuild}
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
              const activity = card.sessionId ? snapshot?.activities[card.sessionId] : undefined;
              const waitingFor = card.sessionId ? snapshot?.waitingFor[card.sessionId] : undefined;
              const checking = Boolean(card.sessionId) && card.status === 'unknown';
              const statusUnknown = Boolean(card.sessionId) && card.status !== 'known';
              const hasRunningTurn = Boolean(activity?.busy);
              const canReturnToTodo = canDo(card, 'returnToTodo');
              const canRemove = canDo(card, 'remove');
              const title = cardTitleFor(card);
              // A card is one of two sizes. Every card that can carry a status
              // line — a working plan, or any card linked to a session, which
              // can gain "Needs attention" or a loading line — takes the larger
              // box. A working plan reserves its status line, even empty, so it
              // is the same height as the running build and the waiting rows.
              // A card with nothing to report, and an unstarted To-do with no
              // session to report on, stays compact.
              const large = (lane === 'plan' && hasRunningTurn) || lane !== 'todo' || Boolean(card.sessionId);
              return <WorkBoardCard
                key={card.id}
                card={card}
                lane={lane}
                activity={activity}
                waitingFor={waitingFor}
                checking={checking}
                statusUnknown={statusUnknown}
                needsReview={Boolean(queueStateFor(card)?.needsReview)}
                title={title}
                large={large}
                draggable={!loading && !error && !busy}
                loading={loading}
                error={error}
                onOpenCard={() => openCardFor(card)}
                onAcknowledge={() => acknowledge(card)}
                actions={<>
                  {/* A session-less To-do card can start planning from the card
                      itself, instead of only from the hover-only menu. */}
                  {!card.sessionId && <button type="button"
                    disabled={busy || loading || Boolean(error)}
                    aria-label={t('workBoard.startPlan')}
                    title={t('workBoard.startPlan')}
                    onClick={() => promote(card)}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-40 transition-opacity hover:text-foreground hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    <Icon name="rocket" className="size-3.5" />
                  </button>}
                  {canComplete(card) && <button type="button"
                    disabled={busy || loading || Boolean(error)}
                    aria-label={t('workBoard.moveToDone', { title })}
                    title={t('workBoard.moveToDone', { title })}
                    onClick={() => place([card], 'done', null)}
                    className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-40 transition-opacity hover:text-[var(--status-success-text)] hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
                    <Icon name="check" className="size-3.5" />
                  </button>}
                  <WorkBoardCardMenu
                    sessionId={card.sessionId ?? null}
                    directory={card.directory}
                    title={title}
                    disabled={busy || loading || Boolean(error)}
                    onStartPlan={card.sessionId ? null : () => promote(card)}
                    onReturnToTodo={canReturnToTodo ? () => void mutate(async () => {
                      const actualDirectory = sessions.find(session => session.id === card.sessionId)?.directory ?? card.directory;
                      await saveSessionToTodo(card.sessionId!, card.directory, actualDirectory, card.text, []);
                    }) : null}
                    onRemove={canRemove ? () => void mutate(async () => {
                      await deleteWorkBoardCard(card.id);
                    }) : null}
                    onRemoveTodo={card.stage === 'todo' && !card.briefRemoved ? () => void mutate(async () => {
                      await updateWorkBoardCard(card.id, { removeBrief: true, expectedUpdatedAt: card.updatedAt });
                    }) : null}
                  />
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
