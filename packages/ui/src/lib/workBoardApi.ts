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
type PlacementWrite = { lane: PlacementLane; expectedUpdatedAt?: number; before?: string | null }
  | { directory: string; lane: PlacementLane; targets: PlacementTarget[] };
type QueueSettingsWrite = { directory: string; enabled: boolean | null };
type QueueRepositoryWrite = { directory: string; repository: string | null };

export class WorkBoardRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'WorkBoardRequestError';
  }
}

async function request(path: string, method = 'GET', body?: BoardWrite | PlacementWrite | QueueSettingsWrite | QueueRepositoryWrite) {
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
 * Put a card where the user dropped it or checked it off. The server stamps the
 * placement with its own clock, so two devices order by one source; the card's
 * version travels with the write so a card another device changed is a 409, not
 * an overwrite. `before` names the card it now sits in front of, which is how
 * one lane's order travels; null places it at the end.
 */
export async function placeWorkBoardCard(card: Pick<WorkBoardCard, 'id' | 'directory' | 'text' | 'sessionId' | 'updatedAt'>, lane: PlacementLane, before: string | null): Promise<WorkBoardCard> {
  return z.object({ card: cardSchema })
    .parse(await request(`/api/work-board/${encodeURIComponent(card.id)}/placement`, 'POST',
      { lane, expectedUpdatedAt: card.updatedAt, before, directory: card.directory, sessionId: card.sessionId, text: card.text })).card;
}
export async function placeWorkBoardCards(directory: string, lane: PlacementLane, targets: PlacementTarget[]) {
  return z.object({ placed: z.array(cardSchema), failed: z.array(z.object({ id: z.string(), error: z.string() })) })
    .parse(await request('/api/work-board/placement', 'POST', { directory, lane, targets }));
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

/**
 * The board's server-owned projection: effective lanes, order, queue state and
 * live activity, derived once per directory by the server. The client renders
 * this directly instead of classifying history itself, so two tabs agree and a
 * settled lane needs no client poll.
 */
const snapshotCardSchema = cardSchema.extend({
  lane: z.enum(['todo', 'plan', 'queue', 'build', 'done']),
  // A linked card's session status: known, unavailable (a read failed), unknown
  // (not read yet), or none (no session).
  status: z.enum(['known', 'unavailable', 'unknown', 'none']),
  // What the user can do with this card, decided by the server once.
  availableActions: z.array(z.enum(['complete', 'acknowledge', 'startPlan', 'returnToTodo', 'remove'])),
});
/**
 * One history record the board's lane and feedback rules read. The server sends
 * only these fields, not the whole transcript, so the client cannot depend on
 * more than the board decides with. v2 wire records use `type`; the server maps
 * it to `role` here.
 */
const activityMessageSchema = z.object({
  id: z.string(), sessionID: z.string(),
  role: z.enum(['user', 'idle', 'assistant']),
  time: z.object({ created: z.number() }),
  outcome: z.string().optional(),
  agent: z.string().optional(),
});
/** The model a queued build was submitted with, as the queue captured it. */
const queuedModelSchema = z.object({
  providerID: z.string(), id: z.string(), variant: z.string().optional(),
});
const queueStateSchema = z.object({
  known: z.boolean(),
  // The project's queue enablement, independent of whether the queue could be
  // read: the toggle shows the saved choice either way.
  enabled: z.boolean().nullable(),
  rows: z.array(z.object({
    itemId: z.string(), sessionId: z.string(), directory: z.string(), content: z.string(), paused: z.boolean(), position: z.number(),
    model: queuedModelSchema.nullable(),
  })),
  order: z.array(z.string()),
  active: z.object({
    sessionId: z.string(), itemId: z.string().nullable(), startedAt: z.number(),
    needsReview: z.boolean(), retryAvailable: z.boolean(),
    content: z.string().nullable(), model: queuedModelSchema.nullable(),
  }).nullable(),
  forced: z.array(z.object({
    sessionId: z.string(), startedAt: z.number(),
    // A forced build that may not have started carries its target item and the
    // recovery the runtime offers; a plain forced build carries nulls.
    itemId: z.string().nullable(), needsReview: z.boolean(), action: z.string().nullable(),
    content: z.string().nullable(), model: queuedModelSchema.nullable(),
  })),
  issue: z.string().nullable(),
  preparation: z.object({ directory: z.string(), phase: z.string() }).nullable(),
  commit: z.object({ directory: z.string(), hash: z.string(), subject: z.string() }).nullable(),
});
const snapshotSchema = z.object({
  directory: z.string(),
  revision: z.number(),
  lanes: z.record(z.string(), z.enum(['todo', 'plan', 'queue', 'build', 'done'])),
  order: z.record(z.string(), z.array(z.string())),
  cards: z.array(snapshotCardSchema),
  placements: z.record(z.string(), z.object({
    lane: z.enum(['todo', 'plan', 'queue', 'build', 'done']), completedAt: z.number(),
    updatedAt: z.number(), sessionId: z.string().optional(),
  })),
  activities: z.record(z.string(), z.object({ busy: z.boolean(), messages: z.array(activityMessageSchema) })),
  // The session's own name by id, for the sessions this snapshot names. A
  // client that has not loaded the session list itself still labels a queue row
  // or a linked card from here. Optional so a cached client survives a server
  // that predates the field.
  sessionTitles: z.record(z.string(), z.string()).optional(),
  // The ask a session is waiting on, by session: a session busy because it waits
  // for the user's answer is not working, so the board must not paint it as such.
  // Separate from `activities` because an ask survives a failed history read.
  waitingFor: z.record(z.string(), z.enum(['permission', 'question'])),
  unavailable: z.array(z.string()),
  // False when the session list could not be read and no earlier read stands:
  // the board then cannot promise it has every inherited card.
  inheritedAvailable: z.boolean(),
  queue: queueStateSchema,
});
export type WorkBoardSnapshot = z.infer<typeof snapshotSchema>;
export type WorkBoardSnapshotCard = z.infer<typeof snapshotCardSchema>;
export type WorkBoardActivityMessage = z.infer<typeof activityMessageSchema>;
export type WorkBoardQueuedModel = z.infer<typeof queuedModelSchema>;
export type WorkBoardWaitingKind = WorkBoardSnapshot['waitingFor'][string];

/**
 * Read the board projection. A failure throws, so the caller keeps the board it
 * already had rather than replacing it with an empty one.
 */
export async function fetchWorkBoardSnapshot(directory: string, includeOlder = false): Promise<WorkBoardSnapshot> {
  return snapshotSchema.parse(await request(`/api/work-board/snapshot?directory=${encodeURIComponent(directory)}&includeOlder=${includeOlder ? 'true' : 'false'}`));
}

/**
 * Set the project's queue enablement: `true` or `false` is the project's own
 * choice, `null` clears it so the project follows the instance default. The
 * effective value comes back so the board can settle its optimistic switch.
 */
export async function updateQueueSettings(directory: string, enabled: boolean | null): Promise<boolean> {
  const body = z.object({ enabled: z.boolean() }).parse(await request('/api/build-queue/settings', 'PUT', { directory, enabled }));
  return body.enabled;
}

/** The project's effective enablement and the choice it stores, if any. */
export async function fetchQueueSettings(directory: string): Promise<{ enabled: boolean; override: boolean | null; repository: string | null }> {
  return z.object({
    enabled: z.boolean(),
    override: z.boolean().nullable(),
    // A server that predates the choice answers without the field, which is
    // "no choice", not a failed read.
    repository: z.string().nullish().transform(value => value ?? null),
  }).parse(await request(`/api/build-queue/settings?directory=${encodeURIComponent(directory)}`));
}

/**
 * Point this project's queue at one repository inside it, or clear the choice
 * with `null` so the queue resolves the repository from the directory it is
 * dispatching. The stored path comes back, which is the server's canonical
 * form of what was sent.
 */
export async function updateQueueRepository(directory: string, repository: string | null): Promise<string | null> {
  const body = z.object({ repository: z.string().nullable() })
    .parse(await request('/api/build-queue/repository', 'PUT', { directory, repository }));
  return body.repository;
}
