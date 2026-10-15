import { afterEach, expect, test } from 'bun:test';
import { useUIStore } from './useUIStore';

const originalOptions = useUIStore.persist.getOptions();
const originalState = useUIStore.getState();

afterEach(() => {
  useUIStore.persist.setOptions(originalOptions);
  useUIStore.setState(originalState, true);
});

const rehydrateFrom = async (state: { workBoardProjectId?: string | number | object | null }, version = originalOptions.version) => {
  useUIStore.persist.setOptions({ storage: {
    getItem: () => ({ version, state }),
    setItem: () => undefined,
    removeItem: () => undefined,
  } });
  useUIStore.setState(useUIStore.getInitialState(), true);
  await useUIStore.persist.rehydrate();
};

test('the remembered board survives a reload', async () => {
  await rehydrateFrom({ workBoardProjectId: 'proj_1' });
  expect(useUIStore.getState().workBoardProjectId).toBe('proj_1');
});

test('the persisted projection carries the remembered board', () => {
  useUIStore.setState({ workBoardProjectId: 'proj_2' });
  const persisted = useUIStore.persist.getOptions().partialize?.(useUIStore.getState());
  expect(persisted).toMatchObject({ workBoardProjectId: 'proj_2' });
});

test('state written before the field existed loads without a remembered board', async () => {
  await rehydrateFrom({}, 24);
  expect(useUIStore.getState().workBoardProjectId).toBeNull();
});

for (const malformed of ['', '   ', 42, {}, null]) {
  test(`a malformed remembered board (${JSON.stringify(malformed)}) reads as none`, async () => {
    await rehydrateFrom({ workBoardProjectId: malformed });
    expect(useUIStore.getState().workBoardProjectId).toBeNull();
  });
}
