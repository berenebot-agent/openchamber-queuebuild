import React from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
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
};

const projectLabel = (project: ProjectEntry): string => project.label || project.path.split('/').at(-1) || project.path;

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

export function WorkBoardProjectTabs({
  projects,
  openProjectIds,
  activeProjectId,
  disabled,
  badges,
  onSelect,
  onAdd,
  onClose,
}: WorkBoardProjectTabsProps) {
  const { t } = useI18n();
  const openIds = new Set(openProjectIds);
  const openProjects = projects.filter(project => openIds.has(project.id));
  const availableProjects = projects.filter(project => !openIds.has(project.id));

  return <>
    <nav aria-label={t('workBoard.projectTabs')} className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
      {openProjects.map(project => {
        const label = projectLabel(project);
        const selected = project.id === activeProjectId;
        const badge = badges.get(project.id);
        return <div key={project.id} className={`flex shrink-0 items-center rounded-md border ${selected ? 'border-border bg-surface-elevated' : 'border-transparent'}`}>
          <button type="button" aria-current={selected ? 'page' : undefined} disabled={disabled} onClick={() => onSelect(project.id)} className="max-w-48 truncate px-2.5 py-1.5 text-sm text-foreground">
            {label}
          </button>
          {badge && <WorkBoardTabBuildBadge badge={badge} label={label} />}
          <button type="button" disabled={disabled} onClick={() => onClose(project.id)} aria-label={t('workBoard.closeProjectTab', { project: label })} title={t('workBoard.closeProjectTab', { project: label })} className="me-1 flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-surface-muted hover:text-foreground">
            <Icon name="close" className="size-3" />
          </button>
        </div>;
      })}
    </nav>
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" size="icon" variant="ghost" disabled={disabled || availableProjects.length === 0} aria-label={t('workBoard.addProjectTab')} title={t('workBoard.addProjectTab')}>
          <Icon name="add" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {availableProjects.map(project => <DropdownMenuItem key={project.id} onClick={() => onAdd(project.id)}>
          {projectLabel(project)}
        </DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
  </>;
}
