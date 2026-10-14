import type { Message } from '@/lib/opencode/model';
import type { WorkBoardCard, WorkBoardAttachment } from '@/lib/workBoardApi';

export type WorkBoardLane = 'todo' | 'plan' | 'queued' | 'building' | 'done';
export type WorkBoardActivity = {
  messages: Message[];
  busy: boolean;
};

export function workBoardLane(card: WorkBoardCard, activity: WorkBoardActivity | undefined, queue: 'queued' | 'building' | undefined): WorkBoardLane {
  if (queue) return queue;
  // A new user turn after parking reopens the card without a UI-only marker.
  const messages = [...(activity?.messages ?? [])].reverse();
  const lastUser = messages.find(message => message.role === 'user');
  const assistant = messages.find(message => message.role === 'assistant');
  const latestTurn = Math.max(lastUser?.time.created ?? 0, assistant?.time.created ?? 0);
  if (card.stage === 'todo' && latestTurn <= card.updatedAt && !activity?.busy) return 'todo';
  if (lastUser && (!assistant || lastUser.time.created > assistant.time.created)) return 'plan';
  if (assistant?.role === 'assistant' && assistant.agent.toLowerCase() === 'build') {
    const idle = messages.find(message => message.role === 'idle');
    if (!activity?.busy && idle?.role === 'idle' && idle.outcome === 'succeeded'
      && idle.time.created >= assistant.time.created && (!lastUser || idle.time.created >= lastUser.time.created)) return 'done';
    return 'building';
  }
  return 'plan';
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
