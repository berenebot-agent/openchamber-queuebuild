import type { WorkBoardCard } from '@/lib/workBoardApi';
import type { WorkBoardActivity } from './workBoardWorkflow';

type BoardSnapshot = {
  cards: WorkBoardCard[];
  activities: Map<string, WorkBoardActivity>;
};

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
  const bytes = JSON.stringify([value.cards, [...value.activities]]).length * 2;
  if (bytes > MAX_BYTES) return;
  snapshots.set(key, { value, bytes });
  let total = [...snapshots.values()].reduce((sum, entry) => sum + entry.bytes, 0);
  for (const [oldKey, entry] of snapshots) {
    if (snapshots.size <= MAX_BOARDS && total <= MAX_BYTES) break;
    snapshots.delete(oldKey);
    total -= entry.bytes;
  }
}
