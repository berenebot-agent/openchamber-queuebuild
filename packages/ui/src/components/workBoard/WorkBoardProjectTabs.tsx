import React from 'react';
import {
  DndContext,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type Modifier,
} from '@dnd-kit/core';
import {
  SortableContext,
  horizontalListSortingStrategy,
  rectSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import type { ProjectEntry } from '@/lib/api/types';
import { projectLabel } from './workBoardProjectState';
import type { WorkBoardBuildBadge, WorkBoardTabAsks } from './workBoardWorkflow';

type WorkBoardProjectTabsProps = {
  projects: ProjectEntry[];
  openProjectIds: string[];
  activeProjectId: string;
  disabled: boolean;
  /**
   * Each open project's build queue, keyed by project id. A tab with no entry
   * has nothing building: the badge is the presence of queue work, so its
   * absence is meaningful and must not be filled with a zero.
   */
  badges: Map<string, WorkBoardBuildBadge>;
  /**
   * Each open project's pending asks, keyed by project id, on the same terms:
   * a tab with no entry has nothing waiting for the user.
   */
  asks: Map<string, WorkBoardTabAsks>;
  onSelect: (projectId: string) => void;
  onAdd: (projectId: string) => void;
  onClose: (projectId: string) => void;
  /** A tab was dropped on another: the two ids' new order, left to right. */
  onReorder: (activeProjectId: string, overProjectId: string) => void;
};

// A lifted tab keeps its own height and follows the row; letting it drift to the
// header's other controls would only suggest a drop target that is not one.
const restrictToXAxis: Modifier = ({ transform }) => ({
  ...transform,
  y: 0,
});

/**
 * A project's build queue at a glance: a blue spinner carrying the number of
 * builds in flight or waiting, an amber exclamation when the queue state could
 * not be read, or a warning mark when the queue was read and is waiting for the
 * user. The mark sits outside the tab button, so a disabled tab during another
 * write still shows what the queue is doing. Motion follows the appearance
 * setting, like every other activity indicator.
 */
function WorkBoardTabBuildBadge({ badge, label }: { badge: WorkBoardBuildBadge; label: string }) {
  const { t } = useI18n();
  const animated = useSessionDisplayStore(state => state.animatedActivityIndicators);
  const title = badge.error
    ? t('workBoard.headerQueueError', { project: label })
    : badge.paused === 'git'
      ? t('workBoard.headerPausedGit', { project: label })
      : badge.paused === 'review'
        ? t('workBoard.headerPausedReview', { project: label })
        : t('workBoard.headerBuilds', { project: label, count: badge.count });
  if (badge.error) {
    return <span
      className="me-1 inline-flex shrink-0 items-center justify-center"
      aria-label={title} title={title} data-work-board-build="error"
    >
      <Icon name="error-warning" className="size-3.5 text-status-warning" />
    </span>;
  }
  if (badge.paused) {
    return <span
      className="me-1 inline-flex shrink-0 items-center justify-center"
      aria-label={title} title={title} data-work-board-build={'paused-' + badge.paused}
    >
      <Icon name="alert" className="size-3.5 text-status-warning" />
    </span>;
  }
  return <span
    className="me-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--status-info)_16%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums text-status-info"
    aria-label={title} title={title} data-work-board-build="running"
  >
    {animated ? <Spinner className="size-3" /> : <Icon name="loader-4" className="size-3" />}
    {badge.count}
  </span>;
}

/**
 * A project's own ask at a glance: a question or a permission waiting for the
 * user. The mark and the label are the sidebar's, so the board and the session
 * list name the same ask the same way. Both are the user's to answer, so both
 * take the same warning treatment the board's cards use.
 */
function WorkBoardTabAskBadge({ kind }: { kind: 'question' | 'permission' }) {
  const { t } = useI18n();
  const title = t(kind === 'question'
    ? 'sessions.sidebar.session.status.questionPending'
    : 'sessions.sidebar.session.status.permissionRequired');
  return <span
    className="me-1 inline-flex shrink-0 items-center justify-center text-[var(--status-warning-text)]"
    aria-label={title} title={title} data-work-board-ask={kind}
  >
    <Icon name={kind === 'question' ? 'question' : 'shield'} className="size-3.5" />
  </span>;
}

type WorkBoardProjectTabProps = {
  project: ProjectEntry;
  selected: boolean;
  disabled: boolean;
  badge: WorkBoardBuildBadge | undefined;
  asks: WorkBoardTabAsks | undefined;
  onSelect: (projectId: string) => void;
  onClose: (projectId: string) => void;
};

// How far the selected tab's base flares out into the header. Kept just wider
// than the strip's own gap, so a flare reaches the neighbouring tab's edge
// rather than a clear space beside it.
const FILLET_PX = 5;

/**
 * One connected project tab: a rounded rectangle whose top corners curve away
 * from the board header and whose base reaches the header's lower edge. The
 * selected tab is filled with the board's own surface, so the line drawn behind
 * the strip breaks under it and the tab reads as continuous with the board
 * below rather than as a separate chip. Its base flares outward through two
 * concave fillets, so the surface curves into the board on either side instead
 * of meeting the line at a right angle.
 */
function WorkBoardProjectTab({
  project,
  selected,
  disabled,
  badge,
  asks,
  onSelect,
  onClose,
}: WorkBoardProjectTabProps) {
  const { t, direction } = useI18n();
  const isRtl = direction === 'rtl';
  const label = projectLabel(project);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
    disabled,
  });
  // The fillet's transparent quarter must face away from the tab, so it curves
  // out; that outer corner swaps sides with the writing direction.
  const fillet = (outerCorner: 'left' | 'right') =>
    `radial-gradient(circle at top ${outerCorner}, transparent ${FILLET_PX}px, var(--background) ${FILLET_PX}px)`;

  return <div
    ref={setNodeRef}
    style={{
      // Translate only: Transform adds the scale that stretches a dragged tab to
      // the width of the slot it passes over.
      transform: DndCSS.Translate.toString(transform),
      transition,
    }}
    className={cn('flex shrink-0 items-stretch', selected && 'z-10', isDragging && 'z-20 opacity-60')}
    {...attributes}
    {...listeners}
  >
    <div
      className={cn(
        // touch-none keeps the browser from scrolling the strip instead of
        // dragging; select-none stops the drag from selecting the label.
        'relative flex items-center border-x border-t border-transparent pb-px touch-none select-none',
        'rounded-ts-md rounded-te-md',
        selected
          // The label carries the tab's colour: full strength when selected, the
          // header's muted tone when not, which is what sets the chosen tab apart
          // from its neighbours.
          ? 'border-border bg-background text-foreground'
          : 'text-muted-foreground hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] hover:text-foreground',
      )}
    >
      <button
        type="button"
        aria-current={selected ? 'page' : undefined}
        disabled={disabled}
        onClick={() => onSelect(project.id)}
        className="max-w-48 truncate px-2.5 py-1.5 text-sm"
      >
        {label}
      </button>
      {asks?.question && <WorkBoardTabAskBadge kind="question" />}
      {asks?.permission && <WorkBoardTabAskBadge kind="permission" />}
      {badge && <WorkBoardTabBuildBadge badge={badge} label={label} />}
      <button
        type="button"
        disabled={disabled}
        onClick={() => onClose(project.id)}
        aria-label={t('workBoard.closeProjectTab', { project: label })}
        title={t('workBoard.closeProjectTab', { project: label })}
        className="me-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-surface-muted hover:text-foreground"
      >
        <Icon name="close" className="size-3" />
      </button>
      {selected && <>
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-0"
          style={{ insetInlineEnd: '100%', width: FILLET_PX, height: FILLET_PX, backgroundImage: fillet(isRtl ? 'right' : 'left') }}
          data-work-board-fillet
        />
        <span
          aria-hidden
          className="pointer-events-none absolute bottom-0"
          style={{ insetInlineStart: '100%', width: FILLET_PX, height: FILLET_PX, backgroundImage: fillet(isRtl ? 'left' : 'right') }}
          data-work-board-fillet
        />
      </>}
    </div>
  </div>;
}

export function WorkBoardProjectTabs({
  projects,
  openProjectIds,
  activeProjectId,
  disabled,
  badges,
  asks,
  onSelect,
  onAdd,
  onClose,
  onReorder,
}: WorkBoardProjectTabsProps) {
  const { t, direction } = useI18n();
  const isRtl = direction === 'rtl';
  const openIds = new Set(openProjectIds);
  const openProjects = projects.filter(project => openIds.has(project.id));
  const availableProjects = projects.filter(project => !openIds.has(project.id));
  const openProjectIdList = openProjects.map(project => project.id);

  const sensors = useSensors(
    // Mouse drags after a small move so a click still selects the tab; touch
    // needs a long-press so a swipe keeps scrolling the strip.
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
  );

  const handleDragEnd = React.useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    // Ids, never indices: an index stops naming the same tab after one move.
    if (!openProjectIdList.includes(String(active.id)) || !openProjectIdList.includes(String(over.id))) return;
    onReorder(String(active.id), String(over.id));
  }, [onReorder, openProjectIdList]);

  return <DndContext
    sensors={sensors}
    collisionDetection={closestCenter}
    onDragEnd={handleDragEnd}
    modifiers={[restrictToXAxis]}
  >
    {/* relative z-10 lifts the strip above the header's separator line, which is
        drawn behind the tabs so the selected tab's own fill can break it. */}
    <nav aria-label={t('workBoard.projectTabs')} className="relative z-10 flex min-w-0 items-end gap-1">
      <div className="flex min-w-0 items-end gap-1 overflow-x-auto ps-1.5 -ms-1.5 pe-1.5 -me-1.5">
        {/* The negative margins cancel the padding, so the tabs stay put while
            the scroll container's clip keeps room for the end tabs' flares. */}
        {/* The horizontal strategy assumes later items sit further right; in RTL
            the rect strategy shifts neighbours from their real positions. */}
        <SortableContext items={openProjectIdList} strategy={isRtl ? rectSortingStrategy : horizontalListSortingStrategy}>
          {openProjects.map(project => <WorkBoardProjectTab
            key={project.id}
            project={project}
            selected={project.id === activeProjectId}
            disabled={disabled}
            badge={badges.get(project.id)}
            asks={asks.get(project.id)}
            onSelect={onSelect}
            onClose={onClose}
          />)}
        </SortableContext>
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            disabled={disabled || availableProjects.length === 0}
            aria-label={t('workBoard.addProjectTab')}
            title={t('workBoard.addProjectTab')}
            // Bottom-aligned with the tabs it follows, so it reads as the next
            // slot in the row rather than a control elsewhere in the header.
            className="shrink-0"
          >
            <Icon name="add" className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {availableProjects.map(project => <DropdownMenuItem key={project.id} onClick={() => onAdd(project.id)}>
            {projectLabel(project)}
          </DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>
    </nav>
  </DndContext>;
}
