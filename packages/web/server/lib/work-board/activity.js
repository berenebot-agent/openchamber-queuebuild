/**
 * Live activity for work board cards, owned by the server: one answer per
 * session for "is a turn running" and "what did the last turn do", read once
 * rather than polled by every browser. Reliability is per session — a failed
 * status or history read makes that session unavailable, never settled.
 */

const IDLE = 'idle';
const USER = 'user';
const ASSISTANT = 'assistant';

/**
 * One wire record (OpenCode v2 `SessionMessageInfo`) as the board's rules need
 * it. v2 records are flat and use `type`, not `role`; `sessionID` is not on a
 * listed record, so the reader supplies it.
 */
function summarize(record, sessionID) {
  const type = record?.type;
  if (type !== USER && type !== IDLE && type !== ASSISTANT) return null;
  const base = { id: String(record.id ?? ''), sessionID, time: { created: Number(record.time?.created) || 0 } };
  if (type === USER) return { ...base, role: USER };
  if (type === IDLE) return { ...base, role: IDLE, outcome: record.outcome };
  return { ...base, role: ASSISTANT, agent: String(record.agent ?? ''), model: record.model };
}

/** Newest-first page from `message.list` → the board's oldest-first messages. */
const toMessages = (records, sessionID) => {
  const list = Array.isArray(records) ? records : [];
  return list.map(record => summarize(record, sessionID)).filter(Boolean).reverse();
};

export function createWorkBoardActivity({ listMessages, listActiveSessionIds, now = Date.now }) {
  // sessionId → { messages, updatedAt, failed }: the last history read, the
  // session's update time when it was read, and whether that read failed.
  const entries = new Map();

  /**
   * Read live status once and reconcile every requested session against it.
   * Returns `{ activity, unavailable }`; `unavailable` names sessions whose
   * status or history could not be read this round.
   */
  const read = async (requests) => {
    const result = new Map();
    const unavailable = new Set();
    if (!requests.length) return { activity: result, unavailable };
    // A failed status read is unknown, never idle: a busy session must not read
    // as settled. Every session this round is unavailable when status is null.
    const active = await listActiveSessionIds().catch(() => null);
    await Promise.all(requests.map(async ({ sessionId, directory, updatedAt }) => {
      if (!sessionId) return;
      try {
        const busy = active !== null && Boolean(active[sessionId]);
        const cached = entries.get(sessionId);
        // A settled session whose update time has not moved keeps its history.
        const settled = cached && !busy && !cached.failed && updatedAt !== undefined && cached.updatedAt === updatedAt;
        if (settled) {
          result.set(sessionId, { busy: false, messages: cached.messages });
          if (active === null) unavailable.add(sessionId);
          return;
        }
        const page = await listMessages(sessionId, directory);
        const messages = toMessages(page?.data, sessionId);
        entries.set(sessionId, { messages, updatedAt: updatedAt ?? now(), failed: false });
        result.set(sessionId, { busy, messages });
        if (active === null) unavailable.add(sessionId);
      } catch {
        const cached = entries.get(sessionId);
        if (cached) entries.set(sessionId, { ...cached, failed: true });
        unavailable.add(sessionId);
      }
    }));
    return { activity: result, unavailable };
  };

  /** Drop one session's cached history so the next read re-fetches it. */
  const invalidate = (sessionId) => { entries.delete(sessionId); };

  /** Drop everything for a runtime switch: another server's history is not ours. */
  const reset = () => entries.clear();

  return { read, invalidate, reset };
}
