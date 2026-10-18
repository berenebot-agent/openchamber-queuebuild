/**
 * Whether a session's turn has really ended.
 *
 * A parent session goes idle while a background subagent keeps working in a
 * child session. When the child finishes, OpenCode delivers its result to the
 * parent, which runs again and goes idle a second time. So the parent's first
 * idle is a pause, not the end of the turn: anything that treats idle as
 * "done" (goal audits, ready notifications) has to check the children too.
 *
 * A background shell job outlives its turn the same way: the tool call settles
 * at once and the session resumes when the job exits. A session with a running
 * job is therefore not finished either, even with no child session running.
 *
 * Every read answers `null` when OpenCode could not be asked: "could not look"
 * must never pass for "nothing is running".
 */

import { unwrapOpenCodeResponse } from './response-envelope.js';
import { z } from 'zod';

const CHILDREN_PAGE_SIZE = 50;
const CHILDREN_MAX_PAGES = 8;
const MAX_SUBAGENT_DEPTH = 8;
const sessionLineageSchema = z.object({ id: z.string().min(1), parentID: z.string().min(1).nullish() });
// `GET /api/shell` lists a record per job; only a running one whose metadata
// names its session says anything about that session.
const shellListSchema = z.array(z.looseObject({
  status: z.string(),
  metadata: z.object({ sessionID: z.string().min(1) }).nullish(),
}));

export const createSessionActivityProbe = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs = 10_000, fetchImpl = fetch }) => {
  const openCodeGet = async (fetchPath, query, signal = AbortSignal.timeout(timeoutMs), extraHeaders) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const search = new URLSearchParams(query || {}).toString();
    const response = await fetchImpl(search ? `${base}?${search}` : base, {
      method: 'GET',
      headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders(), ...extraHeaders },
      signal,
    });
    if (!response.ok) {
      throw new Error(`OpenCode GET ${fetchPath} failed with ${response.status}`);
    }
    return unwrapOpenCodeResponse(await response.json().catch(() => null));
  };

  /**
   * `/api/session/active` is global and lists only the sessions running right
   * now (`{ data: { [id]: status } }`), so an absent id is idle.
   */
  const fetchActiveSessionStatuses = async () => {
    const statuses = await openCodeGet('/api/session/active').catch(() => null);
    return statuses && typeof statuses === 'object' && !Array.isArray(statuses) ? statuses : null;
  };

  /**
   * v2 has no `/session/{id}/children`; `GET /api/session?parentID=` lists a
   * parent's subagent sessions, newest first, in cursor pages. Later pages
   * carry the filter inside the cursor, so only the cursor and the limit
   * travel. A parent with more subagents than this walks is unknown (`null`).
   */
  const fetchChildSessionIds = async (sessionId) => {
    const ids = [];
    const seenCursors = new Set();
    let cursor;
    for (let pageNumber = 0; pageNumber < CHILDREN_MAX_PAGES; pageNumber += 1) {
      const page = await openCodeGet('/api/session', {
        limit: String(CHILDREN_PAGE_SIZE),
        ...(cursor ? { cursor } : { parentID: sessionId }),
      }).catch(() => null);
      if (!Array.isArray(page?.data)) return null;
      for (const child of page.data) {
        if (typeof child?.id === 'string' && child.id) ids.push(child.id);
      }
      const next = page.cursor?.next;
      if (!next || page.data.length === 0 || seenCursors.has(next)) return ids;
      seenCursors.add(next);
      cursor = next;
    }
    return null;
  };

  /**
   * The sessions running a background shell job in `directory` right now, from
   * `GET /api/shell` (`{ location, data: [{ status, metadata: { sessionID } }] }`).
   * The route is scoped by the encoded `x-opencode-directory` header, not a
   * query. Null when OpenCode could not be asked.
   *
   * The shared unwrap hands over `data` itself, so a plain array is the list.
   *
   * `excludeSessionId` drops that session's own jobs: a session's own job is
   * already reported by `isSessionIdle`, so a descendant walk must not read it
   * back as a live child.
   */
  const fetchRunningShellSessionIds = async (directory, { excludeSessionId } = {}) => {
    const body = await openCodeGet('/api/shell', undefined, undefined, {
      'x-opencode-directory': encodeURIComponent(directory),
      'x-opencode-directory-encoding': 'uri',
    }).catch(() => null);
    const parsed = shellListSchema.safeParse(body);
    if (!parsed.success) return null;
    const ids = new Set();
    for (const shell of parsed.data) {
      if (shell.status !== 'running') continue;
      const sessionId = shell.metadata?.sessionID;
      if (!sessionId || sessionId === excludeSessionId) continue;
      ids.add(sessionId);
    }
    return ids;
  };

  /** True when a subagent of the session runs; null when unknown. */
  const hasWorkingChildren = async (sessionId, statuses) => {
    const children = await fetchChildSessionIds(sessionId);
    if (!children) return null;
    return children.some((id) => Boolean(statuses[id]));
  };

  /**
   * Queue delivery waits for running descendants, including nested subagents.
   * A chain deeper than `MAX_SUBAGENT_DEPTH` counts as unrelated, as in the
   * UI's ancestor walk, so a deep tree elsewhere cannot hold every queue.
   * `isDescendantOf` is the same bounded walk over whatever ids a caller
   * considers live.
   */
  const isDescendantOf = async (sessionId, liveIds) => {
    const parents = new Map();
    const signal = AbortSignal.timeout(timeoutMs);
    let unknown = false;
    for (const activeId of liveIds) {
      if (activeId === sessionId) continue;
      let current = activeId;
      const visited = new Set();
      for (let depth = 0; current && depth < MAX_SUBAGENT_DEPTH; depth += 1) {
        if (signal.aborted) return null;
        if (visited.has(current)) {
          unknown = true;
          break;
        }
        visited.add(current);
        if (!parents.has(current)) {
          const body = await openCodeGet(`/api/session/${encodeURIComponent(current)}`, undefined, signal).catch(() => null);
          const parsed = sessionLineageSchema.safeParse(body);
          parents.set(current, parsed.success && parsed.data.id === current ? parsed.data.parentID ?? null : undefined);
        }
        const parentId = parents.get(current);
        if (parentId === undefined) {
          unknown = true;
          break;
        }
        if (parentId === sessionId) return true;
        current = parentId;
      }
    }
    return unknown ? null : false;
  };

  const hasWorkingDescendants = (sessionId, statuses) => isDescendantOf(sessionId, Object.keys(statuses));

  /**
   * True when a session running a background job is a subagent of the given
   * session: the child's job finishing resumes the child, which reruns the
   * parent, so the parent's turn is not over either.
   */
  const hasShellDescendants = (sessionId, shellSessionIds) => isDescendantOf(sessionId, shellSessionIds);

  return {
    fetchActiveSessionStatuses,
    fetchChildSessionIds,
    fetchRunningShellSessionIds,
    hasWorkingChildren,
    hasWorkingDescendants,
    hasShellDescendants,
  };
};
