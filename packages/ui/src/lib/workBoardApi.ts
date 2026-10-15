import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';

const attachmentSchema = z.object({
  id: z.string(), filename: z.string(), mimeType: z.string(), size: z.number().nonnegative(), dataUrl: z.string(),
});
const cardSchema = z.object({
  id: z.string(), directory: z.string(), text: z.string(), attachments: z.array(attachmentSchema),
  createdAt: z.number(), updatedAt: z.number(), completedAt: z.number().optional(), sessionId: z.string().optional(), stage: z.enum(['todo', 'plan', 'done']),
});
export type WorkBoardAttachment = z.infer<typeof attachmentSchema>;
export type WorkBoardCard = z.infer<typeof cardSchema>;
type CardChanges = { text?: string; attachments?: WorkBoardAttachment[]; sessionId?: string; stage?: 'todo' | 'plan' };
type BoardWrite = CardChanges | { directory: string; text: string; attachments: WorkBoardAttachment[]; sessionDirectory?: string };
const completionTargetSchema = z.object({
  id: z.string(), updatedAt: z.number(), sessionId: z.string().optional(),
  sessionDirectory: z.string().optional(), text: z.string(),
});
type CompletionTarget = z.infer<typeof completionTargetSchema>;

async function request(path: string, method = 'GET', body?: BoardWrite | { directory: string; targets: CompletionTarget[] }) {
  const runtime = getRuntimeKey();
  const response = await runtimeFetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (runtime !== getRuntimeKey()) throw new Error('Runtime changed during work board request');
  if (!response.ok) {
    const detail = z.object({ error: z.string() }).safeParse(await response.json().catch(() => null));
    throw new Error(detail.success ? detail.data.error : `Work board request failed (${response.status})`);
  }
  const value = await response.json();
  if (runtime !== getRuntimeKey()) throw new Error('Runtime changed during work board request');
  return value;
}
export async function completeWorkBoardCards(directory: string, targets: CompletionTarget[]) {
  return z.object({ completed: z.array(z.string()), failed: z.array(z.object({ id: z.string(), error: z.string() })) })
    .parse(await request('/api/work-board/complete', 'POST', { directory, targets }));
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
