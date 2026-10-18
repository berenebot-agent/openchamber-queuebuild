import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { ProjectEntry } from '@/lib/api/types';
import { readRecentWorkBoardProjects, recentWorkBoardProjectOrder, rememberWorkBoardProjectAccess } from './workBoardRecentProjects';

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

const project = (id: string): ProjectEntry => ({ id, path: `/${id}`, label: id });

describe('mobile Work Board recent projects', () => {
  test('starts with nothing remembered', () => {
    expect(readRecentWorkBoardProjects('server-a')).toEqual([]);
  });

  test('moves the opened board to the front and drops the older copy', () => {
    rememberWorkBoardProjectAccess('server-a', 'alpha');
    rememberWorkBoardProjectAccess('server-a', 'beta');
    rememberWorkBoardProjectAccess('server-a', 'alpha');
    expect(readRecentWorkBoardProjects('server-a')).toEqual(['alpha', 'beta']);
  });

  test('keeps each connected server on its own list', () => {
    rememberWorkBoardProjectAccess('server-a', 'alpha');
    expect(readRecentWorkBoardProjects('server-b')).toEqual([]);
    rememberWorkBoardProjectAccess('server-b', 'beta');
    expect(readRecentWorkBoardProjects('server-a')).toEqual(['alpha']);
  });

  test('orders the picker recent-first and leaves the rest where they were', () => {
    const projects = [project('alpha'), project('beta'), project('gamma'), project('delta')];
    expect(recentWorkBoardProjectOrder(projects, ['gamma', 'alpha']).map(entry => entry.id))
      .toEqual(['gamma', 'alpha', 'beta', 'delta']);
    // No memory at all keeps the incoming order.
    expect(recentWorkBoardProjectOrder(projects, []).map(entry => entry.id))
      .toEqual(['alpha', 'beta', 'gamma', 'delta']);
  });

  test('reads an empty list when storage holds nothing usable, and remembers nothing when blocked', () => {
    storage.setItem('openchamber-work-board:recent-projects:v1:server-a', '');
    expect(readRecentWorkBoardProjects('server-a')).toEqual([]);

    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get: () => { throw new Error('storage blocked'); },
    });
    // The read still answers, and remembering has nowhere to write without throwing.
    rememberWorkBoardProjectAccess('server-a', 'alpha');
    expect(readRecentWorkBoardProjects('server-a')).toEqual([]);
  });
});
