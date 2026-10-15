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
