import { getRuntimeKey } from '@/lib/runtime-switch';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { opencodeClient } from '@/lib/opencode/client';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Point the board at the project the current session runs in, so reopening it
 * from a chat lands where that session is rather than on the tab the board was
 * last left on. A new project gains a tab instead of replacing the open tabs,
 * and a session whose directory resolves to no project keeps the remembered
 * board rather than inventing a tab that would open nothing.
 */
export function rememberWorkBoardReturn(): void {
  const ui = useUIStore.getState();
  const session = useSessionUIStore.getState();
  const runtimeKey = getRuntimeKey();
  const directory = session.currentSessionDirectory ?? opencodeClient.getDirectory() ?? null;
  const projectId = resolveProjectForSessionDirectory(
    useProjectsStore.getState().projects,
    session.availableWorktreesByProject,
    directory,
  )?.id ?? ui.workBoardProjectId;
  if (!projectId) return;

  const tabs = ui.workBoardProjectTabsByRuntime[runtimeKey];
  ui.setWorkBoardProjectTabs(runtimeKey, {
    projectIds: [...new Set([...(tabs?.projectIds ?? []), projectId])],
    activeProjectId: projectId,
  });
  ui.setWorkBoardProjectId(projectId);
}
