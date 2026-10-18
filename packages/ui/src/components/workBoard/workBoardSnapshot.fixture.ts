import type { WorkBoardSnapshot, WorkBoardSnapshotCard } from '@/lib/workBoardApi';

type SnapshotInput = {
  directory?: string;
  cards?: WorkBoardSnapshotCard[];
  queue?: Partial<WorkBoardSnapshot['queue']>;
  activities?: WorkBoardSnapshot['activities'];
  waitingFor?: WorkBoardSnapshot['waitingFor'];
  sessionTitles?: WorkBoardSnapshot['sessionTitles'];
  unavailable?: string[];
};

/**
 * A snapshot shaped the way the server projection returns one. Tests build the
 * board's derived state here (lane, order, status) instead of driving the
 * client's old history classifier, which no longer exists.
 */
export function makeSnapshot({ directory = '/repo', cards = [], queue = {}, activities = {}, waitingFor = {}, sessionTitles = {}, unavailable = [] }: SnapshotInput = {}): WorkBoardSnapshot {
  const lanes = Object.fromEntries(cards.map(card => [card.id, card.lane]));
  const order: WorkBoardSnapshot['order'] = { todo: [], plan: [], queue: [], build: [], done: [] };
  for (const card of cards) order[card.lane]?.push(card.id);
  // The server orders Done by newest completion first; the fixture mirrors that
  // so a test asserting Done order describes the real projection.
  order.done.sort((a, b) => {
    const left = cards.find(card => card.id === a);
    const right = cards.find(card => card.id === b);
    return (right?.completedAt ?? 0) - (left?.completedAt ?? 0) || a.localeCompare(b);
  });
  const placements = Object.fromEntries(cards.map(card => [card.id, {
    lane: card.lane, completedAt: card.completedAt ?? 0, updatedAt: card.updatedAt, sessionId: card.sessionId,
  }]));
  return {
    directory,
    revision: 1,
    lanes,
    order,
    cards,
    placements,
    activities,
    waitingFor,
    sessionTitles,
    unavailable,
    inheritedAvailable: true,
    queue: {
      known: true, enabled: true, rows: [], order: [], active: null, forced: [], issue: null, preparation: null, commit: null,
      ...queue,
    },
  };
}

export function snapshotCard(over: Partial<WorkBoardSnapshotCard> & Pick<WorkBoardSnapshotCard, 'id' | 'lane'>): WorkBoardSnapshotCard {
  const { id, lane, ...rest } = over;
  return {
    id, lane, status: over.sessionId ? 'known' : 'none', directory: '/repo', text: id,
    attachments: [], createdAt: 1, updatedAt: 1,
    stage: lane === 'plan' ? 'plan' : lane === 'build' || lane === 'done' ? 'done' : 'todo',
    availableActions: lane === 'done' ? [] : ['complete'],
    ...rest,
  };
}
