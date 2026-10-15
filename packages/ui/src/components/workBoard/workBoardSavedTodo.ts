import { create } from 'zustand';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { WorkBoardCard } from '@/lib/workBoardApi';
import { useUIStore } from '@/stores/useUIStore';

type SavedTodo = { runtimeKey: string; card: WorkBoardCard };

/** Transient save confirmation. The server card remains the durable source. */
export const useWorkBoardSavedTodo = create<{
  latestSave: SavedTodo | null;
  confirmation: SavedTodo | null;
}>(() => ({ latestSave: null, confirmation: null }));

export function completeTodoSave(card: WorkBoardCard, newDraftProjectId?: string): void {
  const runtimeKey = getRuntimeKey();
  const saved = { runtimeKey, card };
  useWorkBoardSavedTodo.setState({ latestSave: saved, confirmation: newDraftProjectId ? saved : null });
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
