import { describe, expect, test } from 'bun:test';
import { captureWorkBoardAttachments, startWorkBoardPlan, workBoardFeedback, workBoardMoved, workBoardOrderNeighbour, workBoardReordered, workBoardShowsCompletionMark, workBoardBuildBadges, workBoardTabAsks, workBoardsNeedingAttention, workBoardDirectoryKey, workBoardActiveEntries, workBoardReviewConfirmWording, workBoardCardLane, workBoardCompletesMove, workBoardSnapshotOrder, workBoardSnapshotRows, workBoardQueueFromSnapshot } from './workBoardWorkflow';
import type { WorkBoardBuildBadge, WorkBoardTabAsks } from './workBoardWorkflow';
import type { WorkBoardCard, WorkBoardSnapshot, WorkBoardActivityMessage } from '@/lib/workBoardApi';

const card: WorkBoardCard = { id: 'card1', directory: '/repo', text: 'Build a board', attachments: [], createdAt: 1, updatedAt: 1, stage: 'todo' };
const selection = { providerID: 'provider', modelID: 'model' };
const user = (at: number): WorkBoardActivityMessage => ({ id: `user${at}`, sessionID: 'session1', role: 'user', time: { created: at } });
const idle: WorkBoardActivityMessage = { id: 'idle', sessionID: 'session1', role: 'idle', outcome: 'succeeded', time: { created: 5 } };

/** A projection carrying only the queue rows a queue-column test needs. */
const makeProjectionWithRows = (rows: WorkBoardSnapshot['queue']['rows']): WorkBoardSnapshot => ({
  directory: '/repo', revision: 1, lanes: {}, order: { todo: [], plan: [], queue: [], build: [], done: [] },
  cards: [], placements: {}, activities: {}, waitingFor: {}, unavailable: [], inheritedAvailable: true,
  queue: { known: true, paused: false, enabled: true, rows, order: rows.map(row => row.itemId), active: null, forced: [], issue: null, preparation: null, commit: null },
});

describe('build queue column', () => {
  test('lists every queued build, including one the board has no card for', () => {
    const snapshot = makeProjectionWithRows([
      { itemId: 'a', sessionId: 's1', directory: '/repo', content: '\n  Ship the queue column  \nmore detail', paused: false, position: 0, model: { providerID: 'anthropic', id: 'claude' } },
      { itemId: 'b', sessionId: 's2', directory: '/repo', content: '', paused: true, position: 1, model: null },
    ]);
    const rows = workBoardSnapshotRows(snapshot, sessionId => (sessionId === 's1' ? 'Named session' : 'Session s2'));
    expect(rows).toEqual([
      // Order is the queue's dispatch order, and the snippet is the first real
      // line of the queued prompt. An empty prompt leaves the title alone. The
      // row also carries the model and the full message for the card's tooltip.
      { itemId: 'a', sessionId: 's1', title: 'Named session', snippet: 'Ship the queue column', paused: false, position: 0, content: '\n  Ship the queue column  \nmore detail', model: { providerID: 'anthropic', id: 'claude' } },
      { itemId: 'b', sessionId: 's2', title: 'Session s2', snippet: '', paused: true, position: 1, content: '', model: null },
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
  test('forced builds and card-derived live builds merge into one row per session', () => {
    const entries = workBoardActiveEntries(
      [{ sessionId: 's1', title: 'Forced build', model: { providerID: 'anthropic', id: 'claude' }, content: 'fix it' }],
      [
        { sessionId: 's1', title: 'Card title', checking: true, unavailable: false },
        { sessionId: 's2', title: 'Live build', checking: false, unavailable: true },
      ],
    );
    // The server-named forced row wins over the same session's card row and
    // carries the marker; the plain live build keeps its own state.
    expect(entries).toEqual([
      { sessionId: 's1', title: 'Forced build', checking: false, unavailable: false, forced: true, model: { providerID: 'anthropic', id: 'claude' }, content: 'fix it' },
      { sessionId: 's2', title: 'Live build', checking: false, unavailable: true, forced: false },
    ]);
  });
  test('an ambiguous forced build carries its review state and recovery target', () => {
    const entries = workBoardActiveEntries(
      [{ sessionId: 's1', title: 'Forced build', needsReview: true, itemId: 'item-1' }],
      [],
    );
    expect(entries).toEqual([{
      sessionId: 's1', title: 'Forced build', checking: false, unavailable: false, forced: true,
      needsReview: true, itemId: 'item-1',
    }]);
  });
});

describe('reading the server projection', () => {
  const snapshot: WorkBoardSnapshot = {
    directory: '/repo', revision: 1,
    lanes: { card1: 'plan', card2: 'queue' },
    order: { todo: [], plan: ['card1'], queue: [], build: [], done: [] },
    cards: [],
    placements: { card1: { lane: 'plan', completedAt: 0, updatedAt: 1 }, card2: { lane: 'queue', completedAt: 0, updatedAt: 1 } },
    activities: {}, waitingFor: {}, unavailable: [], inheritedAvailable: true,
    queue: {
      known: true, paused: false, enabled: true,
      rows: [{ itemId: 'i1', sessionId: 'session1', directory: '/repo', content: 'wait', paused: false, position: 0, model: null }],
      order: ['i1'],
      active: { sessionId: 'session2', itemId: 'i2', startedAt: 1, needsReview: true, retryAvailable: false, content: 'run', model: null },
      forced: [], issue: null, preparation: null, commit: null,
    },
  };
  test('a card reads its lane straight from the projection', () => {
    expect(workBoardCardLane(snapshot, { ...card, id: 'card1' })).toBe('plan');
    expect(workBoardCardLane(snapshot, { ...card, id: 'card2' })).toBe('queue');
    // A card the snapshot does not name falls back to its own stage.
    expect(workBoardCardLane(snapshot, { ...card, id: 'card3' })).toBe('todo');
    expect(workBoardCardLane(snapshot, { ...card, id: 'card4', stage: 'done' })).toBe('build');
  });
  test('lane order follows the projection, and a missing lane falls back', () => {
    expect(workBoardSnapshotOrder(snapshot, 'plan', [{ ...card, id: 'card1' }, { ...card, id: 'card9' }])).toEqual(['card1']);
    // Build has no order of its own; the fallback filters the cards by lane.
    expect(workBoardSnapshotOrder(snapshot, 'build', [])).toEqual([]);
    expect(workBoardSnapshotOrder(null, 'todo', [{ ...card, id: 'card1' }])).toEqual(['card1']);
  });
  test('a card reads its queue state from the waiting row or the running lease', () => {
    expect(workBoardQueueFromSnapshot(snapshot, { ...card, sessionId: 'session1' })).toMatchObject({ itemId: 'i1', active: false, order: ['i1'] });
    expect(workBoardQueueFromSnapshot(snapshot, { ...card, sessionId: 'session2' })).toMatchObject({ itemId: 'i2', active: true, needsReview: true });
    expect(workBoardQueueFromSnapshot(snapshot, { ...card, sessionId: 'other' })).toBeUndefined();
    expect(workBoardQueueFromSnapshot(null, { ...card, sessionId: 'session1' })).toBeUndefined();
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
  test('a manual queue pause stays visible on an empty project without affecting other directories', () => {
    const badges = workBoardBuildBadges([{ id: 'a', path: '/repo' }, { id: 'b', path: '/other' }], {
      active: [], queued: [], pausedDirectories: ['/repo/'],
    }, false);
    expect(badges.get('a')).toEqual({ count: 0, error: false, paused: 'manual' });
    expect(badges.has('b')).toBe(false);
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

describe('project tab asks', () => {
  const projects = [{ id: 'a', path: '/repo' }, { id: 'b', path: '/other' }];
  test('counts a question and a permission against the project directory', () => {
    const asks = workBoardTabAsks(projects, [
      { directory: '/repo', question: true, permission: false },
      { directory: '/other', question: false, permission: true },
    ]);
    expect(asks.get('a')).toEqual({ question: true, permission: false });
    expect(asks.get('b')).toEqual({ question: false, permission: true });
  });
  test('merges several sessions on one project, and drops a project with nothing waiting', () => {
    const asks = workBoardTabAsks(projects, [
      { directory: '/repo/', question: true, permission: false },
      { directory: '/repo', question: false, permission: true },
      { directory: '/elsewhere', question: true, permission: true },
    ]);
    // A question on one session and a permission on another are both kept.
    expect(asks.get('a')).toEqual({ question: true, permission: true });
    // Nothing waiting leaves no entry, so the tab carries no mark.
    expect(asks.has('b')).toBe(false);
  });
  test('an ask outside every open project is not counted', () => {
    // A worktree or a project without a tab does not inflate another's tab.
    expect(workBoardTabAsks(projects, [{ directory: '/repo/worktree', question: true, permission: false }]).size).toBe(0);
    expect(workBoardTabAsks([], [{ directory: '/repo', question: true, permission: false }]).size).toBe(0);
  });
});

describe('boards needing attention', () => {
  const noAsks = new Map<string, WorkBoardTabAsks>();
  const noBadges = new Map<string, WorkBoardBuildBadge>();
  test('counts a board waiting on the user, and never a plain running build', () => {
    const badges = new Map<string, WorkBoardBuildBadge>([
      ['running', { count: 3, error: false }],
      ['paused', { count: 1, error: false, paused: 'review' }],
      ['broken', { count: 0, error: true }],
    ]);
    expect(workBoardsNeedingAttention(['running', 'paused', 'broken'], badges, noAsks)).toBe(2);
    // A Git hold waits on the user too, on the same terms as a review.
    expect(workBoardsNeedingAttention(['git'], new Map([['git', { count: 2, error: false, paused: 'git' }]]), noAsks)).toBe(1);
  });
  test('counts a pending ask, and never a board with nothing waiting', () => {
    const asks = new Map<string, WorkBoardTabAsks>([
      ['question', { question: true, permission: false }],
      ['permission', { question: false, permission: true }],
    ]);
    expect(workBoardsNeedingAttention(['question', 'permission', 'calm'], noBadges, asks)).toBe(2);
    // A board with neither a bad queue nor an ask is not waiting on anyone.
    expect(workBoardsNeedingAttention(['calm'], noBadges, noAsks)).toBe(0);
  });
});

describe('reordering inside a lane', () => {
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
    const failed: WorkBoardActivityMessage = { ...idle, outcome: 'failed' };
    const stopped: WorkBoardActivityMessage = { ...idle, outcome: 'interrupted' };
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

describe('completing a move', () => {
  test('a move into Done from another lane completes the card', () => {
    expect(workBoardCompletesMove('build', 'done')).toBe(true);
    expect(workBoardCompletesMove('plan', 'done')).toBe(true);
    expect(workBoardCompletesMove('todo', 'done')).toBe(true);
    // A move already inside Done arranges the lane; it completes nothing new.
    expect(workBoardCompletesMove('done', 'done')).toBe(false);
    expect(workBoardCompletesMove('build', 'plan')).toBe(false);
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
