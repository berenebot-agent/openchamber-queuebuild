import { describe, expect, test } from 'bun:test';
import { captureWorkBoardAttachments, startWorkBoardPlan, workBoardFeedback, workBoardLane, workBoardMoved, workBoardOrderNeighbour, workBoardPlacement, workBoardCompletionTime, workBoardQueueRows, workBoardReordered, workBoardShowsCompletionMark, workBoardBuildBadges, workBoardDirectoryKey, workBoardActiveEntries, workBoardReviewConfirmWording } from './workBoardWorkflow';
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
  test('manual completion holds only while the manual placement is the latest move', () => {
    const completed: WorkBoardCard = { ...card, stage: 'done', completedAt: 6, placementAt: 6 };
    expect(workBoardLane(completed, undefined, undefined)).toBe('done');
    expect(workBoardLane(completed, { messages: [user(2), assistant('plan', 3), idle], busy: false }, undefined)).toBe('done');
    // A turn after the drag takes the card back to the lane its work belongs in.
    expect(workBoardLane(completed, { messages: [user(7)], busy: false }, undefined)).toBe('plan');
    expect(workBoardLane(completed, { messages: [], busy: true }, undefined)).toBe('plan');
    // The build queue still owns the card while a lease exists.
    expect(workBoardLane(completed, undefined, waiting())).toBe('queue');
    expect(workBoardLane(completed, undefined, running())).toBe('queue');
  });
  test('Done ordering uses the manual completion, never session update time', () => {
    const built: WorkBoardCard = { ...card, stage: 'plan', updatedAt: 1000 };
    const activity = { messages: [user(2), assistant('build', 3), idle], busy: false };
    // A Build turn that has not been moved to Done carries no completion time.
    expect(workBoardCompletionTime(built, activity)).toBe(0);
    const completed: WorkBoardCard = { ...card, stage: 'done', completedAt: 6, placementAt: 6 };
    expect(workBoardCompletionTime(completed, activity)).toBe(6);
    // A later Build turn reopens the card, so it has no completion time either.
    const rebuilt = { messages: [user(7), assistant('build', 8), { ...idle, time: { created: 10 } }], busy: false };
    expect(workBoardCompletionTime(completed, rebuilt)).toBe(0);
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
  test('an idle Build card is Build complete whether or not that turn settled successfully', () => {
    const linked = { ...card, stage: 'plan' as const, sessionId: 'session1' };
    const messages = [user(2), assistant('build', 3), idle];
    expect(workBoardLane(linked, { messages, busy: false }, undefined)).toBe('build');
    expect(workBoardLane(linked, { messages, busy: true }, undefined)).toBe('queue');
    // A running turn is Building even before its idle record lands.
    expect(workBoardLane(linked, { messages: messages.slice(0, -1), busy: true }, undefined)).toBe('queue');
    // An idle Build turn is Build complete with or without its idle record: live
    // status, not history detail, decides whether the turn is still open.
    expect(workBoardLane(linked, { messages: messages.slice(0, -1), busy: false }, undefined)).toBe('build');
    // A Plan turn stays in Plan regardless of how it ended.
    expect(workBoardLane(linked, { messages: [user(2), assistant('plan', 3), idle], busy: false }, undefined)).toBe('plan');
  });
  test('a failed or stopped Build turn is history: Build complete, not Plan, and never a Plan flash', () => {
    const linked = { ...card, stage: 'plan' as const, sessionId: 'session1' };
    const failedIdle: Message = { ...idle, outcome: 'failed', error: undefined };
    const interrupted: Message = { ...idle, outcome: 'interrupted' };
    for (const outcome of [failedIdle, interrupted]) {
      const history = [user(2), assistant('build', 3), outcome];
      // Idle with nothing running: the card is finished history, not pending work.
      expect(workBoardLane(linked, { messages: history, busy: false }, undefined)).toBe('build');
      expect(workBoardLane(linked, { messages: history, busy: true }, undefined)).toBe('queue');
      // Nothing running and no idle record on a Build turn is still settled.
      expect(workBoardLane(linked, { messages: history.slice(0, -1), busy: false }, undefined)).toBe('build');
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
  test('forced builds and card-derived live builds merge into one row per session', () => {
    const entries = workBoardActiveEntries(
      [{ sessionId: 's1', title: 'Forced build' }],
      [
        { sessionId: 's1', title: 'Card title', checking: true, unavailable: false },
        { sessionId: 's2', title: 'Live build', checking: false, unavailable: true },
      ],
    );
    // The server-named forced row wins over the same session's card row and
    // carries the marker; the plain live build keeps its own state.
    expect(entries).toEqual([
      { sessionId: 's1', title: 'Forced build', checking: false, unavailable: false, forced: true },
      { sessionId: 's2', title: 'Live build', checking: false, unavailable: true, forced: false },
    ]);
  });
});

describe('project build badges', () => {
  // A named fixture type, so the paused cases below can carry their own fields.
  type BadgeQueue = {
    active: { directory: string; needsReview?: boolean }[];
    queued: { directory: string }[];
    issues?: { directory: string; issue: string }[];
  };
  const queue: BadgeQueue = {
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
    expect(workBoardDirectoryKey('/repo/')).toBe(workBoardDirectoryKey('\\repo'));
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
  test('a parked lease or a Git hold is a paused tab, not a failed read', () => {
    const projects = [{ id: 'a', path: '/repo' }, { id: 'b', path: '/other' }, { id: 'c', path: '/third' }];
    const badges = workBoardBuildBadges(projects, {
      active: [{ directory: '/repo', needsReview: true }],
      queued: [{ directory: '/repo' }],
      issues: [{ directory: '/other', issue: 'Repository has uncommitted changes.' }],
    }, false);
    // The review mark names its own state; the count survives beside it.
    expect(badges.get('a')).toEqual({ count: 2, error: false, paused: 'review' });
    expect(badges.get('b')).toEqual({ count: 0, error: false, paused: 'git' });
    expect(badges.has('c')).toBe(false);
  });
  test('a review outranks a Git hold on the same project', () => {
    const badges = workBoardBuildBadges([{ id: 'a', path: '/repo' }], {
      active: [{ directory: '/repo', needsReview: true }],
      queued: [],
      issues: [{ directory: '/repo', issue: 'Repository has uncommitted changes.' }],
    }, false);
    // Only the user can clear a review, so it is the state worth naming.
    expect(badges.get('a')?.paused).toBe('review');
  });
});

describe('manual placement', () => {
  test('a build turn settles in Build complete and only a move reaches Done', () => {
    const finished = { ...card, stage: 'done' as const, sessionId: 'session1' };
    const history = { messages: [user(2), assistant('build', 3), idle], busy: false };
    expect(workBoardLane(finished, history, undefined)).toBe('build');
    const moved = workBoardPlacement(finished, 'done', 6);
    expect(moved.stage).toBe('done');
    expect(workBoardLane(moved, history, undefined)).toBe('done');
  });
  test('a drag between the card lanes rewrites only the stage and the marker', () => {
    const linked = { ...card, stage: 'plan' as const, sessionId: 'session1', updatedAt: 3 };
    expect(workBoardPlacement(linked, 'todo', 5)).toMatchObject({ stage: 'todo', placementAt: 5, updatedAt: 3 });
    expect(workBoardPlacement(linked, 'build', 5)).toMatchObject({ stage: 'done', placementAt: 5 });
    // Leaving Done keeps the completion the card earned; the placement is what
    // puts it back in the lane's automatic behaviour.
    const done = { ...card, stage: 'done' as const, completedAt: 4, viewedAt: 4 };
    expect(workBoardPlacement(done, 'todo', 9)).toMatchObject({ stage: 'todo', completedAt: 4, viewedAt: 4, placementAt: 9 });
  });
  test('reordering lands the card at the dropped index, or at the end', () => {
    expect(workBoardMoved(['a', 'b', 'c'], 'a', 2)).toEqual(['b', 'c', 'a']);
    expect(workBoardMoved(['a', 'b', 'c'], 'c', 0)).toEqual(['c', 'a', 'b']);
    expect(workBoardMoved(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
    // A drop on itself leaves the arrangement alone, and a stranger changes nothing.
    expect(workBoardMoved(['a', 'b', 'c'], 'b', 1)).toEqual(['a', 'b', 'c']);
    expect(workBoardMoved(['a', 'b', 'c'], 'missing', 0)).toEqual(['a', 'b', 'c']);
  });
  test('the drop neighbour is the card that follows the moved one', () => {
    expect(workBoardOrderNeighbour(['a', 'b', 'c'], 'a')).toBe('b');
    expect(workBoardOrderNeighbour(['a', 'b', 'c'], 'c')).toBeNull();
    expect(workBoardOrderNeighbour(['a'], 'missing')).toBeNull();
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
  test('a busy review session continues by adopting, an idle one keeps the banner text', () => {
    // Continuing a frozen lane whose session is running again adopts that live
    // turn; the confirmation has to say so instead of repeating the review text.
    expect(workBoardReviewConfirmWording('skip', true)).toBe('adopt');
    // Idle, or the retry action, keeps the banner's own wording.
    expect(workBoardReviewConfirmWording('skip', false)).toBe('banner');
    expect(workBoardReviewConfirmWording('retry', true)).toBe('banner');
    expect(workBoardReviewConfirmWording(undefined, true)).toBe('banner');
  });
});
