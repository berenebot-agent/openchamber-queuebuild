import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { ProjectEntry } from '@/lib/api/types';
import { projectLabel } from './workBoardProjectState';
import { WorkBoardProjectMarks } from './WorkBoardProjectMarks';
import { recentWorkBoardProjectOrder } from './workBoardRecentProjects';
import type { WorkBoardBuildBadge, WorkBoardTabAsks } from './workBoardWorkflow';

type WorkBoardMobileProjectPickerProps = {
  projects: ProjectEntry[];
  activeProjectId: string;
  recentProjectIds: readonly string[];
  badges: Map<string, WorkBoardBuildBadge>;
  asks: Map<string, WorkBoardTabAsks>;
  /** Controlled by the shell's title badge, which opens the same picker. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onSelect: (projectId: string) => void;
};

/**
 * The phone's replacement for the desktop tab strip: one control naming the
 * board on screen, opening the device's own recent-first list. Each row carries
 * the same marks the tab strip shows, so the list says which board is waiting
 * without opening it. The list is a fresh scroller on every open, so it starts
 * at the top — the recent boards are the reason the picker exists.
 */
export function WorkBoardMobileProjectPicker({
  projects,
  activeProjectId,
  recentProjectIds,
  badges,
  asks,
  open,
  onOpenChange,
  onSelect,
}: WorkBoardMobileProjectPickerProps) {
  const { t } = useI18n();
  const active = projects.find(project => project.id === activeProjectId);
  const ordered = recentWorkBoardProjectOrder(projects, recentProjectIds);
  return <div className="flex flex-col gap-1 text-xs font-medium text-muted-foreground">
    {t('workBoard.projectTabs')}
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t('workBoard.projectTabs')}
          className="flex min-h-11 w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-sm text-foreground"
        >
          <span className="min-w-0 truncate">{active ? projectLabel(active) : ''}</span>
          <Icon name="arrow-down-s" className="size-4 shrink-0 opacity-50" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[var(--anchor-width)]">
        <div className="max-h-[60vh] overflow-y-auto">
          {ordered.map(project => <DropdownMenuItem
            key={project.id}
            onClick={() => onSelect(project.id)}
            className="justify-between"
          >
            <span className="flex min-w-0 items-center gap-1.5">
              {project.id === activeProjectId
                ? <Icon name="check" className="size-3.5 shrink-0 text-foreground" />
                : <span aria-hidden className="size-3.5 shrink-0" />}
              <span className="truncate">{projectLabel(project)}</span>
            </span>
            <WorkBoardProjectMarks badge={badges.get(project.id)} asks={asks.get(project.id)} label={projectLabel(project)} />
          </DropdownMenuItem>)}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}
