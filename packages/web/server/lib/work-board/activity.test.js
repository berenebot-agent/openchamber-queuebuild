import { describe, expect, it, vi } from 'vitest';
import { createWorkBoardActivity } from './activity.js';

// Real OpenCode v2 wire records: flat, `type` (not `role`), `time.created`, and
// no `sessionID` on a listed record. The reader supplies the session id.
const page = (...records) => ({ data: records, cursor: {} });
const assistant = (id, agent, created) => ({ id, type: 'assistant', agent, model: { providerID: 'p', id: 'm' }, time: { created } });
const user = (id, created) => ({ id, type: 'user', text: 'hi', time: { created } });
const idle = (id, created, outcome = 'succeeded') => ({ id, type: 'idle', outcome, time: { created } });

describe('work board activity', () => {
  it('maps v2 wire records to the board roles and supplies the session id', async () => {
    const listMessages = vi.fn(async () => page(idle('i', 3), assistant('a', 'build', 2), user('u', 1)));
    const activity = createWorkBoardActivity({
      listMessages,
      listActiveSessionIds: async () => ({ s1: { type: 'busy' } }),
      now: () => 100,
    });
    const { activity: result } = await activity.read([{ sessionId: 's1', directory: '/repo', updatedAt: 2 }]);
    expect(result.get('s1').busy).toBe(true);
    // Newest-first page becomes oldest-first messages, and each carries its own
    // session id and a `role`.
    expect(result.get('s1').messages).toEqual([
      { id: 'u', sessionID: 's1', role: 'user', time: { created: 1 } },
      { id: 'a', sessionID: 's1', role: 'assistant', agent: 'build', model: { providerID: 'p', id: 'm' }, time: { created: 2 } },
      { id: 'i', sessionID: 's1', role: 'idle', outcome: 'succeeded', time: { created: 3 } },
    ]);
  });

  it('ignores wire record types the board does not read', async () => {
    const listMessages = async () => page(
      { id: 'x', type: 'system', time: { created: 1 } },
      { id: 'y', type: 'shell', time: { created: 2 } },
      user('u', 3),
    );
    const activity = createWorkBoardActivity({ listMessages, listActiveSessionIds: async () => ({}), now: () => 100 });
    const { activity: result } = await activity.read([{ sessionId: 's1', directory: '/repo', updatedAt: 1 }]);
    expect(result.get('s1').messages.map(message => message.role)).toEqual(['user']);
  });

  it('keeps a settled session history when its update time has not moved', async () => {
    const listMessages = vi.fn(async () => page(assistant('a', 'build', 2)));
    const activity = createWorkBoardActivity({ listMessages, listActiveSessionIds: async () => ({}), now: () => 100 });
    await activity.read([{ sessionId: 's1', directory: '/repo', updatedAt: 2 }]);
    await activity.read([{ sessionId: 's1', directory: '/repo', updatedAt: 2 }]);
    expect(listMessages).toHaveBeenCalledTimes(1);
    // The settled cache needs the update time; without it, every read refetches.
    await activity.read([{ sessionId: 's1', directory: '/repo', updatedAt: 5 }]);
    expect(listMessages).toHaveBeenCalledTimes(2);
  });

  it('refetches without an update time rather than trusting the cache forever', async () => {
    const listMessages = vi.fn(async () => page(assistant('a', 'build', 2)));
    const activity = createWorkBoardActivity({ listMessages, listActiveSessionIds: async () => ({}), now: () => 100 });
    await activity.read([{ sessionId: 's1', directory: '/repo' }]);
    await activity.read([{ sessionId: 's1', directory: '/repo' }]);
    expect(listMessages).toHaveBeenCalledTimes(2);
  });

  it('re-reads a cached session once its history read failed earlier', async () => {
    let fail = true;
    const listMessages = vi.fn(async () => {
      if (fail) throw new Error('history offline');
      return page(assistant('a', 'build', 2));
    });
    const activity = createWorkBoardActivity({ listMessages, listActiveSessionIds: async () => ({}), now: () => 100 });
    const first = await activity.read([{ sessionId: 's1', directory: '/repo', updatedAt: 2 }]);
    expect(first.unavailable.has('s1')).toBe(true);
    fail = false;
    const second = await activity.read([{ sessionId: 's1', directory: '/repo', updatedAt: 2 }]);
    expect(second.unavailable.size).toBe(0);
    expect(second.activity.get('s1').messages).toHaveLength(1);
  });

  it('reports a session OpenCode no longer has as missing, and a failed read as only unavailable', async () => {
    const notFound = Object.assign(new Error('Session not found: s1'), { _tag: 'SessionNotFoundError', name: 'SessionNotFoundError' });
    const gone = createWorkBoardActivity({
      listMessages: async () => { throw notFound; },
      listActiveSessionIds: async () => ({}),
      now: () => 100,
    });
    const read = await gone.read([{ sessionId: 's1', directory: '/repo', updatedAt: 2 }]);
    // Gone is a subset of unreadable, so a prune that fails still shows an error.
    expect(read.missing.has('s1')).toBe(true);
    expect(read.unavailable.has('s1')).toBe(true);
    const offline = createWorkBoardActivity({
      listMessages: async () => { throw new Error('history offline'); },
      listActiveSessionIds: async () => ({}),
      now: () => 100,
    });
    const offlineRead = await offline.read([{ sessionId: 's1', directory: '/repo', updatedAt: 2 }]);
    expect(offlineRead.unavailable.has('s1')).toBe(true);
    expect(offlineRead.missing.size).toBe(0);
  });

  it('treats a failed live-status read as unknown, never as idle', async () => {
    const activity = createWorkBoardActivity({
      listMessages: async () => page(assistant('a', 'build', 2)),
      listActiveSessionIds: async () => { throw new Error('status offline'); },
      now: () => 100,
    });
    const { activity: result, unavailable } = await activity.read([{ sessionId: 's1', directory: '/repo', updatedAt: 2 }]);
    // History was readable, so the lane can still be derived; the session is
    // reported unavailable because its running state is not known.
    expect(result.get('s1').busy).toBe(false);
    expect(unavailable.has('s1')).toBe(true);
  });

  it('drops one session on invalidate and all of them on reset', async () => {
    const listMessages = vi.fn(async () => page(assistant('a', 'build', 2)));
    const activity = createWorkBoardActivity({ listMessages, listActiveSessionIds: async () => ({}), now: () => 100 });
    await activity.read([{ sessionId: 's1', directory: '/repo', updatedAt: 2 }]);
    activity.invalidate('s1');
    await activity.read([{ sessionId: 's1', directory: '/repo', updatedAt: 2 }]);
    expect(listMessages).toHaveBeenCalledTimes(2);
    activity.reset();
    await activity.read([{ sessionId: 's1', directory: '/repo', updatedAt: 2 }]);
    expect(listMessages).toHaveBeenCalledTimes(3);
  });
});
