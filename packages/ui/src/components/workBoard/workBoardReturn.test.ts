import { expect, test } from 'bun:test';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { rememberWorkBoardReturn } from './workBoardReturn';

const projects = [
  { id: 'project', path: '/repo', label: 'Repository', addedAt: 1 },
  { id: 'other', path: '/other', label: 'Other', addedAt: 1 },
];

test('returning to the board targets the project of the current session', () => {
  const projectState = useProjectsStore.getState();
  const ui = useUIStore.getState();
  const sessionUI = useSessionUIStore.getState();
  const runtimeKey = getRuntimeKey();
  try {
    useProjectsStore.setState({ projects, activeProjectId: 'project', hasServerSnapshot: true });
    useUIStore.setState({
      workBoardProjectTabsByRuntime: { [runtimeKey]: { projectIds: ['project'], activeProjectId: 'project' } },
      workBoardProjectId: 'project',
    });

    // A session in another project becomes the active tab, and joins the open
    // tabs instead of replacing them.
    useSessionUIStore.setState({ currentSessionId: 'session', currentSessionDirectory: '/other' });
    rememberWorkBoardReturn();
    expect(useUIStore.getState().workBoardProjectTabsByRuntime[runtimeKey]).toEqual({
      projectIds: ['project', 'other'], activeProjectId: 'other',
    });
    expect(useUIStore.getState().workBoardProjectId).toBe('other');

    // Repeating the same return adds no duplicate tab.
    rememberWorkBoardReturn();
    expect(useUIStore.getState().workBoardProjectTabsByRuntime[runtimeKey]?.projectIds).toEqual(['project', 'other']);

    // A session under a worktree directory belongs to the project that owns the
    // worktree, even when the directory is not nested inside the project path.
    useProjectsStore.setState({ projects: [...projects, { id: 'sibling', path: '/worktrees', label: 'Worktrees', addedAt: 1 }] });
    useSessionUIStore.setState({
      currentSessionDirectory: '/worktrees/repo-fix',
      availableWorktreesByProject: new Map([['/other', [{
        path: '/worktrees/repo-fix', projectDirectory: '/other', branch: 'fix', name: 'fix', label: 'fix', worktreeStatus: 'ready',
      }]]]),
    });
    rememberWorkBoardReturn();
    expect(useUIStore.getState().workBoardProjectTabsByRuntime[runtimeKey]).toEqual({
      projectIds: ['project', 'other'], activeProjectId: 'other',
    });

    // A directory that names no project keeps the remembered board rather than
    // inventing a tab that would open nothing.
    useUIStore.setState({
      workBoardProjectTabsByRuntime: { [runtimeKey]: { projectIds: ['other'], activeProjectId: 'other' } },
      workBoardProjectId: 'other',
    });
    useSessionUIStore.setState({ currentSessionDirectory: '/unknown', availableWorktreesByProject: new Map() });
    rememberWorkBoardReturn();
    expect(useUIStore.getState().workBoardProjectTabsByRuntime[runtimeKey]).toEqual({ projectIds: ['other'], activeProjectId: 'other' });

    // Without any remembered board there is nothing to open.
    useUIStore.setState({ workBoardProjectTabsByRuntime: {}, workBoardProjectId: null });
    useSessionUIStore.setState({ currentSessionDirectory: '/unknown' });
    rememberWorkBoardReturn();
    expect(useUIStore.getState().workBoardProjectTabsByRuntime[runtimeKey]).toBeUndefined();
  } finally {
    useProjectsStore.setState(projectState);
    useUIStore.setState(ui);
    useSessionUIStore.setState(sessionUI);
  }
});
