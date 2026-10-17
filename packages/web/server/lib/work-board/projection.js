/**
 * The work board as one server-owned projection: lanes, order, queue state and
 * live activity derived once in the server process from the store, the queue
 * runtime and live session activity. A card's lane is the queue first, then the
 * user's placement, then the session's history. Read-only — every write stays
 * with the store and the queue runtime.
 */

import { z } from 'zod';
import { createWorkBoardActivity } from './activity.js';

const LANES = ['todo', 'plan', 'queue', 'build', 'done'];
const CARD_LANES = ['todo', 'plan', 'build', 'done'];
const RECENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_PAGES = 4;
// Which agents are subagent-only comes from the project's own config, not from
// the board, so one read is reused for this long.
const SUBAGENT_AGENTS_TTL_MS = 60 * 1000;
// Delegation answers the session list did not give are remembered per session,
// bounded like the server's session lineage.
const DELEGATED_CACHE_LIMIT = 5000;

export async function readWorkBoardSessions(client, directory, { includeOlder = false, recentWindowMs = RECENT_WINDOW_MS } = {}) {
  const sessions = [];
  const seenCursors = new Set();
  let cursor;
  for (let pageNumber = 0; pageNumber < SESSION_PAGES; pageNumber += 1) {
    const page = await client.session.list({ directory, ...(cursor ? { cursor } : { order: 'desc', limit: 100 }) });
    if (!Array.isArray(page?.data)) throw new Error('OpenCode session list is unavailable');
    sessions.push(...page.data);
    const next = page.cursor?.next;
    if (!next || seenCursors.has(next)) break;
    if (!includeOlder && (page.data.at(-1)?.time?.updated ?? 0) < Date.now() - recentWindowMs) break;
    seenCursors.add(next);
    cursor = next;
  }
  const cutoff = includeOlder ? 0 : Date.now() - recentWindowMs;
  // Delegated sessions are returned with the rest; the projection leaves them
  // off the board rather than the read hiding them.
  return sessions.filter(session => session?.id
    && normaliseDirectory(session.location?.directory) === normaliseDirectory(directory)
    && (session.time?.updated ?? 0) >= cutoff);
}

const directoryValueSchema = z.string();
const normaliseDirectory = (value) => {
  const parsed = directoryValueSchema.safeParse(value);
  return parsed.success ? parsed.data.replace(/\\/g, '/').replace(/\/+$/, '') : '';
};

/** The lane a card belongs in from history and placement alone; queue wins above. */
function deriveLane(card, activity) {
  const messages = [...(activity?.messages ?? [])].reverse();
  const lastUser = messages.find(message => message.role === 'user');
  const assistant = messages.find(message => message.role === 'assistant');
  const latestTurn = Math.max(lastUser?.time.created ?? 0, assistant?.time.created ?? 0);
  // A manual placement holds until something happens in the session after it.
  if (card.placementAt !== undefined && latestTurn <= card.placementAt && !activity?.busy) {
    return card.stage === 'done' ? (card.completedAt !== undefined ? 'done' : 'build') : card.stage;
  }
  const parkedAt = card.stage === 'done' ? card.completedAt ?? card.updatedAt : card.updatedAt;
  if ((card.stage === 'todo' || card.stage === 'done') && latestTurn <= parkedAt && !activity?.busy) {
    return card.stage === 'done' ? 'build' : card.stage;
  }
  if (lastUser && (!assistant || lastUser.time.created > assistant.time.created)) return 'plan';
  if (assistant && String(assistant.agent ?? '').toLowerCase() === 'build') {
    // A running Build turn is queue work, not settled history.
    return activity?.busy ? 'queue' : 'build';
  }
  return 'plan';
}

/** The completion time a Done card orders by: a manual completion, else history. */
function completionTime(card, activity, lane) {
  const completedAt = card.completedAt ?? card.updatedAt;
  if (card.stage === 'done' && !activity?.busy && !(activity?.messages ?? []).some(message =>
    (message.role === 'user' || message.role === 'assistant') && message.time.created > completedAt)) return card.completedAt ?? 0;
  if (lane !== 'done') return 0;
  return [...(activity?.messages ?? [])].reverse().find(message => message.role === 'idle')?.time.created ?? 0;
}

/** The queue's own view of one directory; a forced build with an unconfirmed
 * prompt carries its target item and recovery instead of reading as running. */
function queueForDirectory(queue, directory) {
  const key = normaliseDirectory(directory);
  const matches = (value) => normaliseDirectory(value) === key;
  const queued = (queue?.queued ?? []).filter(item => matches(item.directory));
  const active = (queue?.active ?? []).find(item => matches(item.directory));
  const forced = (queue?.forced ?? []).filter(item => matches(item.directory));
  const issue = (queue?.issues ?? []).find(item => matches(item.directory))?.issue;
  return {
    rows: queued.map((item, position) => ({
      itemId: item.id, sessionId: item.sessionId, directory: item.directory,
      content: item.content, paused: Boolean(item.paused), position,
      model: item.model ?? null,
    })),
    order: queued.map(item => item.id),
    active: active ? {
      sessionId: active.sessionId, itemId: active.itemId, startedAt: active.startedAt,
      needsReview: Boolean(active.needsReview), retryAvailable: Boolean(active.retryAvailable),
      content: active.content ?? null, model: active.model ?? null,
    } : null,
    forced: forced.map(item => ({
      sessionId: item.sessionId, startedAt: item.startedAt,
      itemId: item.itemId ?? null, needsReview: Boolean(item.needsReview),
      action: item.needsReview ? (item.action ?? 'resolve') : null,
      content: item.content ?? null, model: item.model ?? null,
    })),
    issue: issue ?? null,
    preparation: (queue?.preparation ?? []).find(item => matches(item.directory)) ?? null,
    commit: (queue?.commits ?? []).find(item => matches(item.directory)) ?? null,
  };
}

/**
 * One card derived from a session the board has no stored record for. Its id is
 * the inherited id the store accepts on first placement, and `plan` is the
 * board's starting intent for a session it did not create.
 */
function inheritedCard(session, directory) {
  return {
    id: `session:${session.id}`, directory, text: session.title ?? '',
    attachments: [], sessionId: session.id, stage: 'plan',
    createdAt: session.time?.created ?? 0, updatedAt: session.time?.updated ?? 0,
  };
}

/**
 * A session the board must not card: OpenCode's own subagent child, or a
 * session on a subagent-only agent. The dispatch API refuses to prompt such an
 * agent directly, so the session is delegated work, never one the user started.
 */
const isDelegatedSession = (session, subagentAgentIds) =>
  Boolean(session?.parentID) || subagentAgentIds.has(session?.agent);

/** What each card can do, decided once so every surface reads one contract. A
 * linked card is settled only when its status is known and no turn runs. */
function availableActions(card, lane, status, busy, inheritedAvailable = true) {
  const settled = !card.sessionId || (status === 'known' && !busy);
  const actions = [];
  if (inheritedAvailable && (lane === 'todo' || lane === 'plan' || lane === 'build') && settled) actions.push('complete');
  if (card.completedAt !== undefined && (card.viewedAt === undefined || card.viewedAt < card.completedAt)) actions.push('acknowledge');
  if (!card.sessionId) actions.push('startPlan');
  if (card.sessionId && lane !== 'todo' && settled) actions.push('returnToTodo');
  if (lane === 'todo' && settled) actions.push('remove');
  return actions;
}

export function createWorkBoardProjection({ store, activity, readQueueSnapshot, readQueueEnabled, listSessions = async () => [], listAgents = async () => [], readSession = async () => null, readPendingRequests = () => ({}), now = Date.now }) {
  /** Inherited cards of the last successful read, per directory: a failed read
   * must not look like "no sessions", so the prior list stands. */
  const inherited = new Map();
  /** Subagent-only agent ids per directory, reused briefly. */
  const subagentAgents = new Map();
  /** sessionId → whether that session is delegated work. Every session the list
   * read covers is answered here for free; a session only a card links is asked
   * about once and remembered, so the board does not re-read it each snapshot.
   * Bounded: the oldest answer goes first, and a forgotten session is unknown
   * again, which shows its card rather than hiding one. */
  const delegated = new Map();

  const rememberDelegated = (session, subagentAgentIds) => {
    const value = isDelegatedSession(session, subagentAgentIds);
    delegated.delete(session.id);
    delegated.set(session.id, value);
    while (delegated.size > DELEGATED_CACHE_LIMIT) delegated.delete(delegated.keys().next().value);
    return value;
  };

  const readSubagentAgentIds = async (directory) => {
    const key = normaliseDirectory(directory);
    const cached = subagentAgents.get(key);
    if (cached && now() - cached.at < SUBAGENT_AGENTS_TTL_MS) return cached.ids;
    try {
      const agents = await listAgents(directory);
      if (!Array.isArray(agents)) throw new Error('Agent list is not a list');
      const ids = new Set(agents.filter(agent => agent?.mode === 'subagent' && agent.id).map(agent => agent.id));
      subagentAgents.set(key, { at: now(), ids });
      return ids;
    } catch {
      // Unknown agent modes hide nothing: the board only hides a card it can
      // prove is delegated work.
      return cached?.ids ?? new Set();
    }
  };

  /**
   * Whether one session is delegated work. An answer the session list already
   * gave stands; a session the list did not cover — a card older than the read,
   * or one of a board whose read failed — is asked about directly, once. An
   * unreadable session is not proof, so its card stays.
   */
  const isDelegated = async (sessionId, directory) => {
    const known = delegated.get(sessionId);
    if (known !== undefined) return known;
    try {
      const session = await readSession(sessionId, directory);
      if (session?.id !== sessionId) throw new Error('Session read did not answer');
      return rememberDelegated(session, await readSubagentAgentIds(directory));
    } catch {
      return false;
    }
  };

  const readInherited = async (directory, includeOlder) => {
    const key = normaliseDirectory(directory);
    try {
      const sessions = await listSessions(directory, { includeOlder });
      if (!Array.isArray(sessions)) throw new Error('Session list is not a list');
      const subagentAgentIds = await readSubagentAgentIds(directory);
      const listed = sessions.filter(session => session?.id);
      const cards = listed.filter(session => !rememberDelegated(session, subagentAgentIds))
        .map(session => inheritedCard(session, directory));
      inherited.set(key, cards);
      return { cards, available: true };
    } catch {
      const previous = inherited.get(key);
      return { cards: previous ?? [], available: previous !== undefined };
    }
  };

  const snapshot = async (directory, { includeOlder = false } = {}) => {
    const stored = (await store.list(directory)).filter(card => normaliseDirectory(card.directory) === normaliseDirectory(directory));
    const sessions = await readInherited(directory, includeOlder);
    // A delegated session is not the user's card: neither an inherited card for
    // it nor a stored card that links it belongs on the board.
    const onBoard = (await Promise.all(stored.map(async card => (
      card.sessionId && await isDelegated(card.sessionId, card.directory) ? null : card
    )))).filter(Boolean);
    const linked = new Set(onBoard.map(card => card.sessionId));
    const cards = [...onBoard, ...sessions.cards.filter(card => !linked.has(card.sessionId))];
    const requests = cards.filter(card => card.sessionId).map(card => ({ sessionId: card.sessionId, directory: card.directory, updatedAt: card.updatedAt }));
    const { activity: live, unavailable, missing } = await activity.read(requests).catch(() => ({ activity: new Map(), unavailable: new Set(), missing: new Set() }));
    let queueSnapshot = null;
    try {
      queueSnapshot = await readQueueSnapshot();
    } catch {
      // A failed queue read leaves the board available with unknown queue state.
    }
    const queueState = queueSnapshot ? queueForDirectory(queueSnapshot, directory) : null;
    // Enablement is its own setting, readable even when the queue snapshot
    // failed: the toggle must still show the saved choice.
    const enabled = readQueueEnabled ? await readQueueEnabled(directory).catch(() => null) : null;
    const queueSessionIds = new Set([
      ...(queueState?.rows ?? []).map(row => row.sessionId),
      ...(queueState?.active ? [queueState.active.sessionId] : []),
      ...(queueState?.forced ?? []).map(item => item.sessionId),
    ]);

    // A session that waits for the user's answer stays `busy` in OpenCode's own
    // status the whole time it waits, so the board would call it working. The
    // ask is a separate fact that survives a failed history read, so it travels
    // beside the activity rather than inside it. Only this board's own sessions
    // are named: the request map is server-wide.
    const pending = readPendingRequests() ?? {};
    const waitingFor = {};
    const noteWaiting = (sessionId) => {
      if (!sessionId || waitingFor[sessionId] !== undefined) return;
      const entry = pending[sessionId];
      if (!entry) return;
      if (entry.forms?.length) waitingFor[sessionId] = 'question';
      else if (entry.permissions?.length) waitingFor[sessionId] = 'permission';
    };
    for (const card of cards) noteWaiting(card.sessionId);
    for (const sessionId of queueSessionIds) noteWaiting(sessionId);

    const lanes = {};
    const order = Object.fromEntries(LANES.map(lane => [lane, []]));
    const placements = {};
    const activities = {};
    const decorated = cards.map(card => {
      const entry = card.sessionId ? live.get(card.sessionId) : undefined;
      const queueOwned = Boolean(card.sessionId) && queueSessionIds.has(card.sessionId);
      const lane = queueOwned ? 'queue' : deriveLane(card, entry);
      if (card.sessionId && entry) activities[card.sessionId] = { busy: entry.busy, messages: entry.messages };
      // A linked session is unavailable when its live status or history could
      // not be read; an unlinked card has no status to be unknown.
      const status = card.sessionId
        ? (unavailable.has(card.sessionId) ? 'unavailable' : entry ? 'known' : 'unknown')
        : 'none';
      lanes[card.id] = lane;
      placements[card.id] = { lane, completedAt: completionTime(card, entry, lane), updatedAt: card.updatedAt, sessionId: card.sessionId };
      return { ...card, lane, status, availableActions: availableActions(card, lane, status, Boolean(entry?.busy), sessions.available) };
    });

    // Order within a lane: the stored placement order where the user set one,
    // Done by newest completion first, and anything unarranged after it.
    for (const lane of CARD_LANES) {
      const inLane = decorated.filter(card => lanes[card.id] === lane);
      if (lane === 'done') inLane.sort((a, b) => placements[b.id].completedAt - placements[a.id].completedAt || a.id.localeCompare(b.id));
      const arranged = inLane.filter(card => card.placementOrder !== undefined)
        .sort((a, b) => (a.placementOrder ?? 0) - (b.placementOrder ?? 0) || a.id.localeCompare(b.id));
      order[lane] = [...arranged, ...inLane.filter(card => card.placementOrder === undefined)].map(card => card.id);
    }

    return {
      directory,
      revision: now(),
      lanes,
      order,
      cards: decorated,
      placements,
      activities,
      waitingFor,
      unavailable: [...unavailable],
      // Sessions OpenCode reported it does not have. The caller prunes their
      // cards; the projection itself only reads.
      missing: [...missing],
      inheritedAvailable: sessions.available,
      queue: queueState
        ? { ...queueState, enabled, known: true }
        : { rows: [], order: [], active: null, forced: [], issue: null, preparation: null, commit: null, enabled, known: false },
    };
  };

  return {
    snapshot,
    /** Drop inherited-card caches: a session was created or removed. */
    invalidateInherited: () => inherited.clear(),
    /** Forget one session's delegation answer: its record changed. */
    forgetDelegated: (sessionId) => delegated.delete(sessionId),
    /** Drop every per-directory cache: the runtime they were read from changed. */
    reset: () => { inherited.clear(); subagentAgents.clear(); delegated.clear(); },
  };
}

/**
 * The wiring boundary: `index.js` builds one and passes `projection` to
 * `registerWorkBoardRoutes`. `readPage` returns a v2 message page
 * (`{ data: SessionMessageInfo[] }`), `readSessions` v2 `SessionInfo[]`,
 * `readActiveSessionIds` the `/api/session/active` map, `listAgents` the
 * directory's agent catalogue (its `mode` says which sessions are delegated
 * work), `readSession` one v2 `SessionInfo` by id, and `readPendingRequests` the
 * permission asks and forms still waiting for an answer by session. A failed
 * session list throws so the projection keeps the previous inherited cards.
 *
 * `processPayload(payload, directoryHint)` is the event lifecycle: call it from
 * the one place translated server payloads flow (next to
 * `sessionWorkRuntime.processPayload`). It returns the directory whose board
 * changed, or null; broadcast `openchamber:work-board.updated` for it. `reset()`
 * drops all caches on a runtime switch.
 */
export function createWorkBoardProjectionRuntime({ store, readPage, readSessions, readActiveSessionIds, readQueueSnapshot, readQueueEnabled, listAgents = async () => [], readSession = async () => null, readPendingRequests, now = Date.now }) {
  const activity = createWorkBoardActivity({
    now,
    listActiveSessionIds: readActiveSessionIds,
    listMessages: readPage,
  });
  const listSessions = (directory, { includeOlder = false } = {}) => readSessions(directory, { includeOlder, recentWindowMs: RECENT_WINDOW_MS });
  const projection = createWorkBoardProjection({ store, activity, listSessions, listAgents, readSession, readQueueSnapshot, readQueueEnabled, readPendingRequests, now });

  /**
   * The projection, with the cards whose session OpenCode has proven deleted
   * pruned in the same read. The projection only reads, so the prune is a store
   * write owned here at the wiring boundary, and the response never carries a
   * card the server just deleted. A failed prune leaves the cards in place and
   * reported unavailable, and the next read tries again.
   */
  const snapshot = async (directory, options) => {
    const result = await projection.snapshot(directory, options);
    if (!result.missing.length) return result;
    const removed = new Set(await store.pruneMissing(result.directory, result.missing).catch(() => []));
    if (!removed.size) return result;
    const cards = result.cards.filter(card => !(card.sessionId && removed.has(card.sessionId)));
    const keep = new Set(cards.map(card => card.id));
    // The pruned cards leave every index with them, so nothing downstream
    // resolves an id this response no longer carries.
    return {
      ...result,
      cards,
      lanes: Object.fromEntries(Object.entries(result.lanes).filter(([id]) => keep.has(id))),
      order: Object.fromEntries(Object.entries(result.order).map(([lane, ids]) => [lane, ids.filter(id => keep.has(id))])),
      placements: Object.fromEntries(Object.entries(result.placements).filter(([id]) => keep.has(id))),
    };
  };

  /** Session events that change a card's lane, activity, status or ask. */
  const sessionIdOf = (payload) => payload?.properties?.sessionID ?? payload?.properties?.info?.sessionID ?? null;
  const processPayload = (payload, directoryHint = '') => {
    const type = payload?.type;
    if (type !== 'session.status' && type !== 'session.idle' && type !== 'message.updated'
      && type !== 'session.created' && type !== 'session.deleted' && type !== 'session.updated'
      // An ask appears and settles as its own events, and the board must follow.
      && type !== 'permission.asked' && type !== 'permission.replied'
      && type !== 'form.created' && type !== 'form.settled') return null;
    const sessionId = sessionIdOf(payload);
    // An ask and its answer leave the session's history and status alone, so
    // those events only ask the board to re-read the ask.
    const askOnly = type === 'permission.asked' || type === 'permission.replied'
      || type === 'form.created' || type === 'form.settled';
    if (sessionId && !askOnly) activity.invalidate(sessionId);
    // A session added or removed changes the inherited card set, and a session
    // whose own record changed is classified again.
    if (type === 'session.created' || type === 'session.deleted') projection.invalidateInherited();
    if (sessionId && (type === 'session.created' || type === 'session.updated' || type === 'session.deleted')) {
      projection.forgetDelegated(sessionId);
    }
    return payload.properties?.directory ?? directoryHint ?? null;
  };

  return { projection: { ...projection, snapshot }, activity, processPayload, reset: () => { activity.reset(); projection.reset(); } };
}
