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
    })),
    order: queued.map(item => item.id),
    active: active ? {
      sessionId: active.sessionId, itemId: active.itemId, startedAt: active.startedAt,
      needsReview: Boolean(active.needsReview), retryAvailable: Boolean(active.retryAvailable),
    } : null,
    forced: forced.map(item => ({
      sessionId: item.sessionId, startedAt: item.startedAt,
      itemId: item.itemId ?? null, needsReview: Boolean(item.needsReview),
      action: item.needsReview ? (item.action ?? 'resolve') : null,
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

export function createWorkBoardProjection({ store, activity, readQueueSnapshot, readQueueEnabled, listSessions = async () => [], now = Date.now }) {
  /** Inherited cards of the last successful read, per directory: a failed read
   * must not look like "no sessions", so the prior list stands. */
  const inherited = new Map();

  const readInherited = async (directory, includeOlder) => {
    const key = normaliseDirectory(directory);
    try {
      const sessions = await listSessions(directory, { includeOlder });
      if (!Array.isArray(sessions)) throw new Error('Session list is not a list');
      const cards = sessions.filter(session => session?.id).map(session => inheritedCard(session, directory));
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
    const linked = new Set(stored.map(card => card.sessionId));
    const cards = [...stored, ...sessions.cards.filter(card => !linked.has(card.sessionId))];
    const requests = cards.filter(card => card.sessionId).map(card => ({ sessionId: card.sessionId, directory: card.directory, updatedAt: card.updatedAt }));
    const { activity: live, unavailable } = await activity.read(requests).catch(() => ({ activity: new Map(), unavailable: new Set() }));
    const queueSnapshot = await readQueueSnapshot().catch(() => null);
    const queueState = queueSnapshot ? queueForDirectory(queueSnapshot, directory) : null;
    // Enablement is its own setting, readable even when the queue snapshot
    // failed: the toggle must still show the saved choice.
    const enabled = readQueueEnabled ? await readQueueEnabled(directory).catch(() => null) : null;
    const queueSessionIds = new Set([
      ...(queueState?.rows ?? []).map(row => row.sessionId),
      ...(queueState?.active ? [queueState.active.sessionId] : []),
      ...(queueState?.forced ?? []).map(item => item.sessionId),
    ]);

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
      unavailable: [...unavailable],
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
  };
}

/**
 * The wiring boundary: `index.js` builds one and passes `projection` to
 * `registerWorkBoardRoutes`. `readPage` returns a v2 message page
 * (`{ data: SessionMessageInfo[] }`), `readSessions` v2 `SessionInfo[]`, and
 * `readActiveSessionIds` the `/api/session/active` map. A failed session list
 * throws so the projection keeps the previous inherited cards.
 *
 * `processPayload(payload, directoryHint)` is the event lifecycle: call it from
 * the one place translated server payloads flow (next to
 * `sessionWorkRuntime.processPayload`). It returns the directory whose board
 * changed, or null; broadcast `openchamber:work-board.updated` for it. `reset()`
 * drops all caches on a runtime switch.
 */
export function createWorkBoardProjectionRuntime({ store, readPage, readSessions, readActiveSessionIds, readQueueSnapshot, readQueueEnabled, now = Date.now }) {
  const activity = createWorkBoardActivity({
    now,
    listActiveSessionIds: readActiveSessionIds,
    listMessages: readPage,
  });
  const listSessions = (directory, { includeOlder = false } = {}) => readSessions(directory, { includeOlder, recentWindowMs: RECENT_WINDOW_MS });
  const projection = createWorkBoardProjection({ store, activity, listSessions, readQueueSnapshot, readQueueEnabled, now });

  /** Session events that change a card's lane, activity or status. */
  const sessionIdOf = (payload) => payload?.properties?.sessionID ?? payload?.properties?.info?.sessionID ?? null;
  const processPayload = (payload, directoryHint = '') => {
    const type = payload?.type;
    if (type !== 'session.status' && type !== 'session.idle' && type !== 'message.updated'
      && type !== 'session.created' && type !== 'session.deleted' && type !== 'session.updated') return null;
    const sessionId = sessionIdOf(payload);
    if (sessionId) activity.invalidate(sessionId);
    // A session added or removed changes the inherited card set.
    if (type === 'session.created' || type === 'session.deleted') projection.invalidateInherited();
    return payload.properties?.directory ?? directoryHint ?? null;
  };

  return { projection, activity, processPayload, reset: () => activity.reset() };
}
