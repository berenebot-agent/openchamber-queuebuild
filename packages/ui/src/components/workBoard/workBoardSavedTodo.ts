import { create } from 'zustand';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { WorkBoardCard } from '@/lib/workBoardApi';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { readWorkBoardCards, persistWorkBoardCards } from '@/sync/persist-cache';
import { readWorkBoardMemory, rememberWorkBoard } from './workBoardMemory';

type SavedTodo = { runtimeKey: string; card: WorkBoardCard };
/** A card the user opened, waiting for its composer to take its brief. */
type TodoLoad = { runtimeKey: string; card: WorkBoardCard };

/**
 * Transient save notice and the brief a composer has been asked to open. The
 * server card remains the durable source; both entries are cleared by their
 * consumer and are scoped to the runtime that asked.
 */
export const useWorkBoardSavedTodo = create<{
  latestSave: SavedTodo | null;
  pendingLoad: TodoLoad | null;
}>(() => ({ latestSave: null, pendingLoad: null }));

/**
 * Ask the composer for `card` to take its brief as the draft: the session's
 * composer for a linked card, the open new-session draft for a card without a
 * session. The card's own session id decides which composer takes it.
 */
export function requestTodoLoad(card: WorkBoardCard): void {
  useWorkBoardSavedTodo.setState({ pendingLoad: { runtimeKey: getRuntimeKey(), card } });
}

/** Drop a request the composer has taken, or one it will not. */
export function clearTodoLoad(cardId: string): void {
  const pending = useWorkBoardSavedTodo.getState().pendingLoad;
  if (pending?.card.id === cardId) useWorkBoardSavedTodo.setState({ pendingLoad: null });
}

export function completeTodoSave(card: WorkBoardCard): void {
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
}

/** Show the board on the project that owns `directory`, so a save lands back on its card. */
export function showWorkBoardForDirectory(directory: string): void {
  if (!directory) return;
  const runtimeKey = getRuntimeKey();
  const project = useProjectsStore.getState().projects
    .filter(item => directory === item.path || directory.startsWith(item.path + '/'))
    .sort((left, right) => right.path.length - left.path.length)[0];
  if (!project) return;
  const ui = useUIStore.getState();
  const tabs = ui.workBoardProjectTabsByRuntime[runtimeKey];
  ui.setWorkBoardProjectTabs(runtimeKey, {
    projectIds: [...new Set([...(tabs?.projectIds ?? []), project.id])],
    activeProjectId: project.id,
  });
  ui.setWorkBoardProjectId(project.id);
  ui.setWorkBoardOpen(true);
}
