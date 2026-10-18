import { Spinner } from '@/components/ui/spinner';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import type { WorkBoardBuildBadge, WorkBoardTabAsks } from './workBoardWorkflow';

/**
 * A project's build queue at a glance: a blue spinner carrying the number of
 * builds in flight or waiting, an amber exclamation when the queue state could
 * not be read, or a warning mark when the queue was read and is waiting for the
 * user. Motion follows the appearance setting, like every other activity
 * indicator.
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

/**
 * Everything a project says at a glance, in one place: its pending asks first,
 * then its build queue. The desktop tab strip and the phone's project picker
 * both render this, so a board reads the same wherever it is listed.
 */
export function WorkBoardProjectMarks({ badge, asks, label }: {
  badge: WorkBoardBuildBadge | undefined;
  asks: WorkBoardTabAsks | undefined;
  label: string;
}) {
  return <>
    {asks?.question && <WorkBoardTabAskBadge kind="question" />}
    {asks?.permission && <WorkBoardTabAskBadge kind="permission" />}
    {badge && <WorkBoardTabBuildBadge badge={badge} label={label} />}
  </>;
}
