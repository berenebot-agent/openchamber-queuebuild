import type { Message } from '@/lib/opencode/model';
import type { WorkBoardCard, WorkBoardAttachment } from '@/lib/workBoardApi';

export type WorkBoardLane = 'todo' | 'plan' | 'queue' | 'build' | 'done';

/** The lanes a card can be dragged into. Build queue membership stays its own. */
export type WorkBoardCardLane = Exclude<WorkBoardLane, 'queue'>;

/**
 * What the project's build queue says about a card's session. The board shows
 * Queued and Building together in one column, so the two states travel as one
 * value carrying the row controls' inputs.
 */
export type WorkBoardQueueState = {
  itemId: string;
  paused: boolean;
  /** True for the lease the project is running now; false for one merely waiting. */
  active: boolean;
  /** The server parked this lease for review and will not release it alone. */
  needsReview: boolean;
  /** What the queue reports for this directory, in dispatch order. */
  order: string[];
};

export type WorkBoardActivity = {
  messages: Message[];
  busy: boolean;
};

/**
 * What the board sends when a queued row moves or pauses, or when a paused
 * project's queue is resolved. Each route takes a narrow body, so the union
 * names each shape instead of leaving it untyped.
 */
export type WorkBoardQueueWrite =
  | { directory: string; ids: string[] }
  | { paused: boolean }
  | { directory: string; sessionId: string; itemId: string }
  | { directory: string; itemId?: string; action: 'skip' | 'retry' };

/**
 * Which confirmation a review Continue shows. Continuing a frozen lane whose
 * session is running again adopts that live turn rather than releasing the
 * build, so it says so; otherwise the banner's own review text stands. The
 * board only knows what it sees, so this picks wording — the server decides.
 */
export function workBoardReviewConfirmWording(
  action: 'skip' | 'retry' | undefined,
  sessionBusy: boolean,
): 'adopt' | 'banner' {
  return action === 'skip' && sessionBusy ? 'adopt' : 'banner';
}

export function workBoardFeedback(activity: WorkBoardActivity | undefined, unavailable: boolean, needsReview: boolean, hasUnseenTurn: boolean): 'unknown' | 'blocked' | undefined {
  if (unavailable || !activity) return 'unknown';
  const messages = [...activity.messages].reverse();
  const lastIdle = messages.find(message => message.role === 'idle');
  const lastPrompt = messages.find(message => message.role === 'user');
  if (needsReview || (hasUnseenTurn && !activity.busy && lastIdle?.role === 'idle' && lastIdle.outcome !== 'succeeded'
    && lastIdle.time.created >= (lastPrompt?.time.created ?? 0))) return 'blocked';
  return undefined;
}

/**
 * Placement state from a manual drag. A card keeps its `updatedAt`: that is the
 * boundary later session activity has to pass, and a parked To-do and the
 * stale-completion check compare against it. `placementAt` carries the drag's
 * own moment, which `updatedAt` cannot hold on its own.
 */
export function workBoardPlacement(card: WorkBoardCard, lane: WorkBoardCardLane, at: number) {
  if (lane === 'done') return { ...card, stage: 'done' as const, placementAt: at, completedAt: card.completedAt ?? at };
  const next: WorkBoardCard = { ...card, stage: lane === 'build' ? 'done' : lane, placementAt: at };
  // Leaving Done keeps the completion the card earned, so the mark does not
  // return the moment it is dragged back into a working lane.
  if (card.stage === 'done') { next.completedAt = card.completedAt; next.viewedAt = card.viewedAt; }
  return next;
}

export function workBoardLane(
  card: WorkBoardCard,
  activity: WorkBoardActivity | undefined,
  queue: WorkBoardQueueState | undefined,
): WorkBoardLane {
  if (queue) return 'queue';
  // A new user turn after parking reopens the card without a UI-only marker.
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
  if (assistant?.role === 'assistant' && assistant.agent.toLowerCase() === 'build') {
    // A queue lease awaiting review is unfinished work, not history, and the
    // queue input above already placed it. History alone settles a Build turn.
    if (activity?.busy) return 'queue';
    // The last agent was Build and the session is idle. Whether that turn
    // succeeded, failed or was stopped, no work is running, so the card is
    // history: it belongs in Build complete. A queue lease is the one exception
    // above -- those keep their own recovery contract. Only a later move reaches
    // Done, and the manual placement was already checked above.
    return 'build';
  }
  return 'plan';
}

/**
 * The lane order after a card moves to `toIndex`, or null when the move changes
 * nothing. `toIndex` is a drop neighbour's index in the lane's own order, or
 * null when the card was dropped past the last one.
 */
export function workBoardMoved(items: readonly string[], id: string, toIndex: number | null): string[] {
  const from = items.indexOf(id);
  if (from < 0) return [...items];
  const to = toIndex === null ? items.length - 1 : Math.max(0, Math.min(toIndex, items.length - 1));
  if (from === to) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * The card that comes after `id` in the lane, which is the boundary a drop past
 * the last card needs: the server stores an order by naming the card the moved
 * one sits before. Null means the end of the lane.
 */
export function workBoardOrderNeighbour(order: readonly string[], id: string): string | null {
  const index = order.indexOf(id);
  if (index < 0) return null;
  return order[index + 1] ?? null;
}

/**
 * Whether a card should show the session-style completion mark: it is finished
 * and the user has not yet acknowledged this completion. Scoped to one
 * completion — a later Done writes a newer `completedAt`, so the mark returns
 * on its own with no reset step. A card that was never completed has nothing to
 * acknowledge and never shows the mark.
 */
export function workBoardShowsCompletionMark(card: WorkBoardCard): boolean {
  if (card.completedAt === undefined) return false;
  return card.completedAt > (card.viewedAt ?? 0);
}

export function workBoardCompletionTime(card: WorkBoardCard, activity: WorkBoardActivity | undefined): number {
  const completedAt = card.completedAt ?? card.updatedAt;
  if (card.stage === 'done' && !activity?.busy && !activity?.messages.some(message =>
    (message.role === 'user' || message.role === 'assistant') && message.time.created > completedAt)) return card.completedAt ?? 0;
  if (workBoardLane(card, activity, undefined) !== 'done') return 0;
  return [...(activity?.messages ?? [])].reverse().find(message => message.role === 'idle')?.time.created ?? 0;
}

/**
 * The build queue as one column: the lease the server is running now, then the
 * waiting items in dispatch order, then any queue entry the board has no card
 * for. Entries without a card are still the queue's work; leaving them out
 * would show a shorter queue than the project actually has.
 */
export type WorkBoardQueueRow = {
  itemId: string;
  sessionId: string;
  title: string;
  snippet: string;
  paused: boolean;
  position: number;
};

/**
 * A build the queue column shows above the gap without a lease: a build the
 * user forced to start outside the queue, or one the board knows is running
 * from card activity alone. `forced` carries the marker for the first kind.
 */
export type WorkBoardActiveEntry = {
  sessionId: string;
  title: string;
  checking: boolean;
  unavailable: boolean;
  forced: boolean;
};

/**
 * The queue column's non-lease active rows: forced builds from the server
 * snapshot above live builds the board knows from card activity, one row per
 * session. A forced build has a server entry, so it wins over the card-derived
 * row and carries the marker; the dedupe stops the same session showing twice.
 */
export function workBoardActiveEntries(
  forced: readonly { sessionId: string; title: string }[],
  live: readonly { sessionId: string; title: string; checking: boolean; unavailable: boolean }[],
): WorkBoardActiveEntry[] {
  const entries = new Map<string, WorkBoardActiveEntry>();
  for (const entry of forced) entries.set(entry.sessionId, { ...entry, checking: false, unavailable: false, forced: true });
  for (const entry of live) if (!entries.has(entry.sessionId)) entries.set(entry.sessionId, { ...entry, forced: false });
  return [...entries.values()];
}

export function workBoardQueueRows(
  queued: readonly { id: string; sessionId: string; content: string; paused: boolean }[],
  titleFor: (sessionId: string) => string,
): WorkBoardQueueRow[] {
  return queued.map((item, index) => ({
    itemId: item.id,
    sessionId: item.sessionId,
    title: titleFor(item.sessionId),
    snippet: item.content.trim().split('\n').find(line => line.trim())?.trim() || '',
    paused: item.paused,
    position: index,
  }));
}

/** The full project order with one row moved by `delta`, or null at an end. */
export function workBoardReordered(ids: readonly string[], index: number, delta: number): string[] | null {
  const target = index + delta;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return null;
  const order = [...ids];
  [order[index], order[target]] = [order[target], order[index]];
  return order;
}

/**
 * What a project tab says about that project's build queue. `count` is every
 * build in the queue — the running lease plus everything waiting — so one
 * running build already reads as one, and it never reports zero: a project with
 * an empty queue shows no badge at all, which is the absence of this record.
 *
 * `error` and `paused` are different failures. `error` means the queue could not
 * be read at all, so nothing about the project is known. `paused` means the
 * queue was read and it is waiting for the user: a lease parked for review, or
 * the Git policy holding dispatch back. They carry different fixes, so they must
 * not render the same.
 */
export type WorkBoardBuildBadge = {
  count: number;
  error: boolean;
  paused?: 'review' | 'git';
};

export const workBoardDirectoryKey = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * One badge per project, keyed by project id, from the server's queue snapshot.
 * A queue error is not "nothing building": every open tab carries the error
 * badge so the failure is visible where the user is looking, rather than
 * silently reading as an idle project. Directories are normalised the same way
 * the Build queue pane does, so a worktree's queue does not inflate its root
 * project's badge.
 *
 * A paused project keeps its build count: the work is still queued, and how much
 * of it waits is what the tab is for.
 */
export function workBoardBuildBadges(
  projects: readonly { id: string; path: string }[],
  queue: {
    active: readonly { directory: string; needsReview?: boolean }[];
    queued: readonly { directory: string }[];
    issues?: readonly { directory: string; issue: string }[];
  } | null,
  queueError: boolean,
): Map<string, WorkBoardBuildBadge> {
  const badges = new Map<string, WorkBoardBuildBadge>();
  if (!projects.length) return badges;
  if (queueError || !queue) {
    for (const project of projects) badges.set(project.id, { count: 0, error: true });
    return badges;
  }
  const running = new Map<string, number>();
  for (const lease of queue.active) {
    const key = workBoardDirectoryKey(lease.directory);
    running.set(key, (running.get(key) ?? 0) + 1);
  }
  const waiting = new Map<string, number>();
  for (const item of queue.queued) {
    const key = workBoardDirectoryKey(item.directory);
    waiting.set(key, (waiting.get(key) ?? 0) + 1);
  }
  // A lease awaiting review is a waiting project, and it outranks a Git hold
  // when both apply: the review is the thing only the user can clear.
  const paused = new Map<string, 'review' | 'git'>();
  for (const lease of queue.active) {
    if (lease.needsReview) paused.set(workBoardDirectoryKey(lease.directory), 'review');
  }
  for (const issue of queue.issues ?? []) {
    const key = workBoardDirectoryKey(issue.directory);
    if (!paused.has(key)) paused.set(key, 'git');
  }
  for (const project of projects) {
    const key = workBoardDirectoryKey(project.path);
    const state = paused.get(key);
    const count = (running.get(key) ?? 0) + (waiting.get(key) ?? 0);
    if (count <= 0 && !state) continue;
    const badge: WorkBoardBuildBadge = { count, error: false };
    if (state) badge.paused = state;
    badges.set(project.id, badge);
  }
  return badges;
}

type Selection = { providerID: string; modelID: string; variant?: string };
type PromotionDependencies = {
  create: (directory: string, title: string, selection: Selection) => Promise<{ id: string }>;
  link: (cardId: string, sessionId: string) => Promise<void>;
  send: (sessionId: string, directory: string, text: string, attachments: WorkBoardAttachment[], selection: Selection) => Promise<void>;
  accept: (cardId: string) => Promise<void>;
};

export async function startWorkBoardPlan(card: WorkBoardCard, selection: Selection, deps: PromotionDependencies): Promise<string> {
  // Existing links require inspection, including after a lost response. Never resend automatically.
  if (card.sessionId) return card.sessionId;
  const title = card.text.trim().split('\n')[0]?.slice(0, 120) || card.attachments[0]?.filename || 'To-do';
  const session = await deps.create(card.directory, title, selection);
  await deps.link(card.id, session.id);
  await deps.send(session.id, card.directory, card.text, card.attachments, selection);
  await deps.accept(card.id);
  return session.id;
}

export function captureWorkBoardAttachments(files: readonly WorkBoardAttachment[]): WorkBoardAttachment[] {
  return files.map(({ id, filename, mimeType, size, dataUrl }) => ({ id, filename, mimeType, size, dataUrl }));
}
