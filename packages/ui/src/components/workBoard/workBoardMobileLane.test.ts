import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { readMobileWorkBoardLane, rememberMobileWorkBoardLane } from './workBoardMobileLane';

class TestStorage implements Storage {
  #values = new Map<string, string>();

  get length(): number { return this.#values.size; }
  clear(): void { this.#values.clear(); }
  getItem(key: string): string | null { return this.#values.get(key) ?? null; }
  key(index: number): string | null { return [...this.#values.keys()][index] ?? null; }
  removeItem(key: string): void { this.#values.delete(key); }
  setItem(key: string, value: string): void { this.#values.set(key, value); }
}

const originalLocalStorage = globalThis.localStorage;
let storage: TestStorage;

beforeEach(() => {
  storage = new TestStorage();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
});

afterEach(() => {
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: originalLocalStorage });
});

describe('mobile Work Board lane preference', () => {
  test('opens on the queue lane when nothing was chosen yet', () => {
    expect(readMobileWorkBoardLane('server-a')).toBe('queue');
  });

  test('reopens on the lane the user left', () => {
    rememberMobileWorkBoardLane('server-a', 'plan');
    expect(readMobileWorkBoardLane('server-a')).toBe('plan');

    rememberMobileWorkBoardLane('server-a', 'done');
    expect(readMobileWorkBoardLane('server-a')).toBe('done');
  });

  test('restores the Build complete lane like any other lane', () => {
    rememberMobileWorkBoardLane('server-a', 'build');
    expect(readMobileWorkBoardLane('server-a')).toBe('build');
  });

  test('keeps each connected server on its own lane', () => {
    rememberMobileWorkBoardLane('server-a', 'todo');
    expect(readMobileWorkBoardLane('server-b')).toBe('queue');
    expect(readMobileWorkBoardLane('server-a')).toBe('todo');
  });

  test('ignores a stored lane that is not a lane', () => {
    storage.setItem('openchamber-work-board:mobile-lane:v1:server-a', 'unknown');
    expect(readMobileWorkBoardLane('server-a')).toBe('queue');
  });

  test('falls back to the queue lane when storage is blocked', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('storage blocked'); },
    });

    // Remembering has nowhere to write; the read still answers, and a lane the
    // user picks in this session keeps working until the app is closed.
    rememberMobileWorkBoardLane('server-a', 'plan');
    expect(readMobileWorkBoardLane('server-a')).toBe('queue');
  });
});
