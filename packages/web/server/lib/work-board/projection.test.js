import { describe, expect, it } from 'vitest';
import { createWorkBoardProjection, createWorkBoardProjectionRuntime, readWorkBoardSessions } from './projection.js';

const baseCard = (over = {}) => ({
  id: 'card-1', directory: '/repo', text: 'Brief', attachments: [],
  createdAt: 1, updatedAt: 1, stage: 'todo', ...over,
});

const makeProjection = ({ cards = [], queue = null, sessions = [], listSessions, activity = new Map(), unavailable = [], missing = [], enabled = true, pending = {}, listAgents, readSession } = {}) => createWorkBoardProjection({
  store: { list: async () => cards },
  listSessions: listSessions ?? (async () => sessions),
  listAgents,
  readSession,
  readQueueSnapshot: () => queue,
  readQueueEnabled: async () => enabled,
  readPendingRequests: () => pending,
  activity: { read: async requests => ({ activity, unavailable: new Set(unavailable), missing: new Set(missing), requests }) },
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

  it('returns child sessions to the caller, which leaves them off the board', async () => {
    const session = (id, over = {}) => ({ id, location: { directory: '/repo' }, time: { updated: Date.now() }, ...over });
    const client = { session: { list: async () => ({ data: [
      session('root'),
      session('child', { parentID: 'root' }),
    ] }) } };
    expect((await readWorkBoardSessions(client, '/repo')).map(session => session.id)).toEqual(['root', 'child']);
    const projection = makeProjection({ listSessions: directory => readWorkBoardSessions(client, directory) });
    expect((await projection.snapshot('/repo')).cards.map(card => card.sessionId)).toEqual(['root']);
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

  it('carries the sessions OpenCode says it does not have into the snapshot, still unsettled', async () => {
    const cards = [baseCard({ id: 'linked', stage: 'plan', sessionId: 's1' })];
    const snapshot = await makeProjection({ cards, unavailable: ['s1'], missing: ['s1'] }).snapshot('/repo');
    // The projection only reads: it names the missing session and leaves the
    // prune to its caller.
    expect(snapshot.missing).toEqual(['s1']);
    expect(snapshot.unavailable).toEqual(['s1']);
    expect(snapshot.cards[0].availableActions).not.toContain('complete');
  });

  it('names the ask each of its own sessions waits on, and no one else\'s', async () => {
    const cards = [
      baseCard({ id: 'asked', stage: 'plan', sessionId: 's-asked' }),
      baseCard({ id: 'blocked', stage: 'plan', sessionId: 's-blocked' }),
      baseCard({ id: 'settled', stage: 'plan', sessionId: 's-settled' }),
    ];
    const snapshot = await makeProjection({ cards, pending: {
      's-asked': { permissions: [], forms: [{ id: 'q1' }] },
      's-blocked': { permissions: [{ id: 'p1' }], forms: [] },
      's-settled': { permissions: [], forms: [] },
      's-elsewhere': { permissions: [], forms: [{ id: 'q2' }] },
    } }).snapshot('/repo');
    // Only this board's sessions: the request map is server-wide.
    expect(snapshot.waitingFor).toEqual({ 's-asked': 'question', 's-blocked': 'permission' });
  });

  it('names a waiting session the board has no card for when the queue owns it', async () => {
    const snapshot = await makeProjection({
      pending: { 's-lease': { permissions: [], forms: [{ id: 'q1' }] } },
      queue: { active: [{ directory: '/repo', sessionId: 's-lease', itemId: 'i1', startedAt: 2 }], queued: [], issues: [] },
    }).snapshot('/repo');
    expect(snapshot.waitingFor).toEqual({ 's-lease': 'question' });
  });

  it('keeps the ask when the session history read failed', async () => {
    const cards = [baseCard({ id: 'asked', stage: 'plan', sessionId: 's-asked' })];
    const snapshot = await makeProjection({ cards, unavailable: ['s-asked'], pending: {
      's-asked': { permissions: [], forms: [{ id: 'q1' }] },
    } }).snapshot('/repo');
    expect(snapshot.cards[0].status).toBe('unavailable');
    expect(snapshot.activities['s-asked']).toBeUndefined();
    expect(snapshot.waitingFor).toEqual({ 's-asked': 'question' });
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

  it('orders Build complete newest finish first, under a dragged arrangement', async () => {
    const cards = [
      baseCard({ id: 'slow', stage: 'plan', sessionId: 's-slow' }),
      baseCard({ id: 'quick', stage: 'plan', sessionId: 's-quick' }),
      baseCard({ id: 'pinned', stage: 'plan', sessionId: 's-pinned', placementOrder: 0 }),
    ];
    const settledTurn = (created) => [
      { role: 'user', time: { created } },
      { role: 'assistant', agent: 'build', time: { created: created + 1 } },
      { role: 'idle', outcome: 'succeeded', time: { created: created + 2 } },
    ];
    const activity = new Map([
      ['s-slow', { busy: false, messages: settledTurn(4) }],
      ['s-quick', { busy: false, messages: settledTurn(20) }],
      ['s-pinned', { busy: false, messages: settledTurn(1) }],
    ]);
    const snapshot = await makeProjection({ cards, activity }).snapshot('/repo');
    // The newest settled turn leads; the dragged card stays above the sort.
    expect(snapshot.order.build).toEqual(['pinned', 'quick', 'slow']);
  });

  it('orders a Build complete card with no readable activity by its last change', async () => {
    const cards = [
      // A parked completion with no live session: history cannot say when it
      // finished, so its own last change is the newest thing the board knows.
      baseCard({ id: 'offline', stage: 'done', sessionId: 's-offline', updatedAt: 50 }),
      baseCard({ id: 'known', stage: 'plan', sessionId: 's-known' }),
    ];
    const activity = new Map([['s-known', { busy: false, messages: [
      { role: 'assistant', agent: 'build', time: { created: 10 } },
      { role: 'idle', outcome: 'succeeded', time: { created: 11 } },
    ] }]]);
    const snapshot = await makeProjection({ cards, activity }).snapshot('/repo');
    expect(snapshot.order.build).toEqual(['offline', 'known']);
  });

  it('holds the Plan lane in session-start order when the session list churns', async () => {
    // OpenCode serves the session list newest update first, so a streaming
    // planning session leads it; the board must not carry that into the lane.
    const older = { id: 'older', title: 'Older', time: { created: 100, updated: 500 } };
    const newer = { id: 'newer', title: 'Newer', time: { created: 200, updated: 300 } };
    let listed = [older, newer];
    const projection = makeProjection({ listSessions: async () => listed });
    expect((await projection.snapshot('/repo')).order.plan).toEqual(['session:newer', 'session:older']);
    listed = [newer, older];
    expect((await projection.snapshot('/repo')).order.plan).toEqual(['session:newer', 'session:older']);
  });

  it('still puts a dragged Plan card above the start order', async () => {
    const cards = [baseCard({ id: 'pinned', stage: 'plan', sessionId: 'older', placementOrder: 0 })];
    const sessions = [
      { id: 'older', title: 'Older', time: { created: 100, updated: 500 } },
      { id: 'newer', title: 'Newer', time: { created: 200, updated: 300 } },
    ];
    const snapshot = await makeProjection({ cards, sessions }).snapshot('/repo');
    expect(snapshot.order.plan).toEqual(['pinned', 'session:newer']);
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
      activity: { read: async () => ({ activity: new Map(), unavailable: new Set(), missing: new Set() }) },
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
        { sessionId: 's1', directory: '/repo', startedAt: 2, itemId: 'item1', needsReview: true, action: 'resolve', content: 'fix it', model: { providerID: 'anthropic', id: 'claude' } },
        { sessionId: 's2', directory: '/repo', startedAt: 3 },
      ],
    } }).snapshot('/repo');
    expect(snapshot.queue.forced).toEqual([
      { sessionId: 's1', startedAt: 2, itemId: 'item1', needsReview: true, action: 'resolve', content: 'fix it', model: { providerID: 'anthropic', id: 'claude' } },
      { sessionId: 's2', startedAt: 3, itemId: null, needsReview: false, action: null, content: null, model: null },
    ]);
  });

  it('projects an adopted live build without a queue item', async () => {
    const snapshot = await makeProjection({ queue: {
      active: [{ directory: '/repo', sessionId: 's-run', startedAt: 5, adopted: true }],
      queued: [], issues: [],
    } }).snapshot('/repo');
    expect(JSON.parse(JSON.stringify(snapshot)).queue.active).toEqual({
      sessionId: 's-run', itemId: null, startedAt: 5,
      needsReview: false, retryAvailable: false, content: null, model: null,
    });
  });

  it('carries the submitted model and the build message for queue cards', async () => {
    const snapshot = await makeProjection({ queue: {
      active: [{ directory: '/repo', sessionId: 's-run', itemId: 'i-run', startedAt: 5, content: 'running task', model: { providerID: 'anthropic', id: 'claude' } }],
      queued: [{ id: 'i-wait', sessionId: 's-wait', directory: '/repo', content: 'waiting task', createdAt: 1, paused: false, model: { providerID: 'openai', id: 'gpt' } }],
      issues: [],
    } }).snapshot('/repo');
    expect(snapshot.queue.rows).toEqual([
      { itemId: 'i-wait', sessionId: 's-wait', directory: '/repo', content: 'waiting task', paused: false, position: 0, model: { providerID: 'openai', id: 'gpt' } },
    ]);
    expect(snapshot.queue.active).toMatchObject({ content: 'running task', model: { providerID: 'anthropic', id: 'claude' } });
  });

  it('leaves a session delegated to a subagent-only agent off the board, saved card included', async () => {
    const cards = [
      baseCard({ id: 'mine', stage: 'plan', sessionId: 's-mine' }),
      baseCard({ id: 'theirs', stage: 'done', sessionId: 's-delegated' }),
    ];
    const sessions = [
      { id: 's-mine', agent: 'build', time: { updated: 5 } },
      { id: 's-delegated', agent: 'explore', time: { updated: 5 } },
      { id: 's-other-delegated', agent: 'explore', time: { updated: 5 } },
    ];
    const snapshot = await makeProjection({ cards, sessions, listAgents: async () => [
      { id: 'build', mode: 'primary' }, { id: 'explore', mode: 'subagent' },
    ] }).snapshot('/repo');
    // The inherited card for the delegated session is never built, and the saved
    // card that links one is not rendered with it.
    expect(snapshot.cards.map(card => card.id)).toEqual(['mine']);
    expect(snapshot.lanes.theirs).toBeUndefined();
  });

  it('hides nothing when the agent catalogue cannot be read', async () => {
    const cards = [baseCard({ id: 'theirs', stage: 'plan', sessionId: 's-delegated' })];
    const sessions = [{ id: 's-delegated', agent: 'explore', time: { updated: 5 } }];
    const snapshot = await makeProjection({ cards, sessions, listAgents: async () => { throw new Error('offline'); } }).snapshot('/repo');
    // Unknown agent modes are not proof of delegated work: the card stays.
    expect(snapshot.cards.map(card => card.id)).toEqual(['theirs']);
  });

  it('asks the session itself about a card the session list did not cover, once', async () => {
    const cards = [baseCard({ id: 'beyond', stage: 'done', sessionId: 's-beyond' })];
    const asked = [];
    const projection = makeProjection({
      cards,
      listAgents: async () => [{ id: 'explore', mode: 'subagent' }],
      readSession: async (sessionId) => { asked.push(sessionId); return { id: sessionId, agent: 'explore' }; },
    });
    expect((await projection.snapshot('/repo')).cards).toEqual([]);
    expect((await projection.snapshot('/repo')).cards).toEqual([]);
    // The board reads the session list every snapshot; it does not ask again
    // about a session whose answer it already has.
    expect(asked).toEqual(['s-beyond']);
  });

  it('keeps the card of a session it could not read', async () => {
    const cards = [baseCard({ id: 'beyond', stage: 'plan', sessionId: 's-beyond' })];
    const snapshot = await makeProjection({
      cards,
      listAgents: async () => [{ id: 'explore', mode: 'subagent' }],
      readSession: async () => { throw new Error('OpenCode is offline'); },
    }).snapshot('/repo');
    // An unreadable session is not proof of delegated work.
    expect(snapshot.cards.map(card => card.id)).toEqual(['beyond']);
  });
});

describe('work board projection runtime', () => {
  // The runtime factory is the wiring boundary; these tests use real v2 page and
  // session envelopes, not injected domain shapes.
  const session = (id, directory, updated, over = {}) => ({
    id, projectID: 'p', title: id, location: { directory }, parentID: undefined,
    time: { created: 1, updated }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...over,
  });
  const page = (...records) => ({ data: records, cursor: {} });
  const buildTurn = (sessionId, created) => ([
    { id: `idle-${sessionId}`, type: 'idle', outcome: 'succeeded', time: { created: created + 2 } },
    { id: `assistant-${sessionId}`, type: 'assistant', agent: 'build', model: { providerID: 'p', id: 'm' }, time: { created: created + 1 } },
    { id: `user-${sessionId}`, type: 'user', text: 'go', time: { created } },
  ]);

  const makeRuntime = ({ cards = [], sessions = [], sessionRecords = {}, active = {}, queue = null, pending = () => ({}), agents = [], now = () => 1000, readPage } = {}) => {
    const reads = [];
    const prunes = [];
    const agentReads = [];
    const sessionReads = [];
    let live = cards;
    const runtime = createWorkBoardProjectionRuntime({
      store: {
        list: async () => live,
        pruneMissing: async (directory, sessionIds) => {
          prunes.push([directory, sessionIds]);
          live = live.filter(card => !(card.sessionId && sessionIds.includes(card.sessionId)));
          return sessionIds;
        },
      },
      readPage: readPage ?? (async sessionId => { reads.push(sessionId); return page(...buildTurn(sessionId, 2)); }),
      readSessions: async directory => sessions.filter(entry => entry.location?.directory === directory),
      listAgents: async (directory) => { agentReads.push(directory); return agents; },
      readSession: async (sessionId) => { sessionReads.push(sessionId); return sessionRecords[sessionId] ?? null; },
      readActiveSessionIds: async () => active,
      readQueueSnapshot: () => queue,
      readQueueEnabled: async () => true,
      readPendingRequests: pending,
      now,
    });
    return { runtime, reads, prunes, agentReads, sessionReads };
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

  it('prunes the card of a session OpenCode no longer has, and never returns it', async () => {
    const cards = [{
      id: 'gone', directory: '/repo', text: 'test', attachments: [],
      createdAt: 1, updatedAt: 5, stage: 'plan', sessionId: 'ses_gone',
    }];
    const notFound = Object.assign(new Error('Session not found: ses_gone'), { _tag: 'SessionNotFoundError', name: 'SessionNotFoundError' });
    const { runtime, prunes } = makeRuntime({ cards, readPage: async () => { throw notFound; } });
    const snapshot = await runtime.projection.snapshot('/repo');
    expect(prunes).toEqual([['/repo', ['ses_gone']]]);
    // The card leaves every index with it, so the response is coherent.
    expect(snapshot.cards).toEqual([]);
    expect(snapshot.lanes).toEqual({});
    expect(snapshot.placements).toEqual({});
    expect(snapshot.order).toEqual({ todo: [], plan: [], queue: [], build: [], done: [] });
    expect(snapshot.missing).toEqual(['ses_gone']);
    // The prune is durable, so the next read has no card left to prune.
    expect((await runtime.projection.snapshot('/repo')).cards).toEqual([]);
    expect(prunes).toHaveLength(1);
  });

  it('keeps the card of a session whose read merely failed, reporting it unavailable', async () => {
    const cards = [{
      id: 'linked', directory: '/repo', text: 'go', attachments: [],
      createdAt: 1, updatedAt: 5, stage: 'plan', sessionId: 'ses_1',
    }];
    const { runtime, prunes } = makeRuntime({ cards, readPage: async () => { throw new Error('OpenCode is offline'); } });
    const snapshot = await runtime.projection.snapshot('/repo');
    // A failed read is not a deleted session: the card stays and reads as the
    // error it is.
    expect(prunes).toEqual([]);
    expect(snapshot.missing).toEqual([]);
    expect(snapshot.cards).toHaveLength(1);
    expect(snapshot.cards[0].status).toBe('unavailable');
  });

  it('never cards a delegated session, however the board learned about it', async () => {
    const cards = [
      { id: 'mine', directory: '/repo', text: 'mine', attachments: [], createdAt: 1, updatedAt: 5, stage: 'plan', sessionId: 'ses_root' },
      { id: 'mine-out', directory: '/repo', text: 'mine too', attachments: [], createdAt: 1, updatedAt: 5, stage: 'plan', sessionId: 'ses_out' },
    ];
    const { runtime, agentReads, sessionReads } = makeRuntime({
      cards,
      sessions: [
        session('ses_root', '/repo', 9, { agent: 'build' }),
        session('ses_agent', '/repo', 9, { agent: 'explore' }),
        session('ses_child', '/repo', 9, { parentID: 'ses_root' }),
      ],
      // Past the session list read: only the card links this session.
      sessionRecords: { ses_out: session('ses_out', '/repo', 9, { agent: 'explore' }) },
      agents: [{ id: 'build', mode: 'primary' }, { id: 'explore', mode: 'subagent' }],
    });
    const snapshot = await runtime.projection.snapshot('/repo');
    // Only the user's own sessions reach the board: the subagent-only agent's
    // session, OpenCode's own subagent child, and the card outside the list read
    // are not cards.
    expect(snapshot.cards.map(card => card.id)).toEqual(['mine']);
    await runtime.projection.snapshot('/repo');
    // Agent modes come from config, so one read is reused across snapshots, and
    // the session only the card named is asked about once.
    expect(agentReads).toEqual(['/repo']);
    expect(sessionReads).toEqual(['ses_out']);
    // A session whose own record changed is classified again.
    runtime.processPayload({ type: 'session.updated', properties: { sessionID: 'ses_out', directory: '/repo' } });
    await runtime.projection.snapshot('/repo');
    expect(sessionReads).toEqual(['ses_out', 'ses_out']);
  });

  it('adds real v2 sessions as inherited cards and drops their cache on reset', async () => {
    const { runtime } = makeRuntime({ sessions: [session('ses_new', '/repo', 9)] });
    const snapshot = await runtime.projection.snapshot('/repo');
    expect(snapshot.cards.map(card => card.id)).toContain('session:ses_new');
    runtime.projection.invalidateInherited();
    expect((await runtime.projection.snapshot('/repo')).cards.map(card => card.id)).toContain('session:ses_new');
  });

  it('re-reads the board when an ask appears or settles, without dropping the history cache', async () => {
    const cards = [{
      id: 'session:ses_1', directory: '/repo', text: 'go', attachments: [],
      createdAt: 1, updatedAt: 5, stage: 'plan', sessionId: 'ses_1',
    }];
    let pending = {};
    const { runtime, reads } = makeRuntime({ cards, pending: () => pending });
    expect((await runtime.projection.snapshot('/repo')).waitingFor).toEqual({});
    // The ask is not cached here: its events only ask the board to re-read, so
    // the session's history is not refetched on account of them. The directory
    // travels beside the payload, as it does for every other event.
    expect(runtime.processPayload({ type: 'form.created', properties: { sessionID: 'ses_1', form: { id: 'q1', sessionID: 'ses_1' } } }, '/repo')).toBe('/repo');
    expect(runtime.processPayload({ type: 'permission.replied', properties: { sessionID: 'ses_1', requestID: 'p1' } }, '/repo')).toBe('/repo');
    pending = { ses_1: { permissions: [], forms: [{ id: 'q1' }] } };
    expect((await runtime.projection.snapshot('/repo')).waitingFor).toEqual({ ses_1: 'question' });
    expect(reads).toEqual(['ses_1']);
    pending = {};
    expect((await runtime.projection.snapshot('/repo')).waitingFor).toEqual({});
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
