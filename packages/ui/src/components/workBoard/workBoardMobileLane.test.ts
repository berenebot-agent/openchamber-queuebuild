import { afterEach, describe, expect, it, vi } from 'vitest';
import { readMobileWorkBoardLane, rememberMobileWorkBoardLane } from './workBoardMobileLane';

const values = new Map<string, string>();
const fakeStorage = {
  getItem: vi.fn((key: string) => values.get(key) ?? null),
  setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
};

afterEach(() => {
  values.clear();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('mobile Work Board lane preference', () => {
  it('opens Queue on a first visit and restores the last selected lane', () => {
    vi.stubGlobal('localStorage', fakeStorage);
    expect(readMobileWorkBoardLane('server-a')).toBe('queue');
    rememberMobileWorkBoardLane('server-a', 'plan');
    expect(readMobileWorkBoardLane('server-a')).toBe('plan');
    rememberMobileWorkBoardLane('server-a', 'done');
    expect(readMobileWorkBoardLane('server-a')).toBe('done');
  });

  it('does not carry a remembered lane between different server connections', () => {
    vi.stubGlobal('localStorage', fakeStorage);
    rememberMobileWorkBoardLane('server-a', 'todo');
    expect(readMobileWorkBoardLane('server-b')).toBe('queue');
    expect(readMobileWorkBoardLane('server-a')).toBe('todo');
  });

  it('falls back to Queue for invalid or inaccessible stored state', () => {
    vi.stubGlobal('localStorage', fakeStorage);
    values.set('openchamber-work-board:mobile-lane:v1:server-a', 'unknown');
    expect(readMobileWorkBoardLane('server-a')).toBe('queue');
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('storage blocked'); },
      setItem: () => { throw new Error('storage blocked'); },
    });
    expect(readMobileWorkBoardLane('server-a')).toBe('queue');
    expect(() => rememberMobileWorkBoardLane('server-a', 'plan')).not.toThrow();
  });
});
