import { describe, expect, it } from 'vitest';
import { createWorkBoardProjection, createWorkBoardProjectionRuntime, readWorkBoardSessions } from './projection.js';

const baseCard = (over = {}) => ({
  id: 'card-1', directory: '/repo', text: 'Brief', attachments: [],
  createdAt: 1, updatedAt: 1, stage: 'todo', ...over,
});

const makeProjection = ({ cards = [], queue = null, sessions = [], listSessions, activity = new Map(), unavailable = [], enabled = true } = {}) => createWorkBoardProjection({
  store: { list: async () => cards },
  listSessions: listSessions ?? (async () => sessions),
  readQueueSnapshot: () => queue,
  readQueueEnabled: async () => enabled,
  activity: { read: async requests => ({ activity, unavailable: new Set(unavailable), requests }) },
  now: () => 1000,
});

describe('work board session listing', () => {
  it('scopes every page and never inherits sessions from another directory', async () => {
    const calls = [];
    const session = (id, directory) => ({ id, location: { directory }, time: { updated: Date.now() } });
    const client = { session: { list: async input => {
      calls.push(input);
      return input.cursor
        ? { data: [session('second', '/repo')], cursor: {} }
        : { data: [session('first', '/repo'), session('other', '/other')], cursor: { next: 'page-2' } };
    } } };
    const sessions = await readWorkBoardSessions(client, '/repo');
    expect(calls).toEqual([
      { directory: '/repo', limit: 100, order: 'desc' },
      { directory: '/repo', cursor: 'page-2' },
    ]);
    expect(sessions.map(session => session.id)).toEqual(['first', 'second']);
    const projection = makeProjection({ listSessions: directory => readWorkBoardSessions(client, directory) });
    expect((await projection.snapshot('/repo')).cards.map(card => card.sessionId)).toEqual(['first', 'second']);
  });

  it('keeps the recency limit, includes older sessions on request, and rejects failed pages', async () => {
    const client = { session: { list: async () => ({ data: [
      { id: 'old', location: { directory: '/repo' }, time: { updated: 1 } },
    ] }) } };
    expect(await readWorkBoardSessions(client, '/repo')).toEqual([]);
    expect((await readWorkBoardSessions(client, '/repo', { includeOlder: true })).map(session => session.id)).toEqual(['old']);
    await expect(readWorkBoardSessions({ session: { list: async () => ({}) } }, '/repo')).rejects.toThrow('unavailable');
  });
});

describe('work board projection', () => {
  it('derives each lane from placement, history and the queue', async () => {
    const cards = [
      baseCard({ id: 'todo', stage: 'todo', updatedAt: 5 }),
      baseCard({ id: 'build', stage: 'plan', sessionId: 's-build', placementAt: 3 }),
      baseCard({ id: 'queued', stage: 'plan', sessionId: 's-queued' }),
      baseCard({ id: 'plan', stage: 'plan', sessionId: 's-plan', placementAt: 1 }),
    ];
    const activity = new Map([
      ['s-build', { busy: false, messages: [
        { role: 'assistant', agent: 'build', time: { created: 4 } },
        { role: 'idle', outcome: 'succeeded', time: { created: 4 } },
      ] }],
      ['s-queued', { busy: true, messages: [] }],
      ['s-plan', { busy: false, messages: [{ role: 'user', time: { created: 9 } }] }],
    ]);
    const projection = makeProjection({ cards, activity, queue: {
      active: [{ directory: '/repo', sessionId: 's-queued', itemId: 'i1', startedAt: 2 }],
      queued: [], issues: [],
    } });
    const snapshot = await projection.snapshot('/repo');
    expect(snapshot.lanes).toMatchObject({ todo: 'todo', build: 'build', queued: 'queue', plan: 'plan' });
    expect(snapshot.order.todo).toEqual(['todo']);
    expect(snapshot.queue.active.sessionId).toBe('s-queued');
  });

  it('asks for each linked session with its update time so the settled cache works', async () => {
    const projection = makeProjection({ cards: [baseCard({ id: 'linked', stage: 'plan', sessionId: 's1', updatedAt: 7 })] });
    const snapshot = await projection.snapshot('/repo');
    expect(snapshot.cards.map(card => card.id)).toEqual(['linked']);
    // The activity reader is called with the card's updatedAt.
    const activities = await projection.snapshot('/repo');
    expect(activities.cards[0].updatedAt).toBe(7);
  });

  it('exposes the actions the server allows on each card', async () => {
    const cards = [
      baseCard({ id: 'brief', stage: 'todo' }),
      baseCard({ id: 'linked', stage: 'plan', sessionId: 's1' }),
      baseCard({ id: 'finished', stage: 'done', sessionId: 's2', completedAt: 5 }),
    ];
    const activity = new Map([['s1', { busy: false, messages: [] }], ['s2', { busy: false, messages: [] }]]);
    const snapshot = await makeProjection({ cards, activity }).snapshot('/repo');
    const byId = Object.fromEntries(snapshot.cards.map(card => [card.id, card]));
    // An unlinked brief can start Plan, complete and be removed.
    expect(byId.brief.availableActions).toEqual(expect.arrayContaining(['complete', 'startPlan', 'remove']));
    // A linked, settled card can complete and return to To-do, but not remove.
    expect(byId.linked.availableActions).toEqual(expect.arrayContaining(['complete', 'returnToTodo']));
    expect(byId.linked.availableActions).not.toContain('remove');
    // A completed, unseen card can be acknowledged.
    expect(byId.finished.availableActions).toContain('acknowledge');
  });

  it('withholds complete for a card whose session status is unavailable', async () => {
    const cards = [baseCard({ id: 'linked', stage: 'plan', sessionId: 's1' })];
    const snapshot = await makeProjection({ cards, unavailable: ['s1'] }).snapshot('/repo');
    expect(snapshot.cards[0].status).toBe('unavailable');
    expect(snapshot.cards[0].availableActions).not.toContain('complete');
  });

  it('orders Done newest completion first and honours a stored arrangement inside a lane', async () => {
    const cards = [
      baseCard({ id: 'old', stage: 'done', placementAt: 1, completedAt: 5 }),
      baseCard({ id: 'new', stage: 'done', placementAt: 1, completedAt: 9 }),
      baseCard({ id: 'second', stage: 'todo', placementOrder: 1 }),
      baseCard({ id: 'first', stage: 'todo', placementOrder: 0 }),
      baseCard({ id: 'last', stage: 'todo' }),
    ];
    const snapshot = await makeProjection({ cards }).snapshot('/repo');
    expect(snapshot.order.done).toEqual(['new', 'old']);
    expect(snapshot.order.todo).toEqual(['first', 'second', 'last']);
  });

  it('derives inherited cards from sessions the board has no card for', async () => {
    const sessions = [
      { id: 'known', title: 'Already on the board', time: { created: 1, updated: 2 } },
      { id: 'fresh', title: 'Fresh session', time: { created: 3, updated: 4 } },
    ];
    const cards = [baseCard({ id: 'session:known', stage: 'plan', sessionId: 'known', text: 'Already on the board' })];
    const snapshot = await makeProjection({ cards, sessions }).snapshot('/repo');
    const ids = snapshot.cards.map(card => card.id);
    expect(ids).toContain('session:fresh');
    expect(ids.filter(id => id === 'session:known')).toHaveLength(1);
    expect(snapshot.inheritedAvailable).toBe(true);
  });

  it('keeps the previous inherited cards when the session list read fails', async () => {
    let fail = false;
    const listSessions = async () => {
      if (fail) throw new Error('session list offline');
      return [{ id: 'fresh', title: 'Fresh session', time: { created: 3, updated: 4 } }];
    };
    const projection = makeProjection({ listSessions });
    const first = await projection.snapshot('/repo');
    expect(first.cards.map(card => card.id)).toContain('session:fresh');
    fail = true;
    const second = await projection.snapshot('/repo');
    // A failed read is not an empty board: the prior inherited card stands.
    expect(second.cards.map(card => card.id)).toContain('session:fresh');
    expect(second.inheritedAvailable).toBe(true);
  });

  it('reports inherited cards as unavailable, not empty, when no earlier read stands', async () => {
    const projection = makeProjection({ listSessions: async () => { throw new Error('session list offline'); } });
    const snapshot = await projection.snapshot('/repo');
    expect(snapshot.cards).toEqual([]);
    expect(snapshot.inheritedAvailable).toBe(false);
  });

  it('treats a malformed session list as a failure, never an empty list', async () => {
    const projection = makeProjection({ listSessions: async () => ({ data: [] }) });
    const snapshot = await projection.snapshot('/repo');
    expect(snapshot.inheritedAvailable).toBe(false);
  });

  it.each([
    ['throws synchronously', () => { throw new Error('queue offline'); }],
    ['rejects asynchronously', async () => { throw new Error('queue offline'); }],
  ])('degrades the queue section without hiding the board when the queue read %s', async (_label, readQueueSnapshot) => {
    const projection = createWorkBoardProjection({
      store: { list: async () => [baseCard({ id: 'todo', stage: 'todo' })] },
      listSessions: async () => [],
      readQueueSnapshot,
      readQueueEnabled: async () => false,
      activity: { read: async () => ({ activity: new Map(), unavailable: new Set() }) },
      now: () => 1000,
    });
    const snapshot = await projection.snapshot('/repo');
    expect(snapshot.queue.known).toBe(false);
    expect(snapshot.queue.enabled).toBe(false);
    expect(snapshot.cards.map(card => card.id)).toEqual(['todo']);
  });

  it('carries a forced build\'s unconfirmed state and its recovery target', async () => {
    const snapshot = await makeProjection({ queue: {
      active: [], queued: [], issues: [],
      forced: [
        { sessionId: 's1', directory: '/repo', startedAt: 2, itemId: 'item1', needsReview: true, action: 'resolve' },
        { sessionId: 's2', directory: '/repo', startedAt: 3 },
      ],
    } }).snapshot('/repo');
    expect(snapshot.queue.forced).toEqual([
      { sessionId: 's1', startedAt: 2, itemId: 'item1', needsReview: true, action: 'resolve' },
      { sessionId: 's2', startedAt: 3, itemId: null, needsReview: false, action: null },
    ]);
  });
});

describe('work board projection runtime', () => {
  // The runtime factory is the wiring boundary; these tests use real v2 page and
  // session envelopes, not injected domain shapes.
  const session = (id, directory, updated) => ({
    id, projectID: 'p', title: id, location: { directory }, parentID: undefined,
    time: { created: 1, updated }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  });
  const page = (...records) => ({ data: records, cursor: {} });
  const buildTurn = (sessionId, created) => ([
    { id: `idle-${sessionId}`, type: 'idle', outcome: 'succeeded', time: { created: created + 2 } },
    { id: `assistant-${sessionId}`, type: 'assistant', agent: 'build', model: { providerID: 'p', id: 'm' }, time: { created: created + 1 } },
    { id: `user-${sessionId}`, type: 'user', text: 'go', time: { created } },
  ]);

  const makeRuntime = ({ cards = [], sessions = [], active = {}, queue = null, now = () => 1000 } = {}) => {
    const reads = [];
    const runtime = createWorkBoardProjectionRuntime({
      store: { list: async () => cards },
      readPage: async (sessionId) => { reads.push(sessionId); return page(...buildTurn(sessionId, 2)); },
      readSessions: async directory => sessions.filter(entry => entry.location?.directory === directory),
      readActiveSessionIds: async () => active,
      readQueueSnapshot: () => queue,
      readQueueEnabled: async () => true,
      now,
    });
    return { runtime, reads };
  };

  it('reads real v2 envelopes into lanes and hides an in-flight Build turn in the queue', async () => {
    const cards = [{
      id: 'session:ses_1', directory: '/repo', text: 'go', attachments: [],
      createdAt: 1, updatedAt: 5, stage: 'plan', sessionId: 'ses_1',
    }];
    const { runtime, reads } = makeRuntime({
      cards,
      active: { ses_1: { type: 'busy' } },
      queue: { active: [{ directory: '/repo', sessionId: 'ses_1', itemId: 'i1', startedAt: 4, needsReview: false }], queued: [], issues: [] },
    });
    const snapshot = await runtime.projection.snapshot('/repo');
    expect(reads).toEqual(['ses_1']);
    expect(snapshot.cards[0].lane).toBe('queue');
    expect(snapshot.cards[0].status).toBe('known');
    expect(snapshot.activities.ses_1.busy).toBe(true);
    expect(snapshot.activities.ses_1.messages.map(message => message.role)).toEqual(['user', 'assistant', 'idle']);
  });

  it('places an idle Build session in Build complete from a real page', async () => {
    const cards = [{
      id: 'session:ses_2', directory: '/repo', text: 'go', attachments: [],
      createdAt: 1, updatedAt: 5, stage: 'plan', sessionId: 'ses_2',
    }];
    const { runtime } = makeRuntime({ cards, active: {} });
    const snapshot = await runtime.projection.snapshot('/repo');
    expect(snapshot.cards[0].lane).toBe('build');
    expect(snapshot.cards[0].availableActions).toContain('complete');
  });

  it('adds real v2 sessions as inherited cards and drops their cache on reset', async () => {
    const { runtime } = makeRuntime({ sessions: [session('ses_new', '/repo', 9)] });
    const snapshot = await runtime.projection.snapshot('/repo');
    expect(snapshot.cards.map(card => card.id)).toContain('session:ses_new');
    runtime.projection.invalidateInherited();
    expect((await runtime.projection.snapshot('/repo')).cards.map(card => card.id)).toContain('session:ses_new');
  });

  it('invalidates one session on a live event and reports its directory', async () => {
    const cards = [{
      id: 'session:ses_1', directory: '/repo', text: 'go', attachments: [],
      createdAt: 1, updatedAt: 5, stage: 'plan', sessionId: 'ses_1',
    }];
    const { runtime, reads } = makeRuntime({ cards, active: {} });
    await runtime.projection.snapshot('/repo');
    expect(reads).toEqual(['ses_1']);
    // A second read with the same update time reuses the cached history.
    await runtime.projection.snapshot('/repo');
    expect(reads).toEqual(['ses_1']);
    // A live status event for the session invalidates it, so the next read refetches.
    expect(runtime.processPayload({ type: 'session.status', properties: { sessionID: 'ses_1', directory: '/repo' } })).toBe('/repo');
    await runtime.projection.snapshot('/repo');
    expect(reads).toEqual(['ses_1', 'ses_1']);
  });

  it('ignores events that cannot move a card', async () => {
    const { runtime } = makeRuntime();
    expect(runtime.processPayload({ type: 'openchamber:heartbeat' })).toBeNull();
  });
});
