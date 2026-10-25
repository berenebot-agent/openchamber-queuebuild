import { beforeEach, describe, expect, test } from 'bun:test';

import { useSessionTabsStore } from './useSessionTabsStore';

const state = () => useSessionTabsStore.getState();

describe('useSessionTabsStore', () => {
  beforeEach(() => {
    useSessionTabsStore.setState({ tabIds: [], previewTabId: null, pinOnOpenIds: [], closedTabIds: [] });
  });

  test('opening a session uses the preview tab, replacing the previous preview in place', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b'] });
    state().ensureTab('c');
    expect(state().tabIds).toEqual(['a', 'b', 'c']);
    expect(state().previewTabId).toBe('c');
    state().reorderTabs('a', 'b');
    state().ensureTab('d');
    expect(state().tabIds).toEqual(['b', 'a', 'd']);
    expect(state().previewTabId).toBe('d');
  });

  test('reopening a session that has a tab changes nothing', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b'], previewTabId: 'b' });
    const before = state().tabIds;
    state().ensureTab('a');
    expect(state().tabIds).toBe(before);
    expect(state().previewTabId).toBe('b');
  });

  test('pinTab keeps the preview tab, so the next open adds a new one', () => {
    state().ensureTab('a');
    state().pinTab('a');
    expect(state().previewTabId).toBeNull();
    state().ensureTab('b');
    expect(state().tabIds).toEqual(['a', 'b']);
    expect(state().previewTabId).toBe('b');
  });

  test('a session pinned before its tab exists opens pinned', () => {
    useSessionTabsStore.setState({ tabIds: ['a'], previewTabId: 'a' });
    state().pinTab('new');
    state().ensureTab('new');
    expect(state().tabIds).toEqual(['a', 'new']);
    expect(state().previewTabId).toBe('a');
    expect(state().pinOnOpenIds).toEqual([]);
  });

  test('dragging the preview tab pins it', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b'], previewTabId: 'b' });
    state().reorderTabs('b', 'a');
    expect(state().tabIds).toEqual(['b', 'a']);
    expect(state().previewTabId).toBeNull();
  });

  test('lanes of one run share a tab, keeping its pinned or preview state', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'lane-1', 'b', 'lane-2'], previewTabId: 'b' });
    state().ensureTab('lane-3', ['lane-1', 'lane-2', 'lane-3']);
    expect(state().tabIds).toEqual(['a', 'lane-3', 'b']);
    expect(state().previewTabId).toBe('b');

    useSessionTabsStore.setState({ tabIds: ['a', 'lane-1'], previewTabId: 'lane-1' });
    state().ensureTab('lane-2', ['lane-1', 'lane-2']);
    expect(state().tabIds).toEqual(['a', 'lane-2']);
    expect(state().previewTabId).toBe('lane-2');
  });

  test('closing tabs clears the preview when it goes', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b', 'c'], previewTabId: 'b' });
    state().closeTab('b');
    expect(state().tabIds).toEqual(['a', 'c']);
    expect(state().previewTabId).toBeNull();

    useSessionTabsStore.setState({ tabIds: ['a', 'b', 'c'], previewTabId: 'b' });
    state().closeOtherTabs('c');
    expect(state().tabIds).toEqual(['c']);
    expect(state().previewTabId).toBeNull();

    useSessionTabsStore.setState({ tabIds: ['a', 'b'], previewTabId: 'b' });
    state().removeTabs(['b']);
    expect(state().tabIds).toEqual(['a']);
    expect(state().previewTabId).toBeNull();
  });

  test('reorderTabs ignores unknown ids', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b', 'c'] });
    state().reorderTabs('c', 'a');
    expect(state().tabIds).toEqual(['c', 'a', 'b']);
    const before = state().tabIds;
    state().reorderTabs('x', 'a');
    expect(state().tabIds).toBe(before);
  });

  test('caps pinned tabs at 10, evicting the oldest pinned one', () => {
    useSessionTabsStore.setState({ tabIds: Array.from({ length: 10 }, (_, i) => `s${i}`) });
    state().ensureTab('s-new');
    expect(state().tabIds).toHaveLength(11);
    state().pinTab('s-new');
    const ids = state().tabIds;
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe('s1');
    expect(ids.at(-1)).toBe('s-new');
  });

  test('removeTabs drops only confirmed-gone ids and no-ops otherwise', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b'] });
    const before = state().tabIds;
    state().removeTabs(['x']);
    expect(state().tabIds).toBe(before);
    state().removeTabs(['a']);
    expect(state().tabIds).toEqual(['b']);
  });

  test('closeTab records the closed session so ensureTab does not re-add it', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b'], previewTabId: 'b' });
    state().closeTab('b');
    expect(state().tabIds).toEqual(['a']);
    expect(state().previewTabId).toBeNull();
    expect(state().closedTabIds).toEqual(['b']);

    // A stale window writing its old tab list ['a', 'b'] must not resurrect 'b'
    state().ensureTab('b');
    expect(state().tabIds).toEqual(['a']);
    expect(state().closedTabIds).toEqual(['b']);
  });

  test('closeOtherTabs records all closed sessions', () => {
    useSessionTabsStore.setState({ tabIds: ['a', 'b', 'c'], previewTabId: 'c' });
    state().closeOtherTabs('a');
    expect(state().tabIds).toEqual(['a']);
    expect(state().previewTabId).toBeNull();
    expect(state().closedTabIds).toEqual(['b', 'c']);
  });

  test('pinTab clears the close marker when the user intentionally reopens', () => {
    useSessionTabsStore.setState({ tabIds: ['a'], closedTabIds: ['b'] });
    state().pinTab('b');
    expect(state().closedTabIds).toEqual([]);
    // ensureTab would then add it (not tested here since it requires the tab to not exist)
  });

  test('reopenClosedTab clears the close marker without adding a tab', () => {
    useSessionTabsStore.setState({ tabIds: ['a'], closedTabIds: ['b', 'c'] });
    state().reopenClosedTab('b');
    expect(state().closedTabIds).toEqual(['c']);
    expect(state().tabIds).toEqual(['a']); // tab not automatically added
  });

  test('ensureTab respects closedTabIds from persisted state', () => {
    // Simulate persisted state where 'b' was previously closed
    useSessionTabsStore.setState({ tabIds: ['a'], previewTabId: null, closedTabIds: ['b'] });
    state().ensureTab('b');
    expect(state().tabIds).toEqual(['a']);
    expect(state().closedTabIds).toEqual(['b']);
  });
});
