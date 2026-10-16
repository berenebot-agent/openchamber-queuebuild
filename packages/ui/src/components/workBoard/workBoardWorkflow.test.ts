import { describe, expect, test } from 'bun:test';
import { captureWorkBoardAttachments, startWorkBoardPlan, workBoardFeedback, workBoardLane, workBoardCompletionTime, workBoardQueueRows, workBoardReordered, workBoardShowsCompletionMark, workBoardBuildBadges } from './workBoardWorkflow';
import type { WorkBoardCard } from '@/lib/workBoardApi';
import type { Message } from '@/lib/opencode/model';

const card: WorkBoardCard = { id: 'card1', directory: '/repo', text: 'Build a board', attachments: [], createdAt: 1, updatedAt: 1, stage: 'todo' };
const selection = { providerID: 'provider', modelID: 'model' };
const user = (at: number): Message => ({ id: `user${at}`, sessionID: 'session1', role: 'user', time: { created: at } });
const assistant = (agent: string, at: number): Message => ({ id: `assistant${at}`, sessionID: 'session1', role: 'assistant', agent, providerID: 'provider', modelID: 'model', time: { created: at, completed: at + 1 } });
const idle: Message = { id: 'idle', sessionID: 'session1', role: 'idle', outcome: 'succeeded', time: { created: 5 } };
const waiting = (needsReview = false) => ({ itemId: 'item1', paused: false, active: false, needsReview, order: ['item1'] });
const running = (needsReview = false) => ({ itemId: 'item1', paused: false, active: true, needsReview, order: [] });

describe('work board lanes', () => {
  test('manual completion persists without Build history and reopens on a later prompt', () => {
    const completed: WorkBoardCard = { ...card, stage: 'done', completedAt: 6, updatedAt: 6 };
    expect(workBoardLane(completed, undefined, undefined)).toBe('done');
    expect(workBoardLane(completed, { messages: [user(2), assistant('plan', 3), idle], busy: false }, undefined)).toBe('done');
    expect(workBoardLane(completed, { messages: [user(7)], busy: false }, undefined)).toBe('plan');
    expect(workBoardLane(completed, { messages: [], busy: true }, undefined)).toBe('plan');
    expect(workBoardLane(completed, undefined, waiting())).toBe('queue');
    expect(workBoardLane(completed, undefined, running())).toBe('queue');
  });
  test('Done ordering uses settled Build finish or manual completion, never session update time', () => {
    const built: WorkBoardCard = { ...card, stage: 'plan', updatedAt: 1000 };
    const activity = { messages: [user(2), assistant('build', 3), idle], busy: false };
    expect(workBoardCompletionTime(built, activity)).toBe(5);
    const completed: WorkBoardCard = { ...card, stage: 'done', completedAt: 6, updatedAt: 1000 };
    expect(workBoardCompletionTime(completed, activity)).toBe(6);
    const rebuilt = { messages: [user(7), assistant('build', 8), { ...idle, time: { created: 10 } }], busy: false };
    expect(workBoardCompletionTime(completed, rebuilt)).toBe(10);
    expect(workBoardCompletionTime(built, { ...activity, busy: true })).toBe(0);
  });
  test('new cards stay To-do and queue leases take precedence', () => {
    expect(workBoardLane(card, undefined, undefined)).toBe('todo');
    expect(workBoardLane(card, undefined, waiting())).toBe('queue');
    expect(workBoardLane(card, undefined, running())).toBe('queue');
  });
  test('a queued Build from a Plan session is queue work, not Plan, before any build turn runs', () => {
    const linked = { ...card, stage: 'plan' as const, sessionId: 'session1' };
    // The reported case: Plan finished, the user followed up with a Build prompt,
    // and the server queued it. History still ends in a Plan turn, so only the
    // queue can place the card correctly.
    const planHistory = { messages: [user(2), assistant('plan', 3), idle], busy: false };
    expect(workBoardLane(linked, planHistory, undefined)).toBe('plan');
    expect(workBoardLane(linked, planHistory, waiting())).toBe('queue');
    expect(workBoardLane(linked, planHistory, running())).toBe('queue');
    // And with no history read yet, the queue alone still places it.
    expect(workBoardLane(linked, undefined, waiting())).toBe('queue');
  });
  test('an idle Build card is Done whether or not that turn settled successfully', () => {
    const linked = { ...card, stage: 'plan' as const, sessionId: 'session1' };
    const messages = [user(2), assistant('build', 3), idle];
    expect(workBoardLane(linked, { messages, busy: false }, undefined)).toBe('done');
    expect(workBoardLane(linked, { messages, busy: true }, undefined)).toBe('queue');
    // A running turn is Building even before its idle record lands.
    expect(workBoardLane(linked, { messages: messages.slice(0, -1), busy: true }, undefined)).toBe('queue');
    // An idle Build turn is Done with or without its idle record: live status,
    // not history detail, decides whether the turn is still open.
    expect(workBoardLane(linked, { messages: messages.slice(0, -1), busy: false }, undefined)).toBe('done');
    // A Plan turn stays in Plan regardless of how it ended.
    expect(workBoardLane(linked, { messages: [user(2), assistant('plan', 3), idle], busy: false }, undefined)).toBe('plan');
  });
  test('a failed or stopped Build turn is history: Done, not Plan, and never a Plan flash', () => {
    const linked = { ...card, stage: 'plan' as const, sessionId: 'session1' };
    const failedIdle: Message = { ...idle, outcome: 'failed', error: undefined };
    const interrupted: Message = { ...idle, outcome: 'interrupted' };
    for (const outcome of [failedIdle, interrupted]) {
      const history = [user(2), assistant('build', 3), outcome];
      // Idle with nothing running: the card is done history, not pending work.
      expect(workBoardLane(linked, { messages: history, busy: false }, undefined)).toBe('done');
      expect(workBoardLane(linked, { messages: history, busy: true }, undefined)).toBe('queue');
      // Nothing running and no idle record on a Build turn is still settled.
      expect(workBoardLane(linked, { messages: history.slice(0, -1), busy: false }, undefined)).toBe('done');
      expect(workBoardLane(linked, { messages: history.slice(0, -1), busy: true }, undefined)).toBe('queue');
      expect(workBoardLane(linked, { messages: history, busy: false }, waiting())).toBe('queue');
    }
    // A Plan turn that failed is not Build history: it stays in Plan.
    expect(workBoardLane(linked, { messages: [user(2), assistant('plan', 3), failedIdle], busy: false }, undefined)).toBe('plan');
  });
  test('a parked build lease keeps its card in Building until the lease is resolved', () => {
    const linked = { ...card, stage: 'plan' as const, sessionId: 'session1' };
    const built = [user(2), assistant('build', 3), idle];
    const failedIdle: Message = { ...idle, outcome: 'failed', error: undefined };
    const interruptedIdle: Message = { ...idle, outcome: 'interrupted' };
    // The server will not release this lease on its own, so the card must not
    // leave the build lane behind its back -- not even when the turn looks
    // settled. Only resolving the lease moves it.
    expect(workBoardLane(linked, { messages: built, busy: false }, waiting(true))).toBe('queue');
    expect(workBoardLane(linked, { messages: [user(2), assistant('build', 3), failedIdle], busy: false }, waiting(true))).toBe('queue');
    expect(workBoardLane(linked, { messages: [user(2), assistant('build', 3), interruptedIdle], busy: false }, waiting(true))).toBe('queue');
    // The lease pin outranks an idle history read that would otherwise be Done.
    expect(workBoardLane(linked, { messages: built, busy: false }, running(true))).toBe('queue');
    // An idle Plan card is untouched by another session's review lease.
    expect(workBoardLane(linked, { messages: [user(2), assistant('plan', 3), idle], busy: false }, undefined)).toBe('plan');
  });
  test('parking preserves old history; a new send reopens the card', () => {
    const parked = { ...card, sessionId: 'session1', updatedAt: 6 };
    expect(workBoardLane(parked, { messages: [user(2), assistant('build', 3), idle], busy: false }, undefined)).toBe('todo');
    expect(workBoardLane(parked, { messages: [user(2), assistant('plan', 3)], busy: true }, undefined)).toBe('plan');
    expect(workBoardLane(parked, { messages: [user(2), assistant('build', 3), idle, user(7), assistant('plan', 8)], busy: true }, undefined)).toBe('plan');
    expect(workBoardLane(parked, { messages: [user(2), assistant('build', 3), idle, user(7)], busy: false }, undefined)).toBe('plan');
  });
});

describe('build queue column', () => {
  test('lists every queued build, including one the board has no card for', () => {
    const rows = workBoardQueueRows([
      { id: 'a', sessionId: 's1', content: '\n  Ship the queue column  \nmore detail', paused: false },
      { id: 'b', sessionId: 's2', content: '', paused: true },
    ], sessionId => (sessionId === 's1' ? 'Named session' : 'Session s2'));
    expect(rows).toEqual([
      // Order is the queue's dispatch order, and the snippet is the first real
      // line of the queued prompt. An empty prompt leaves the title alone.
      { itemId: 'a', sessionId: 's1', title: 'Named session', snippet: 'Ship the queue column', paused: false, position: 0 },
      { itemId: 'b', sessionId: 's2', title: 'Session s2', snippet: '', paused: true, position: 1 },
    ]);
  });
  test('a move sends the queue order with only the two neighbours swapped', () => {
    expect(workBoardReordered(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(workBoardReordered(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    // An end has nowhere to go, and the caller must not send a reorder.
    expect(workBoardReordered(['a', 'b', 'c'], 0, -1)).toBeNull();
    expect(workBoardReordered(['a', 'b', 'c'], 2, 1)).toBeNull();
    expect(workBoardReordered(['a'], 0, 0)).toEqual(['a']);
    expect(workBoardReordered(['a'], 5, 1)).toBeNull();
  });
  test('a paused queued build is still queued, not done', () => {
    const linked = { ...card, stage: 'plan' as const, sessionId: 'session1' };
    const paused = { ...waiting(), paused: true };
    expect(workBoardLane(linked, { messages: [user(2), assistant('build', 3), idle], busy: false }, paused)).toBe('queue');
  });
});

describe('project build badges', () => {
  const queue = {
    active: [{ directory: '/repo' }],
    queued: [{ directory: '/repo' }, { directory: '/repo' }],
  };
  test('counts the running lease and everything waiting for that project', () => {
    const badges = workBoardBuildBadges([{ id: 'a', path: '/repo' }, { id: 'b', path: '/other' }], queue, false);
    // One building plus two waiting is three, even though only one is running.
    expect(badges.get('a')).toEqual({ count: 3, error: false });
    // A project with an empty queue has no badge at all, not a zero.
    expect(badges.has('b')).toBe(false);
  });
  test('normalises trailing slashes and backslashes before matching', () => {
    const badges = workBoardBuildBadges([{ id: 'a', path: '/repo/' }], { active: [], queued: [{ directory: '\\repo' }] }, false);
    expect(badges.get('a')).toEqual({ count: 1, error: false });
  });
  test('a queue error marks every tab rather than reading as idle', () => {
    const projects = [{ id: 'a', path: '/repo' }, { id: 'b', path: '/other' }];
    const failed = workBoardBuildBadges(projects, queue, true);
    const missing = workBoardBuildBadges(projects, null, false);
    for (const badges of [failed, missing]) {
      expect(badges.get('a')).toEqual({ count: 0, error: true });
      expect(badges.get('b')).toEqual({ count: 0, error: true });
    }
  });
});

describe('compact card feedback', () => {
  test('reports unknown activity even if cached history succeeded', () => {
    expect(workBoardFeedback(undefined, false, false, false)).toBe('unknown');
    expect(workBoardFeedback({ messages: [idle], busy: false }, true, false, false)).toBe('unknown');
  });
  test('clears viewed failures and stops, while queue recovery still needs attention', () => {
    const failed: Message = { ...idle, outcome: 'failed', error: undefined };
    const stopped: Message = { ...idle, outcome: 'interrupted' };
    for (const outcome of [failed, stopped]) {
      const activity = { messages: [user(2), outcome], busy: false };
      expect(workBoardFeedback(activity, false, false, true)).toBe('blocked');
      expect(workBoardFeedback(activity, false, false, false)).toBeUndefined();
      expect(workBoardFeedback(activity, false, true, false)).toBe('blocked');
    }
    expect(workBoardFeedback({ messages: [idle], busy: false }, false, true, false)).toBe('blocked');
    expect(workBoardFeedback({ messages: [failed, user(7)], busy: true }, false, false, true)).toBeUndefined();
    expect(workBoardFeedback({ messages: [user(2), idle], busy: false }, false, false, true)).toBeUndefined();
  });
});

describe('completion mark', () => {
  test('marks a finished card until that completion is acknowledged', () => {
    expect(workBoardShowsCompletionMark({ ...card, stage: 'done', completedAt: 6 })).toBe(true);
    expect(workBoardShowsCompletionMark({ ...card, stage: 'done', completedAt: 6, viewedAt: 6 })).toBe(false);
    // A card that never finished has nothing to acknowledge.
    expect(workBoardShowsCompletionMark(card)).toBe(false);
    expect(workBoardShowsCompletionMark({ ...card, stage: 'done', updatedAt: 9 })).toBe(false);
  });
  test('a later completion marks the card again without any reset', () => {
    const acknowledged: WorkBoardCard = { ...card, stage: 'done', completedAt: 6, viewedAt: 6 };
    expect(workBoardShowsCompletionMark(acknowledged)).toBe(false);
    expect(workBoardShowsCompletionMark({ ...acknowledged, completedAt: 12, updatedAt: 12 })).toBe(true);
  });
});

describe('Plan promotion', () => {
  test('links the session durably before sending and changes stage only after acceptance', async () => {
    const events: string[] = [];
    const id = await startWorkBoardPlan(card, selection, {
      create: async () => { events.push('create'); return { id: 'session1' }; },
      link: async () => { events.push('link'); },
      send: async (_id, directory, text, attachments) => { expect(directory).toBe('/repo'); expect(text).toBe(card.text); expect(attachments).toEqual([]); events.push('send'); },
      accept: async () => { events.push('accept'); },
    });
    expect(id).toBe('session1');
    expect(events).toEqual(['create', 'link', 'send', 'accept']);
  });
  test('failed linking never sends; failed sending retains a link and does not promote', async () => {
    for (const fail of ['link', 'send']) {
      const events: string[] = [];
      await expect(startWorkBoardPlan(card, selection, {
        create: async () => ({ id: 'session1' }),
        link: async () => { events.push('link'); if (fail === 'link') throw new Error('disk failure'); },
        send: async () => { events.push('send'); throw new Error('lost response'); },
        accept: async () => { events.push('accept'); },
      })).rejects.toThrow();
      expect(events).toEqual(fail === 'link' ? ['link'] : ['link', 'send']);
    }
  });
  test('an existing session link prevents duplicate creation and submission', async () => {
    const never = async (): Promise<never> => { throw new Error('must not run'); };
    expect(await startWorkBoardPlan({ ...card, sessionId: 'session1' }, selection, { create: never, link: never, send: never, accept: never })).toBe('session1');
  });
  test('captures text-file payloads without mutable browser file objects', () => {
    const file = { id: 'file1', filename: 'notes.txt', mimeType: 'text/plain', size: 2, dataUrl: 'data:text/plain;base64,aGk=' };
    const captured = captureWorkBoardAttachments([file]);
    file.filename = 'changed.txt';
    expect(captured[0].filename).toBe('notes.txt');
  });
});
