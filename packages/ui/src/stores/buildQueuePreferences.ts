import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';

/**
 * Server authority for per-project Build queue opt-in. The persisted local
 * values are a one-time migration source for users of the original fork, not
 * a source of truth after the first successful server read.
 */
const directoryKey = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
type ProjectFlags = Record<string, boolean>;

interface BuildQueuePreferences {
  enabled: ProjectFlags;
  syncedRuntimeKey: string | null;
  syncError: string | null;
  isEnabled: (directory: string) => boolean;
  syncFromServer: (flags: ProjectFlags) => void;
  refresh: () => Promise<void>;
  setEnabled: (directory: string, enabled: boolean) => Promise<void>;
}

const flagsFrom = (value: unknown): ProjectFlags => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid server project queue settings');
  return Object.fromEntries(Object.entries(value).filter(([key, flag]) => Boolean(key) && typeof flag === 'boolean')
    .map(([key, flag]) => [directoryKey(key), flag as boolean]));
};

const fetchSnapshot = async (): Promise<ProjectFlags> => {
  const response = await runtimeFetch('/api/build-queue');
  if (!response.ok) throw new Error(`Cannot read shared Build queue settings (HTTP ${response.status})`);
  const json: unknown = await response.json();
  const record = json && typeof json === 'object' ? json as Record<string, unknown> : {};
  return flagsFrom(record.projectQueueEnabled);
};

const writeFlag = async (directory: string, enabled: boolean): Promise<ProjectFlags> => {
  const response = await runtimeFetch('/api/build-queue/projects', {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ directory, enabled }),
  });
  const json: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = json && typeof json === 'object' ? (json as { error?: string }).error : undefined;
    throw new Error(error || `Cannot update Build queue settings (HTTP ${response.status})`);
  }
  return flagsFrom(json && typeof json === 'object' ? (json as Record<string, unknown>).projectQueueEnabled : null);
};

export const useBuildQueuePreferences = create<BuildQueuePreferences>()(
  persist(
    (set, get) => ({
      enabled: {},
      syncedRuntimeKey: null,
      syncError: null,
      isEnabled: directory => get().enabled[directoryKey(directory)] === true,
      syncFromServer: flags => {
        const runtime = getRuntimeKey();
        const previous = get();
        const enabled = previous.syncedRuntimeKey && previous.syncedRuntimeKey !== runtime
          ? flags : { ...previous.enabled, ...flags };
        if (previous.syncedRuntimeKey === runtime
          && JSON.stringify(previous.enabled) === JSON.stringify(enabled) && !previous.syncError) return;
        set({ enabled, syncedRuntimeKey: runtime, syncError: null });
      },
      refresh: async () => {
        const runtime = getRuntimeKey();
        try {
          let flags = await fetchSnapshot();
          if (runtime !== getRuntimeKey()) return;
          const state = get();
          // Upgrade previously local-only enabled directories once. A saved
          // explicit false on the server always outranks old local state.
          if (!state.syncedRuntimeKey) {
            for (const [directory, enabled] of Object.entries(state.enabled)) {
              if (enabled && !(directory in flags)) {
                flags = await writeFlag(directory, true);
                if (runtime !== getRuntimeKey()) return;
              }
            }
          }
          get().syncFromServer(flags);
        } catch (error) {
          if (runtime === getRuntimeKey()) set({ syncError: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      },
      setEnabled: async (directory, enabled) => {
        const key = directoryKey(directory);
        if (!key) throw new Error('Project directory is required');
        const runtime = getRuntimeKey();
        const previous = get().enabled[key] === true;
        set(state => ({ enabled: { ...state.enabled, [key]: enabled }, syncError: null }));
        try {
          const updated = await writeFlag(key, enabled);
          if (runtime === getRuntimeKey()) get().syncFromServer(updated);
        } catch (error) {
          if (runtime === getRuntimeKey()) set(state => ({
            enabled: { ...state.enabled, [key]: previous },
            syncError: error instanceof Error ? error.message : String(error),
          }));
          throw error;
        }
      },
    }),
    { name: 'openchamber-project-build-queue', storage: createJSONStorage(() => localStorage),
      partialize: state => ({ enabled: state.enabled }) },
  ),
);
