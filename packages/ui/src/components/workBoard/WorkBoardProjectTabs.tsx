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
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import type { ProjectEntry } from '@/lib/api/types';
import type { WorkBoardBuildBadge } from './workBoardWorkflow';

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
  onSelect: (projectId: string) => void;
  onAdd: (projectId: string) => void;
  onClose: (projectId: string) => void;
  /** A tab was dropped on another: the two ids' new order, left to right. */
  onReorder: (activeProjectId: string, overProjectId: string) => void;
};

const projectLabel = (project: ProjectEntry): string => project.label || project.path.split('/').at(-1) || project.path;

// A lifted tab keeps its own height and follows the row; letting it drift to the
// header's other controls would only suggest a drop target that is not one.
const restrictToXAxis: Modifier = ({ transform }) => ({
  ...transform,
  y: 0,
});

/**
 * A project's build queue at a glance: a blue spinner carrying the number of
 * builds in flight or waiting, or an amber exclamation when the queue state
 * could not be read. It sits beside the tab's label but outside the tab button,
 * so a disabled tab during another write still shows whether that project is
 * building. Motion follows the appearance setting, like every other activity
 * indicator.
 */
function WorkBoardTabBuildBadge({ badge, label }: { badge: WorkBoardBuildBadge; label: string }) {
  const { t } = useI18n();
  const animated = useSessionDisplayStore(state => state.animatedActivityIndicators);
  const title = badge.error
    ? t('workBoard.headerQueueError', { project: label })
    : t('workBoard.headerBuilds', { project: label, count: badge.count });
  if (badge.error) {
    return <span
      className="me-1 inline-flex shrink-0 items-center justify-center"
      aria-label={title} title={title} data-work-board-build="error"
    >
      <Icon name="error-warning" className="size-3.5 text-status-warning" />
    </span>;
  }
  return <span
    className="me-1 inline-flex shrink-0 items-center gap-1 rounded-full bg-[color-mix(in_srgb,var(--status-info)_16%,transparent)] px-1.5 py-0.5 text-[10px] font-semibold leading-none tabular-nums text-status-info"
    aria-label={title} title={title} data-work-board-build="running"
  >
    <Icon name="loader-4" className={animated ? 'activity-spinner size-3' : 'size-3'} />
    {badge.count}
  </span>;
}

type WorkBoardProjectTabProps = {
  project: ProjectEntry;
  selected: boolean;
  disabled: boolean;
  badge: WorkBoardBuildBadge | undefined;
  onSelect: (projectId: string) => void;
  onClose: (projectId: string) => void;
};

/**
 * One connected project tab: a rounded rectangle whose top corners curve away
 * from the board header and whose base reaches the header's lower edge. The
 * selected tab is filled with the board's own surface and overhangs the header's
 * bottom border by a pixel, so the line breaks under it and the tab reads as
 * continuous with the board below rather than as a separate chip.
 */
function WorkBoardProjectTab({
  project,
  selected,
  disabled,
  badge,
  onSelect,
  onClose,
}: WorkBoardProjectTabProps) {
  const { t } = useI18n();
  const label = projectLabel(project);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: project.id,
    disabled,
  });

  return <div
    ref={setNodeRef}
    style={{
      // Translate only: Transform adds the scale that stretches a dragged tab to
      // the width of the slot it passes over.
      transform: DndCSS.Translate.toString(transform),
      transition,
    }}
    className={cn('flex shrink-0 items-stretch', isDragging && 'z-20 opacity-60')}
    {...attributes}
    {...listeners}
  >
    <div
      className={cn(
        // touch-none keeps the browser from scrolling the strip instead of
        // dragging; select-none stops the drag from selecting the label.
        // pb-px gives the tab a pixel of its own fill below the 1px border, so
        // selected and unselected tabs sit at the same height.
        'flex items-center border-x border-t border-transparent pb-px touch-none select-none',
        'rounded-ts-md rounded-te-md',
        selected
          // -mb-px overhangs the header's border-b so the line does not run
          // beneath the selected tab.
          ? 'border-border bg-background -mb-px'
          : 'text-muted-foreground hover:bg-[color-mix(in_srgb,var(--foreground)_5%,transparent)] hover:text-foreground',
      )}
    >
      <button
        type="button"
        aria-current={selected ? 'page' : undefined}
        disabled={disabled}
        onClick={() => onSelect(project.id)}
        className="max-w-48 truncate px-2.5 py-1.5 text-sm text-foreground"
      >
        {label}
      </button>
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
    </div>
  </div>;
}

export function WorkBoardProjectTabs({
  projects,
  openProjectIds,
  activeProjectId,
  disabled,
  badges,
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
    <nav aria-label={t('workBoard.projectTabs')} className="flex min-w-0 items-end gap-1">
      <div className="flex min-w-0 items-end gap-1 overflow-x-auto">
        {/* The horizontal strategy assumes later items sit further right; in RTL
            the rect strategy shifts neighbours from their real positions. */}
        <SortableContext items={openProjectIdList} strategy={isRtl ? rectSortingStrategy : horizontalListSortingStrategy}>
          {openProjects.map(project => <WorkBoardProjectTab
            key={project.id}
            project={project}
            selected={project.id === activeProjectId}
            disabled={disabled}
            badge={badges.get(project.id)}
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
            className="mb-px shrink-0"
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
