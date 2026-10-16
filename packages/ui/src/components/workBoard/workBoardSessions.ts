import type { Session } from '@/lib/opencode/model';

const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Filter before building cards so excluded sessions never request history. */
export function workBoardSessions(sessions: Session[], directory: string, includeOlder: boolean, activeIds: ReadonlySet<string>, now: number): Session[] {
  const parents = new Map(sessions.map(session => [session.id, session.parentID]));
  const activeRoots = new Set(activeIds);
  for (const id of activeIds) {
    let parent = parents.get(id);
    while (parent && !activeRoots.has(parent)) {
      activeRoots.add(parent);
      parent = parents.get(parent);
    }
  }
  const cutoff = now - RECENT_WINDOW_MS;
  return sessions.filter(session => session.directory === directory && !session.parentID
    && (includeOlder || session.time.updated >= cutoff || activeRoots.has(session.id)));
}
