import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { SettingsFieldRow, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { updateQueueRepository } from '@/lib/workBoardApi';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitStore, useIsGitRepo, useNestedRepos } from '@/stores/useGitStore';
import { queueRepositoryNote, queueRepositoryOptions, samePath } from './buildQueueRepositoryModel';

/**
 * The repository this project's build queue uses for Git checks. The selection
 * stays available under Continue so it is ready if the policy changes later.
 *
 * Picking the project folder clears the choice, and the queue then resolves the
 * repository from the directory it dispatches.
 */
export function ProjectBuildQueueRepositoryRow({ directory, repository, effectiveRepository, onSaved }: {
  directory: string;
  repository: string | null;
  effectiveRepository: string | null;
  onSaved: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const rootIsGitRepo = useIsGitRepo(directory || null);
  const nested = useNestedRepos(directory || null);
  const { git } = useRuntimeAPIs();
  const { ensureStatus, ensureNestedRepos } = useGitStore(useShallow(state => ({
    ensureStatus: state.ensureStatus,
    ensureNestedRepos: state.ensureNestedRepos,
  })));
  const [current, setCurrent] = React.useState<string | null>(repository);
  const [busy, setBusy] = React.useState(false);
  const shown = !isVSCode;

  React.useEffect(() => setCurrent(repository), [repository]);

  // Probe the folder and scan it for repositories in the background; the git
  // store caches both answers and shares them with the Git surfaces.
  React.useEffect(() => {
    if (!shown || !directory) return;
    if (rootIsGitRepo === null) void ensureStatus(directory, git);
    void ensureNestedRepos(directory);
  }, [directory, ensureNestedRepos, ensureStatus, git, rootIsGitRepo, shown]);

  const repositories = React.useMemo(
    () => queueRepositoryOptions(directory, rootIsGitRepo, nested),
    [directory, nested, rootIsGitRepo],
  );

  const save = (next: string) => {
    const previous = current;
    const stored = samePath(next, directory) ? null : next;
    setCurrent(stored);
    setBusy(true);
    updateQueueRepository(directory, stored)
      .then(onSaved)
      .catch(cause => {
        setCurrent(previous);
        toast.error(cause instanceof Error ? cause.message : t('workBoard.failed'));
      })
      .finally(() => setBusy(false));
  };

  if (!shown) return null;

  const note = queueRepositoryNote(current, repositories, nested);
  const noteText = note === 'missing' ? t('workBoard.repository.missing')
    : note === 'scanning' ? t('workBoard.repository.scanning')
      : note === 'scanFailed' ? t('workBoard.repository.scanFailed')
        : note === 'none' ? t('workBoard.repository.none')
          : null;
  // The project folder's own repository is what the queue resolves without a
  // choice, so it reads as selected when the project never chose one.
  const selected = current ?? effectiveRepository ?? (rootIsGitRepo === true ? directory : '');

  return (
    <SettingsFieldRow
      label={t('workBoard.repository.label')}
      description={noteText}
      info={t('workBoard.repository.info')}
      settingsItem="projects.build-queue-repository"
    >
      <Select value={selected} onValueChange={next => { if (next !== selected) save(next); }}
        disabled={busy || !directory || repositories.length === 0}>
        <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('workBoard.repository.label')}>
          <SelectValue placeholder={t('workBoard.repository.choose')} />
        </SelectTrigger>
        <SelectContent>
          {repositories.map(path => <SelectItem key={path} value={path}>
            {samePath(path, directory) ? t('workBoard.repository.projectFolder') : path.slice(directory.length + 1)}
          </SelectItem>)}
        </SelectContent>
      </Select>
    </SettingsFieldRow>
  );
}
