import type { Message } from '@/lib/opencode/model';
import type { WorkBoardCard, WorkBoardAttachment } from '@/lib/workBoardApi';

export type WorkBoardLane = 'todo' | 'plan' | 'queued' | 'building' | 'done';
export type WorkBoardActivity = {
  messages: Message[];
  busy: boolean;
};

export function workBoardFeedback(activity: WorkBoardActivity | undefined, unavailable: boolean, needsReview: boolean, hasUnseenTurn: boolean): 'unknown' | 'blocked' | undefined {
  if (unavailable || !activity) return 'unknown';
  const messages = [...activity.messages].reverse();
  const lastIdle = messages.find(message => message.role === 'idle');
  const lastPrompt = messages.find(message => message.role === 'user');
  if (needsReview || (hasUnseenTurn && !activity.busy && lastIdle?.role === 'idle' && lastIdle.outcome !== 'succeeded'
    && lastIdle.time.created >= (lastPrompt?.time.created ?? 0))) return 'blocked';
  return undefined;
}

export function workBoardLane(
  card: WorkBoardCard,
  activity: WorkBoardActivity | undefined,
  queue: 'queued' | 'building' | undefined,
  // The session holds a build lease the server parked for review. Such a lease
  // still owns the project's build lane, so the card stays where the queue put
  // it until the user resolves the lease, never in Done.
  needsReview = false,
): WorkBoardLane {
  if (queue) return queue;
  // A new user turn after parking reopens the card without a UI-only marker.
  const messages = [...(activity?.messages ?? [])].reverse();
  const lastUser = messages.find(message => message.role === 'user');
  const assistant = messages.find(message => message.role === 'assistant');
  const latestTurn = Math.max(lastUser?.time.created ?? 0, assistant?.time.created ?? 0);
  const parkedAt = card.stage === 'done' ? card.completedAt ?? card.updatedAt : card.updatedAt;
  if ((card.stage === 'todo' || card.stage === 'done') && latestTurn <= parkedAt && !activity?.busy) return card.stage;
  if (lastUser && (!assistant || lastUser.time.created > assistant.time.created)) return 'plan';
  if (assistant?.role === 'assistant' && assistant.agent.toLowerCase() === 'build') {
    if (activity?.busy) return 'building';
    // A queue lease awaiting review is unfinished work, not history.
    if (needsReview) return 'building';
    // The last agent was Build and the session is idle. Whether that turn
    // succeeded, failed or was stopped, no work is running, so the card is
    // history: it belongs in Done. A queue lease is the one exception above --
    // those keep their own recovery contract.
    return 'done';
  }
  return 'plan';
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
    (message.role === 'user' || message.role === 'assistant') && message.time.created > completedAt)) return completedAt;
  if (workBoardLane(card, activity, undefined) !== 'done') return 0;
  return [...(activity?.messages ?? [])].reverse().find(message => message.role === 'idle')?.time.created ?? 0;
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
