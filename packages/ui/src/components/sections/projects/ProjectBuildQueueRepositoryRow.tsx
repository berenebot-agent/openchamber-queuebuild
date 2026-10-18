import React from 'react';
import { useShallow } from 'zustand/react/shallow';
import { SettingsFieldRow, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { fetchQueueSettings, updateQueueRepository } from '@/lib/workBoardApi';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useGitStore, useIsGitRepo, useNestedRepos } from '@/stores/useGitStore';
import { useUIStore } from '@/stores/useUIStore';
import { queueRepositoryNote, queueRepositoryOptions, samePath } from './buildQueueRepositoryModel';

/** Only these policies run the queue's Git checks, so only they use a repository. */
const gitPolicies = ['pause', 'commit'];

/**
 * The repository this project's build queue checks before each build. A project
 * whose folder holds the checkout needs no choice; a project whose repository
 * sits in a subfolder picks one of the repositories found under it.
 *
 * Picking the project folder clears the choice: the queue then resolves the
 * repository from the directory it dispatches, which is the same repository.
 */
export function ProjectBuildQueueRepositoryRow({ directory }: { directory: string }) {
  const { t } = useI18n();
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const policy = useUIStore(state => state.buildQueueGitPolicy ?? (state.buildQueueRequireCleanGit ? 'pause' : 'continue'));
  const rootIsGitRepo = useIsGitRepo(directory || null);
  const nested = useNestedRepos(directory || null);
  const { git } = useRuntimeAPIs();
  const { ensureStatus, ensureNestedRepos } = useGitStore(useShallow(state => ({
    ensureStatus: state.ensureStatus,
    ensureNestedRepos: state.ensureNestedRepos,
  })));
  const [repository, setRepository] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const shown = !isVSCode && gitPolicies.includes(policy);

  // Probe the folder and scan it for repositories in the background; the git
  // store caches both answers and shares them with the Git surfaces.
  React.useEffect(() => {
    if (!shown || !directory) return;
    if (rootIsGitRepo === null) void ensureStatus(directory, git);
    void ensureNestedRepos(directory);
  }, [directory, ensureNestedRepos, ensureStatus, git, rootIsGitRepo, shown]);

  React.useEffect(() => {
    if (!shown || !directory) return;
    let cancelled = false;
    fetchQueueSettings(directory)
      .then(settings => { if (!cancelled) setRepository(settings.repository); })
      .catch(() => { /* The row keeps the last known value; a failed read is not "no choice". */ });
    return () => { cancelled = true; };
  }, [directory, shown]);

  const repositories = React.useMemo(
    () => queueRepositoryOptions(directory, rootIsGitRepo, nested),
    [directory, nested, rootIsGitRepo],
  );

  const save = (next: string) => {
    const previous = repository;
    const stored = samePath(next, directory) ? null : next;
    setRepository(stored);
    setBusy(true);
    updateQueueRepository(directory, stored)
      .then(() => fetchQueueSettings(directory))
      .then(settings => setRepository(settings.repository))
      .catch(cause => {
        setRepository(previous);
        toast.error(cause instanceof Error ? cause.message : t('workBoard.failed'));
      })
      .finally(() => setBusy(false));
  };

  if (!shown) return null;

  const note = queueRepositoryNote(repository, repositories, nested);
  const noteText = note === 'missing' ? t('workBoard.repository.missing')
    : note === 'scanning' ? t('workBoard.repository.scanning')
      : note === 'scanFailed' ? t('workBoard.repository.scanFailed')
        : note === 'none' ? t('workBoard.repository.none')
          : null;
  // The project folder's own repository is what the queue resolves without a
  // choice, so it reads as selected when the project never chose one.
  const selected = repository ?? (rootIsGitRepo === true ? directory : '');

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
