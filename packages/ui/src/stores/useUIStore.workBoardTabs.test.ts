import { afterEach, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();

afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

test('Work Board tabs hydrate per runtime, keep explicit empty lists, and persist updates', async () => {
  const writes: unknown[] = [];
  useUIStore.persist.setOptions({
    ...originalOptions,
    storage: {
      getItem: () => ({
        version: 24,
        state: {
          workBoardProjectTabsByRuntime: {
            'runtime-a': { projectIds: ['alpha', 'alpha', ' ', 'beta'], activeProjectId: 'removed' },
            'runtime-b': { projectIds: [], activeProjectId: null },
          },
        },
      }),
      setItem: (_name, value) => { writes.push(value); },
      removeItem: () => undefined,
    },
  });
  useUIStore.setState(useUIStore.getInitialState(), true);
  await useUIStore.persist.rehydrate();

  expect(useUIStore.getState().workBoardProjectTabsByRuntime).toEqual({
    'runtime-a': { projectIds: ['alpha', 'beta'], activeProjectId: 'alpha' },
    'runtime-b': { projectIds: [], activeProjectId: null },
  });

  useUIStore.getState().setWorkBoardProjectTabs('runtime-a', {
    projectIds: ['beta', 'gamma'],
    activeProjectId: 'gamma',
  });
  expect(writes.at(-1)).toMatchObject({
    state: {
      workBoardProjectTabsByRuntime: {
        'runtime-a': { projectIds: ['beta', 'gamma'], activeProjectId: 'gamma' },
        'runtime-b': { projectIds: [], activeProjectId: null },
      },
    },
  });
  expect(useUIStore.getState().workBoardSessionDays).toBe(30);
  useUIStore.getState().setWorkBoardSessionDays(7);
  expect(useUIStore.getState().workBoardSessionDays).toBe(7);
  expect(writes.at(-1)).toMatchObject({ state: { workBoardSessionDays: 7 } });
});

test('the session window keeps its default and drops the old per-board record on hydration', async () => {
  const key = JSON.stringify(['runtime-a', '/alpha']);
  useUIStore.persist.setOptions({
    ...originalOptions,
    storage: {
      getItem: () => ({ version: 26, state: { workBoardOlderSessions: { [key]: true } } }),
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  });
  useUIStore.setState(useUIStore.getInitialState(), true);
  await useUIStore.persist.rehydrate();
  expect(useUIStore.getState().workBoardSessionDays).toBe(30);
  expect('workBoardOlderSessions' in useUIStore.getState()).toBe(false);
});
