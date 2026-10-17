import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';

const attachmentSchema = z.object({
  id: z.string(), filename: z.string(), mimeType: z.string(), size: z.number().nonnegative(), dataUrl: z.string(),
});
const cardSchema = z.object({
  id: z.string(), directory: z.string(), text: z.string(), attachments: z.array(attachmentSchema),
  createdAt: z.number(), updatedAt: z.number(), completedAt: z.number().optional(), viewedAt: z.number().optional(), sessionId: z.string().optional(), stage: z.enum(['todo', 'plan', 'done']),
  placementAt: z.number().optional(), placementOrder: z.number().optional(),
  briefRemoved: z.literal(true).optional(),
});
export type WorkBoardAttachment = z.infer<typeof attachmentSchema>;
export type WorkBoardCard = z.infer<typeof cardSchema>;
type CardChanges = {
  text?: string; attachments?: WorkBoardAttachment[]; sessionId?: string; stage?: 'todo' | 'plan'; expectedUpdatedAt?: number;
  removeBrief?: true;
};
type BoardWrite = CardChanges | { directory: string; text: string; attachments: WorkBoardAttachment[]; sessionDirectory?: string };
type PlacementTarget = { id: string; updatedAt: number; text: string; sessionId?: string };
type PlacementLane = 'todo' | 'plan' | 'build' | 'done';
type PlacementWrite = { lane: PlacementLane; at: number; before?: string | null }
  | { directory: string; lane: PlacementLane; at: number; targets: PlacementTarget[] };

export class WorkBoardRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'WorkBoardRequestError';
  }
}

async function request(path: string, method = 'GET', body?: BoardWrite | PlacementWrite) {
  const runtime = getRuntimeKey();
  const response = await runtimeFetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (runtime !== getRuntimeKey()) throw new Error('Runtime changed during work board request');
  if (!response.ok) {
    const detail = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
    throw new WorkBoardRequestError(detail.success ? detail.data.error : `Work board request failed (${response.status})`, response.status);
  }
  const value = await response.json();
  if (runtime !== getRuntimeKey()) throw new Error('Runtime changed during work board request');
  return value;
}
/**
 * Put a card where the user dropped it or checked it off. `at` is the moment of
 * the drag: the server stores it as the boundary later activity has to pass.
 * `before` names the card it now sits in front of, which is how one lane's
 * order travels; null places it at the end.
 */
export async function placeWorkBoardCard(card: Pick<WorkBoardCard, 'id' | 'directory' | 'text' | 'sessionId'>, lane: PlacementLane, at: number, before: string | null): Promise<WorkBoardCard> {
  return z.object({ card: cardSchema })
    .parse(await request(`/api/work-board/${encodeURIComponent(card.id)}/placement`, 'POST',
      { lane, at, before, directory: card.directory, sessionId: card.sessionId, text: card.text })).card;
}
export async function placeWorkBoardCards(directory: string, lane: PlacementLane, at: number, targets: PlacementTarget[]) {
  return z.object({ placed: z.array(cardSchema), failed: z.array(z.object({ id: z.string(), error: z.string() })) })
    .parse(await request('/api/work-board/placement', 'POST', { directory, lane, at, targets }));
}
export async function fetchWorkBoard(directory: string): Promise<WorkBoardCard[]> {
  return z.object({ cards: z.array(cardSchema) }).parse(await request(`/api/work-board?directory=${encodeURIComponent(directory)}`)).cards;
}
export async function fetchSessionWorkBoardCards(sessionId: string): Promise<WorkBoardCard[]> {
  return z.object({ cards: z.array(cardSchema) }).parse(await request(`/api/work-board?sessionId=${encodeURIComponent(sessionId)}`)).cards;
}
export async function createWorkBoardCard(directory: string, text: string, attachments: WorkBoardAttachment[]): Promise<WorkBoardCard> {
  return z.object({ card: cardSchema }).parse(await request('/api/work-board', 'POST', { directory, text, attachments })).card;
}
export async function saveSessionToTodo(sessionId: string, directory: string, sessionDirectory: string, text: string, attachments: WorkBoardAttachment[]): Promise<WorkBoardCard> {
  return z.object({ card: cardSchema }).parse(await request(`/api/work-board/sessions/${encodeURIComponent(sessionId)}/todo`, 'POST', { directory, sessionDirectory, text, attachments })).card;
}
export async function updateWorkBoardCard(id: string, changes: CardChanges): Promise<WorkBoardCard> {
  return z.object({ card: cardSchema }).parse(await request(`/api/work-board/${encodeURIComponent(id)}`, 'PATCH', changes)).card;
}
export async function deleteWorkBoardCard(id: string): Promise<void> {
  z.object({ ok: z.literal(true) }).parse(await request(`/api/work-board/${encodeURIComponent(id)}`, 'DELETE'));
}
/** Acknowledge a completed card the user opened, so every client shares it. */
export async function markWorkBoardCardViewed(id: string): Promise<WorkBoardCard> {
  return z.object({ card: cardSchema }).parse(await request(`/api/work-board/${encodeURIComponent(id)}/viewed`, 'POST')).card;
}
