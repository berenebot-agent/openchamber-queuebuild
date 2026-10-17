import type { WorkBoardLane } from './workBoardWorkflow';

/** Last selected mobile lane belongs to the client and connected server, not a project. */
const KEY_PREFIX = 'openchamber-work-board:mobile-lane:v1:';
const FALLBACK_LANE: WorkBoardLane = 'queue';

export const isMobileWorkBoardLane = (value: unknown): value is WorkBoardLane =>
  value === 'todo' || value === 'plan' || value === 'queue' || value === 'done';

const laneKey = (runtimeKey: string): string => KEY_PREFIX + runtimeKey;

/** Storage may be unavailable in private mode or when the mobile shell is initializing. */
export function readMobileWorkBoardLane(runtimeKey: string): WorkBoardLane {
  try {
    if (typeof localStorage === 'undefined') return FALLBACK_LANE;
    const stored = localStorage.getItem(laneKey(runtimeKey));
    return isMobileWorkBoardLane(stored) ? stored : FALLBACK_LANE;
  } catch {
    return FALLBACK_LANE;
  }
}

export function rememberMobileWorkBoardLane(runtimeKey: string, lane: WorkBoardLane): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(laneKey(runtimeKey), lane);
  } catch {
    // In-memory selection still works when storage is disabled.
  }
}
