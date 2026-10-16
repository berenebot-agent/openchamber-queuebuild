import type { WorkBoardCard } from '@/lib/workBoardApi';
import type { Message } from '@/lib/opencode/model';
import type { WorkBoardActivity, WorkBoardLane } from './workBoardWorkflow';

export type BoardSnapshot = {
  cards: WorkBoardCard[];
  activities: Map<string, WorkBoardActivity>;
  versions: Map<string, number>;
  placements: Map<string, { lane: WorkBoardLane; completedAt: number; updatedAt: number; sessionId?: string }>;
};

// These are the only history records read by board lane, ordering and feedback
// rules. Drop transcript context, token usage, errors and tool payload metadata.
function summarizeHistory(messages: Message[]): Message[] {
  const kept = new Map<string, Message>();
  for (const message of [...messages].reverse()) {
    if (kept.has(message.role)) continue;
    const base = { id: message.id, sessionID: message.sessionID, time: { created: message.time.created } };
    if (message.role === 'user') kept.set(message.role, { ...base, role: 'user' });
    if (message.role === 'idle') kept.set(message.role, { ...base, role: 'idle', outcome: message.outcome });
    if (message.role === 'assistant') kept.set(message.role, {
      ...base, role: 'assistant', agent: message.agent, providerID: message.providerID, modelID: message.modelID,
    });
  }
  return [...kept.values()].reverse();
}

// Display continuity only. Every restored board still checks current activity.
const snapshots = new Map<string, { value: BoardSnapshot; bytes: number }>();
const MAX_BOARDS = 8;
const MAX_BYTES = 4 * 1024 * 1024;

const keyFor = (runtime: string, directory: string) => JSON.stringify([runtime, directory]);

export function readWorkBoardMemory(runtime: string, directory: string): BoardSnapshot | undefined {
  const key = keyFor(runtime, directory);
  const entry = snapshots.get(key);
  if (!entry) return undefined;
  snapshots.delete(key);
  snapshots.set(key, entry);
  return entry.value;
}

export function rememberWorkBoard(runtime: string, directory: string, value: BoardSnapshot): void {
  if (!directory) return;
  const key = keyFor(runtime, directory);
  snapshots.delete(key);
  // Preview cards cannot be edited or sent before the authoritative fetch
  // restores their full text and attachment bytes.
  const preview: BoardSnapshot = {
    cards: value.cards.map(card => ({ ...card, text: card.text.trim().split(/\r?\n/, 1)[0].slice(0, 512),
      attachments: card.attachments.map(file => ({ ...file, dataUrl: '' })) })),
    activities: new Map([...value.activities].map(([id, activity]) => [id, { busy: activity.busy, messages: summarizeHistory(activity.messages) }])),
    versions: new Map(value.versions),
    placements: new Map(value.placements),
  };
  const bytes = JSON.stringify([preview.cards, [...preview.activities], [...preview.versions], [...preview.placements]]).length * 2;
  if (bytes > MAX_BYTES) return;
  snapshots.set(key, { value: preview, bytes });
  let total = [...snapshots.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [oldKey, entry] of snapshots) {
    if (snapshots.size <= MAX_BOARDS && total <= MAX_BYTES) break;
    snapshots.delete(oldKey);
    total -= entry.bytes;
  }
}
