import React from 'react';
import { fetchQueueSettings, type QueueGitPolicy } from '@/lib/workBoardApi';

export interface ProjectQueueSettings {
  /** The policy the queue will run for this project. */
  policy: QueueGitPolicy;
  /** The project's own policy, or `null` when it follows the instance default. */
  policyOverride: QueueGitPolicy | null;
  /** The repository the queue runs its Git checks against, or `null` for the project folder. */
  repository: string | null;
  /** The resolved checkout used when no project-specific repository is stored. */
  effectiveRepository: string | null;
}

/**
 * The project's build-queue choices, read once for the rows that share them.
 * The effective policy decides whether the repository row applies, so both come
 * from one read and a policy write reloads them together — switching to a Git
 * policy shows the repository row without leaving the page.
 */
export function useProjectQueueSettings(directory: string, enabled: boolean) {
  const [settings, setSettings] = React.useState<ProjectQueueSettings | null>(null);

  const reload = React.useCallback(async () => {
    if (!enabled || !directory) return;
    try {
      const next = await fetchQueueSettings(directory);
      setSettings({ policy: next.policy, policyOverride: next.policyOverride, repository: next.repository, effectiveRepository: next.effectiveRepository });
    } catch {
      // Keep the last known read; a failed read is not "no choice".
    }
  }, [directory, enabled]);

  React.useEffect(() => { void reload(); }, [reload]);

  return { settings, reload };
}
