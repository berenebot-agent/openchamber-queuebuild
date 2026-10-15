import React from 'react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { ProjectEntry } from '@/lib/api/types';

type WorkBoardProjectTabsProps = {
  projects: ProjectEntry[];
  openProjectIds: string[];
  activeProjectId: string;
  disabled: boolean;
  onSelect: (projectId: string) => void;
  onAdd: (projectId: string) => void;
  onClose: (projectId: string) => void;
};

const projectLabel = (project: ProjectEntry): string => project.label || project.path.split('/').at(-1) || project.path;

export function WorkBoardProjectTabs({
  projects,
  openProjectIds,
  activeProjectId,
  disabled,
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
        return <div key={project.id} className={`flex shrink-0 items-center rounded-md border ${selected ? 'border-border bg-surface-elevated' : 'border-transparent'}`}>
          <button type="button" aria-current={selected ? 'page' : undefined} disabled={disabled} onClick={() => onSelect(project.id)} className="max-w-48 truncate px-2.5 py-1.5 text-sm text-foreground">
            {label}
          </button>
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
