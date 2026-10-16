type WorkBoardProjectTabsRemoval = {
  projectIds: string[];
  activeProjectId: string | null;
};

export function removeWorkBoardProjectTab(
  projectIds: readonly string[],
  activeProjectId: string | null,
  closedProjectId: string,
): WorkBoardProjectTabsRemoval {
  const closedIndex = projectIds.indexOf(closedProjectId);
  if (closedIndex === -1) return { projectIds: [...projectIds], activeProjectId };

  const remainingIds = projectIds.filter(projectId => projectId !== closedProjectId);
  const nextActiveProjectId = activeProjectId !== closedProjectId
    ? remainingIds.includes(activeProjectId ?? '') ? activeProjectId : remainingIds[0] ?? null
    : remainingIds[Math.min(closedIndex, remainingIds.length - 1)] ?? null;
  return { projectIds: remainingIds, activeProjectId: nextActiveProjectId };
}

/**
 * The tab order after one tab is dropped on another: the dragged tab takes the
 * dropped-on tab's place and everything between them shifts. Ids that name no
 * open tab leave the order untouched, so a drag that ended off a tab changes
 * nothing rather than reordering around a stranger.
 */
export function reorderWorkBoardProjectTabs(
  projectIds: readonly string[],
  activeProjectId: string,
  overProjectId: string,
): string[] {
  const from = projectIds.indexOf(activeProjectId);
  const to = projectIds.indexOf(overProjectId);
  if (from === -1 || to === -1 || from === to) return [...projectIds];

  const reordered = [...projectIds];
  const [moved] = reordered.splice(from, 1);
  reordered.splice(to, 0, moved);
  return reordered;
}
