import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useNotificationStore } from '@/sync/notification-store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { makeSnapshot } from './workBoardSnapshot.fixture';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const gitHealth = (overrides: { state?: 'clean' | 'dirty'; changed?: number; added?: number; removed?: number; blocked?: boolean } = {}) => (
  { state: 'dirty', repository: '/repo', branch: 'main', head: 'abc', changed: 5, paths: ['a.ts'], added: 12, removed: 3, blocked: false, ...overrides }
);

/**
 * The Git pill sits in the Build lane's head. The Commit/Discard bar shows only
 * when the queue is held by Git or switched off, never while a queued build is
 * simply running on a dirty tree.
 */
test('the Build lane shows the Git pill, and the Git bar only when the queue is held or off', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    HTMLIFrameElement: dom.HTMLIFrameElement, MutationObserver: dom.MutationObserver,
    KeyboardEvent: dom.KeyboardEvent,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  Object.defineProperty(dom.document, 'visibilityState', { value: 'visible', configurable: true });
  const { WorkBoardView } = await import('./WorkBoardView');
  const { I18nProvider } = await import('@/lib/i18n');
  const projects = useProjectsStore.getState();
  const ui = useUIStore.getState();
  const config = useConfigStore.getState();
  const sessions = useGlobalSessionsStore.getState();
  const notifications = useNotificationStore.getState();
  let health = gitHealth();
  let enabled = true;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue/git-health')) return Response.json(health);
    if (url.includes('/api/build-queue/settings')) return Response.json({ enabled });
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/api/work-board/snapshot')) return Response.json(makeSnapshot({ cards: [], queue: { enabled } }));
    if (url.includes('/api/work-board')) return Response.json({ cards: [] });
    return Response.json({});
  });
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repository', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } } });
  useConfigStore.setState({ agents: [] });
  useGlobalSessionsStore.setState({ activeSessions: [], status: 'ready', hasLoaded: true });
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  const mount = async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await sleep(80); });
    return { container, done: async () => { await act(async () => root.unmount()); container.remove(); } };
  };
  const heading = (container: HTMLElement) => container.querySelector('section[aria-label="Build queue"] h2')!.textContent;
  const hasBar = (container: HTMLElement) => (container.textContent ?? '').includes('Commit…');
  try {
    // Dirty with the queue on: the pill carries the lines and replaces the count, no bar.
    let view = await mount();
    expect(heading(view.container)).toBe('BuildGit+12−3');
    expect(hasBar(view.container)).toBe(false);
    await view.done();

    // Held by Git: the bar offers Commit and Discard.
    health = gitHealth({ blocked: true });
    view = await mount();
    expect(hasBar(view.container)).toBe(true);
    expect(view.container.textContent).toContain('Discard…');
    await view.done();

    // Queue off: a dirty tree still offers them.
    health = gitHealth(); enabled = false;
    view = await mount();
    expect(hasBar(view.container)).toBe(true);
    await view.done();

    // Clean: green pill with no numbers, no bar.
    health = gitHealth({ state: 'clean', changed: 0, added: 0, removed: 0 }); enabled = true;
    view = await mount();
    expect(heading(view.container)).toBe('BuildGit');
    expect(hasBar(view.container)).toBe(false);
    await view.done();
  } finally {
    fetchSpy.mockRestore();
    useProjectsStore.setState(projects); useUIStore.setState(ui); useConfigStore.setState(config);
    useGlobalSessionsStore.setState(sessions); useNotificationStore.setState(notifications);
    await dom.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 15000);
