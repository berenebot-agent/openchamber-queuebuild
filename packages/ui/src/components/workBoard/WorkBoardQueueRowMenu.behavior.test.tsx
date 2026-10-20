import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useNotificationStore } from '@/sync/notification-store';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { WorkBoardSnapshot } from '@/lib/workBoardApi';
import { makeSnapshot } from './workBoardSnapshot.fixture';
import { rememberMobileWorkBoardLane } from './workBoardMobileLane';

// A queued build is a card's peer: it carries the same menus, so the build the
// user is waiting on can be managed from its own row.

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a queued row carries the card menus: a three-dot menu, a right click, and one phone menu', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    HTMLIFrameElement: dom.HTMLIFrameElement, MutationObserver: dom.MutationObserver,
    Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, MouseEvent: dom.MouseEvent, DOMRect: dom.DOMRect,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  Object.defineProperty(dom.document, 'visibilityState', { value: 'visible', configurable: true });
  const { WorkBoardView } = await import('./WorkBoardView');
  const { I18nProvider } = await import('@/lib/i18n');
  const { SyncProvider } = await import('@/sync/sync-context');
  const { OpenCode } = await import('@opencode/client');
  const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: (input, init) => globalThis.fetch(input, init) });
  const projects = useProjectsStore.getState();
  const ui = useUIStore.getState();
  const config = useConfigStore.getState();
  const sessions = useGlobalSessionsStore.getState();
  const notifications = useNotificationStore.getState();
  const sessionUI = useSessionUIStore.getState();
  const sessionDisplay = useSessionDisplayStore.getState();
  const sessionRecord = (id: string) => ({
    id, directory: '/repo', projectID: 'project', title: id,
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: Date.now() },
  });
  const snapshot: WorkBoardSnapshot = makeSnapshot({
    queue: {
      rows: [{ itemId: 'queued-b', sessionId: 'direct-b', directory: '/repo', content: 'Queued build', paused: false, position: 0, model: null }],
      order: ['queued-b'],
    },
  });
  const requests: Array<{ url: string; method: string }> = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (url.includes('/api/build-queue/settings')) return Response.json({ enabled: true });
    if (url.includes('/api/build-queue')) {
      if (init?.method) requests.push({ url, method: init.method });
      return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    }
    if (url.includes('/api/work-board/snapshot')) return Response.json(snapshot);
    if (url.includes('/api/work-board')) return Response.json({ cards: [] });
    return Response.json({});
  });
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repository', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } } });
  useConfigStore.setState({ agents: [] });
  useGlobalSessionsStore.setState({ activeSessions: [sessionRecord('direct-b')], status: 'ready', hasLoaded: true });
  // The session menu reads the shared session index, so the row's session has
  // to be in it, not only in the list.
  useGlobalSessionsStore.getState().upsertSession(sessionRecord('direct-b'));
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  useSessionDisplayStore.setState({ animatedActivityIndicators: false });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const row = () => container.querySelector<HTMLElement>('[data-work-board-queue-row]');
  const menuTriggers = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-label="Actions for direct-b"]')];
  const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent).filter(Boolean);
  const clickItem = async (label: string) => {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent === label);
    if (!item) throw new Error(`Missing menu item: ${label}`);
    await act(async () => { item.click(); await sleep(30); });
  };
  try {
    await act(async () => { root.render(<I18nProvider><SyncProvider sdk={sdk} directory="/repo"><WorkBoardView /></SyncProvider></I18nProvider>); await sleep(50); });
    // The row carries the card's three-dot menu, and keeps its own controls.
    expect(menuTriggers()).toHaveLength(1);
    expect(container.querySelector('button[aria-label="Cancel direct-b"]')).not.toBeNull();
    // A right click on the row opens the same menu the three-dot shows: the
    // row's own queue actions, then the session actions the other cards show.
    const queuedRow = row();
    if (!queuedRow) throw new Error('Missing the queued row');
    await act(async () => {
      queuedRow.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 12, clientY: 24 }));
      await sleep(30);
    });
    expect(items()).toEqual([
      'Move up', 'Move down', 'Pause', 'Force', 'Cancel',
      'Rename', 'Rename with AI', 'Copy session ID', 'Export Markdown', 'Track as in work', 'Archive', 'Delete',
    ]);
    // The queue action in that menu writes the queue's own route.
    await clickItem('Cancel');
    const cancelled = requests.at(-1);
    expect(cancelled?.method).toBe('DELETE');
    expect(cancelled?.url.includes('/api/build-queue/sessions/direct-b/items/queued-b')).toBe(true);

    // A phone has no right click and no room for the row's own buttons, so the
    // row keeps one touch-sized menu that holds the same entries.
    rememberMobileWorkBoardLane(getRuntimeKey(), 'queue');
    const phoneContainer = document.createElement('div');
    document.body.appendChild(phoneContainer);
    const phoneRoot = createRoot(phoneContainer);
    try {
      await act(async () => { phoneRoot.render(<I18nProvider><SyncProvider sdk={sdk} directory="/repo"><WorkBoardView mobile /></SyncProvider></I18nProvider>); await sleep(50); });
      const phoneRow = phoneContainer.querySelector<HTMLElement>('[data-work-board-queue-row]');
      if (!phoneRow) throw new Error('Missing the queued row on the phone');
      const phoneTriggers = [...phoneRow.querySelectorAll<HTMLButtonElement>('button[aria-label="Actions for direct-b"]')];
      expect(phoneTriggers).toHaveLength(1);
      expect(phoneRow.querySelector('button[aria-label="Cancel direct-b"]')).toBeNull();
      await act(async () => { phoneTriggers[0].click(); await sleep(30); });
      expect(items()).toEqual([
        'Move up', 'Move down', 'Pause', 'Force', 'Cancel',
        'Rename', 'Rename with AI', 'Copy session ID', 'Export Markdown', 'Track as in work', 'Archive', 'Delete',
      ]);
    } finally {
      await act(async () => phoneRoot.unmount());
      phoneContainer.remove();
    }
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore();
    useProjectsStore.setState(projects); useUIStore.setState(ui); useConfigStore.setState(config);
    useGlobalSessionsStore.setState(sessions); useNotificationStore.setState(notifications);
    useSessionUIStore.setState(sessionUI); useSessionDisplayStore.setState(sessionDisplay);
    await dom.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 15000);
