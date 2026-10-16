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
  expect(useUIStore.getState().workBoardOlderSessions).toEqual({});
  useUIStore.getState().setWorkBoardOlderSessions('runtime-a', '/alpha', true);
  const key = JSON.stringify(['runtime-a', '/alpha']);
  expect(useUIStore.getState().workBoardOlderSessions[key]).toBe(true);
  expect(useUIStore.getState().workBoardOlderSessions[JSON.stringify(['runtime-b', '/alpha'])]).toBeUndefined();
  expect(useUIStore.getState().workBoardOlderSessions[JSON.stringify(['runtime-a', '/beta'])]).toBeUndefined();
  expect(writes.at(-1)).toMatchObject({ state: { workBoardOlderSessions: { [key]: true } } });
});

test('older-session preferences survive hydration and migrate from UI state version 25', async () => {
  const key = JSON.stringify(['runtime-a', '/alpha']);
  useUIStore.persist.setOptions({
    ...originalOptions,
    storage: {
      getItem: () => ({ version: 25, state: { workBoardOlderSessions: { [key]: true } } }),
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  });
  useUIStore.setState(useUIStore.getInitialState(), true);
  await useUIStore.persist.rehydrate();
  expect(useUIStore.getState().workBoardOlderSessions).toEqual({ [key]: true });
});
