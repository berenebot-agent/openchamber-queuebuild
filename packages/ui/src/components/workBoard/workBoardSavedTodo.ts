import { create } from 'zustand';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { WorkBoardCard } from '@/lib/workBoardApi';
import { useUIStore } from '@/stores/useUIStore';
import { readWorkBoardCards, persistWorkBoardCards } from '@/sync/persist-cache';
import { readWorkBoardMemory, rememberWorkBoard } from './workBoardMemory';

type SavedTodo = { runtimeKey: string; card: WorkBoardCard };

/** Transient save notice. The server card remains the durable source. */
export const useWorkBoardSavedTodo = create<{
  latestSave: SavedTodo | null;
}>(() => ({ latestSave: null }));

export function completeTodoSave(card: WorkBoardCard, newDraftProjectId?: string): void {
  const runtimeKey = getRuntimeKey();
  const saved = { runtimeKey, card };
  const cached = readWorkBoardCards(card.directory);
  if (cached) persistWorkBoardCards(card.directory, cached.some(entry => entry.id === card.id)
    ? cached.map(entry => entry.id === card.id ? card : entry) : [...cached, card]);
  const remembered = readWorkBoardMemory(runtimeKey, card.directory);
  if (remembered) rememberWorkBoard(runtimeKey, card.directory, { ...remembered,
    cards: remembered.cards.some(entry => entry.id === card.id)
      ? remembered.cards.map(entry => entry.id === card.id ? card : entry) : [...remembered.cards, card],
  });
  useWorkBoardSavedTodo.setState({ latestSave: saved });
  if (!newDraftProjectId) return;

  const ui = useUIStore.getState();
  const tabs = ui.workBoardProjectTabsByRuntime[runtimeKey];
  ui.setWorkBoardProjectTabs(runtimeKey, {
    projectIds: [...new Set([...(tabs?.projectIds ?? []), newDraftProjectId])],
    activeProjectId: newDraftProjectId,
  });
  ui.setWorkBoardProjectId(newDraftProjectId);
  ui.setWorkBoardOpen(true);
}
