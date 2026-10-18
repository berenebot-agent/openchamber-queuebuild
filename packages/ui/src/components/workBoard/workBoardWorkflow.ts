import type { WorkBoardCard, WorkBoardAttachment, WorkBoardSnapshot, WorkBoardActivityMessage, WorkBoardQueuedModel } from '@/lib/workBoardApi';

export type WorkBoardLane = 'todo' | 'plan' | 'queue' | 'build' | 'done';

/** The lanes a card can be dragged into. Build queue membership stays its own. */
export type WorkBoardCardLane = Exclude<WorkBoardLane, 'queue'>;

/**
 * What the project's build queue says about a card's session. The board shows
 * Queued and Building together in one column, so the two states travel as one
 * value carrying the row controls' inputs.
 */
export type WorkBoardQueueState = {
  itemId: string | null;
  paused: boolean;
  /** True for the lease the project is running now; false for one merely waiting. */
  active: boolean;
  /** The server parked this lease for review and will not release it alone. */
  needsReview: boolean;
  /** What the queue reports for this directory, in dispatch order. */
  order: string[];
};

export type WorkBoardActivity = {
  messages: WorkBoardActivityMessage[];
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
  /** The build message the row's tooltip shows: the reason it is queued, plus
   * any later Build prompts the server merged into the same item. */
  content: string;
  /** The model the build was submitted with, for the row's tooltip. */
  model: WorkBoardQueuedModel | null;
};

/**
 * A build the queue column shows above the gap without a lease: a build the
 * user forced to start outside the queue, or one the board knows is running
 * from card activity alone. `forced` carries the marker for the first kind, and
 * an ambiguous forced build — one whose prompt may not have started — also
 * carries `needsReview` and the item the recovery acts on.
 */
export type WorkBoardActiveEntry = {
  sessionId: string;
  title: string;
  checking: boolean;
  unavailable: boolean;
  forced: boolean;
  needsReview?: boolean;
  itemId?: string | null;
  /** What the build was submitted with; absent for a card-derived row. */
  model?: WorkBoardQueuedModel | null;
  content?: string | null;
};

/**
 * The queue column's non-lease active rows: forced builds from the server
 * snapshot above live builds the board knows from card activity, one row per
 * session. A forced build has a server entry, so it wins over the card-derived
 * row and carries the marker; the dedupe stops the same session showing twice.
 */
export function workBoardActiveEntries(
  forced: readonly { sessionId: string; title: string; needsReview?: boolean; itemId?: string | null; model?: WorkBoardQueuedModel | null; content?: string | null }[],
  live: readonly { sessionId: string; title: string; checking: boolean; unavailable: boolean }[],
): WorkBoardActiveEntry[] {
  const entries = new Map<string, WorkBoardActiveEntry>();
  for (const entry of forced) {
    const active: WorkBoardActiveEntry = {
      sessionId: entry.sessionId, title: entry.title, checking: false, unavailable: false, forced: true,
    };
    if (entry.needsReview) active.needsReview = true;
    if (entry.itemId) active.itemId = entry.itemId;
    if (entry.model) active.model = entry.model;
    if (entry.content) active.content = entry.content;
    entries.set(entry.sessionId, active);
  }
  for (const entry of live) if (!entries.has(entry.sessionId)) entries.set(entry.sessionId, { ...entry, forced: false });
  return [...entries.values()];
}

function workBoardQueueRows(
  queued: readonly { itemId: string; sessionId: string; content: string; paused: boolean; position: number; model: WorkBoardQueuedModel | null }[],
  titleFor: (sessionId: string) => string,
): WorkBoardQueueRow[] {
  return queued.map(item => ({
    itemId: item.itemId,
    sessionId: item.sessionId,
    title: titleFor(item.sessionId),
    snippet: item.content.trim().split('\n').find(line => line.trim())?.trim() || '',
    paused: item.paused,
    position: item.position,
    content: item.content,
    model: item.model,
  }));
}

/**
 * The lane a card is in, straight from the server's projection. A card the
 * snapshot does not name (a card added by an optimistic write before the next
 * snapshot) falls back to its stored stage so it does not vanish for a frame.
 */
export function workBoardCardLane(snapshot: WorkBoardSnapshot | null, card: WorkBoardCard): WorkBoardLane {
  const lane = snapshot?.lanes[card.id];
  if (lane) return lane;
  return card.stage === 'done' ? 'build' : card.stage;
}

/** The server's own order for a lane, filtered to cards the board can render. */
export function workBoardSnapshotOrder(snapshot: WorkBoardSnapshot | null, lane: WorkBoardLane, cards: readonly WorkBoardCard[]): string[] {
  const ids = snapshot?.order[lane] ?? [];
  if (ids.length) return ids;
  return cards.filter(card => workBoardCardLane(snapshot, card) === lane).map(card => card.id);
}

/**
 * The queue's own state for one card's session, from the projection, for the
 * card's row controls. A card whose session is neither waiting nor running has
 * no queue state.
 */
export function workBoardQueueFromSnapshot(snapshot: WorkBoardSnapshot | null, card: WorkBoardCard): WorkBoardQueueState | undefined {
  if (!snapshot || !card.sessionId) return undefined;
  const { queue } = snapshot;
  const row = queue.rows.find(item => item.sessionId === card.sessionId);
  if (row) return { itemId: row.itemId, paused: row.paused, active: false, needsReview: false, order: queue.order };
  if (queue.active?.sessionId === card.sessionId) {
    return { itemId: queue.active.itemId, paused: false, active: true, needsReview: queue.active.needsReview, order: queue.order };
  }
  return undefined;
}

/** The queue rows the column renders, with titles resolved from the session list. */
export function workBoardSnapshotRows(snapshot: WorkBoardSnapshot | null, titleFor: (sessionId: string) => string): WorkBoardQueueRow[] {
  return workBoardQueueRows(snapshot?.queue.rows ?? [], titleFor);
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
 * the server projection does, so a worktree's queue does not inflate its root
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

/**
 * What a project tab says about sessions waiting for the user's answer: a
 * question (a pending form, or a page waiting for its answer) or a permission.
 * The two are independent — a project can wait on both, on one, or neither — so
 * a tab carries whichever apply and nothing when none do.
 */
export type WorkBoardTabAsks = {
  question: boolean;
  permission: boolean;
};

/**
 * One entry per project with a session waiting on an answer, keyed by project
 * id. A session counts toward the project whose directory it matches, the same
 * rule the build badge uses, so a worktree's ask does not inflate its root
 * project's tab. A project with nothing waiting has no entry at all: the badge
 * is the presence of an ask, so its absence is meaningful and must not be
 * filled with a false.
 */
export function workBoardTabAsks(
  projects: readonly { id: string; path: string }[],
  sessions: Iterable<{ directory: string; question: boolean; permission: boolean }>,
): Map<string, WorkBoardTabAsks> {
  const asks = new Map<string, WorkBoardTabAsks>();
  if (!projects.length) return asks;
  const projectByDirectory = new Map(projects.map(project => [workBoardDirectoryKey(project.path), project.id]));
  for (const session of sessions) {
    if (!session.question && !session.permission) continue;
    const projectId = projectByDirectory.get(workBoardDirectoryKey(session.directory));
    if (!projectId) continue;
    const current = asks.get(projectId) ?? { question: false, permission: false };
    asks.set(projectId, {
      question: current.question || session.question,
      permission: current.permission || session.permission,
    });
  }
  return asks;
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
