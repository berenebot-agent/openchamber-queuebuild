import type { ProjectEntry } from '@/lib/api/types';

/**
 * The work board projects this device opened, remembered per connected server.
 * Project ids are `path_` base64, so a newline-separated list round-trips
 * without escaping.
 */
const KEY_PREFIX = 'openchamber-work-board:recent-projects:v1:';
// Bounded so a device that visits hundreds of projects cannot grow storage without limit.
const MAX_REMEMBERED = 30;

const projectsKey = (runtimeKey: string): string => KEY_PREFIX + runtimeKey;

/** Storage can be unavailable in private mode or while the mobile shell starts. */
export function readRecentWorkBoardProjects(runtimeKey: string): string[] {
  try {
    const stored = localStorage.getItem(projectsKey(runtimeKey));
    return stored ? stored.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function rememberWorkBoardProjectAccess(runtimeKey: string, projectId: string): void {
  if (!projectId) return;
  const next = [projectId, ...readRecentWorkBoardProjects(runtimeKey).filter(id => id !== projectId)]
    .slice(0, MAX_REMEMBERED);
  try {
    localStorage.setItem(projectsKey(runtimeKey), next.join('\n'));
  } catch {
    // The in-memory order still works when storage is disabled.
  }
}

/**
 * The phone picker's order: the boards this device opened, most recent first,
 * then every other project in the order it was given. A stable sort keeps the
 * untouched projects where they were.
 */
export function recentWorkBoardProjectOrder(
  projects: readonly ProjectEntry[],
  recentProjectIds: readonly string[],
): ProjectEntry[] {
  const rank = new Map(recentProjectIds.map((id, index) => [id, index]));
  return [...projects].sort((left, right) => (rank.get(left.id) ?? Infinity) - (rank.get(right.id) ?? Infinity));
}
