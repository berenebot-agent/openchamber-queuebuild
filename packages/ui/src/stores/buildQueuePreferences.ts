import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

/** Per-workspace opt-in. The server owns jobs; this only controls composer routing. */
interface BuildQueuePreferences {
  enabled: Record<string, boolean>;
  isEnabled: (directory: string) => boolean;
  setEnabled: (directory: string, enabled: boolean) => void;
}

export const useBuildQueuePreferences = create<BuildQueuePreferences>()(
  persist(
    (set, get) => ({
      enabled: {},
      isEnabled: (directory) => get().enabled[directory.replace(/\\/g, '/').replace(/\/+$/, '')] === true,
      setEnabled: (directory, enabled) => set((state) => ({
        enabled: { ...state.enabled, [directory.replace(/\\/g, '/').replace(/\/+$/, '')]: enabled },
      })),
    }),
    { name: 'openchamber-project-build-queue', storage: createJSONStorage(() => localStorage), partialize: (state) => ({ enabled: state.enabled }) },
  ),
);
