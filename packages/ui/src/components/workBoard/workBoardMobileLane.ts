import type { WorkBoardLane } from './workBoardWorkflow';

/** The last selected mobile lane is remembered per client and connected server. */
const KEY_PREFIX = 'openchamber-work-board:mobile-lane:v1:';
const FALLBACK_LANE: WorkBoardLane = 'queue';

const isMobileWorkBoardLane = (value: string | null): value is WorkBoardLane =>
  value === 'todo' || value === 'plan' || value === 'queue' || value === 'build' || value === 'done';

const laneKey = (runtimeKey: string): string => KEY_PREFIX + runtimeKey;

/** Storage can be unavailable in private mode or while the mobile shell starts. */
export function readMobileWorkBoardLane(runtimeKey: string): WorkBoardLane {
  try {
    const stored = localStorage.getItem(laneKey(runtimeKey));
    return isMobileWorkBoardLane(stored) ? stored : FALLBACK_LANE;
  } catch {
    return FALLBACK_LANE;
  }
}

export function rememberMobileWorkBoardLane(runtimeKey: string, lane: WorkBoardLane): void {
  try {
    localStorage.setItem(laneKey(runtimeKey), lane);
  } catch {
    // The in-memory selection still works when storage is disabled.
  }
}
