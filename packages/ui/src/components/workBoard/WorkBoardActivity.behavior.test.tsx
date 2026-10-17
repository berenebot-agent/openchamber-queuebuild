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
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { makeSnapshot, snapshotCard } from './workBoardSnapshot.fixture';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * The board draws live activity from the server projection, not from its own
 * history poll: six settled Build cards all render in Build complete on the
 * first snapshot, and the board itself never reads a session's messages. The
 * server's history read and its caching are covered by the projection's
 * activity test (`packages/web/server/lib/work-board/activity.test.js`).
 */
test('the board renders server-provided activity without reading session history itself', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator,
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
  const sessionUI = useSessionUIStore.getState();
  const sessionStatus = useGlobalSessionStatusStore.getState();
  const sessionDisplay = useSessionDisplayStore.getState();
  const suffixes = ['a', 'b', 'c', 'd', 'e', 'f'];
  const cards = suffixes.map((suffix, index) => snapshotCard({
    id: `card-${suffix}`, lane: 'build', text: `Brief ${suffix}`, sessionId: `session-${suffix}`, updatedAt: index + 1,
  }));
  const activities = Object.fromEntries(suffixes.map(suffix => [`session-${suffix}`, { busy: false, messages: [
    { id: `build-${suffix}`, sessionID: `session-${suffix}`, role: 'assistant' as const, agent: 'build', time: { created: 4 } },
    { id: `idle-${suffix}`, sessionID: `session-${suffix}`, role: 'idle' as const, outcome: 'succeeded', time: { created: 5 } },
  ] }]));
  const sessionRecords = suffixes.map((suffix, index) => ({
    id: `session-${suffix}`, directory: '/repo', projectID: 'project', title: `Session ${suffix}`,
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: index + 1, updated: index + 2 },
  }));
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue/settings')) return Response.json({ enabled: true });
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/api/work-board/snapshot')) return Response.json(makeSnapshot({ cards, activities }));
    if (url.includes('/api/work-board')) return Response.json({ cards });
    return Response.json({});
  });
  // The board must not read session history on its own; that read belongs to the
  // server projection now.
  const historySpy = spyOn(opencodeClient, 'getSessionMessages').mockResolvedValue({ items: [], cursor: {} });
  const draftSpy = spyOn(useSessionUIStore.getState(), 'openNewSessionDraft').mockImplementation(() => {});
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repository', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } } });
  useConfigStore.setState({ agents: [] });
  useGlobalSessionsStore.setState({ activeSessions: sessionRecords, status: 'ready', hasLoaded: true });
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  useSessionDisplayStore.setState({ animatedActivityIndicators: false });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await sleep(40); });
    // All six settled Build cards sit in Build complete on the first snapshot.
    expect(container.querySelector('section[aria-label="Build complete"]')!.querySelectorAll('article')).toHaveLength(6);
    expect(container.querySelector('section[aria-label="Plan"]')!.querySelectorAll('article')).toHaveLength(0);
    expect(container.textContent).not.toContain('Status unavailable');
    // The board never read a session's history itself.
    expect(historySpy.mock.calls).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore(); historySpy.mockRestore(); draftSpy.mockRestore();
    useProjectsStore.setState(projects); useUIStore.setState(ui); useConfigStore.setState(config);
    useGlobalSessionsStore.setState(sessions); useNotificationStore.setState(notifications);
    useSessionUIStore.setState(sessionUI); useGlobalSessionStatusStore.setState(sessionStatus);
    useSessionDisplayStore.setState(sessionDisplay);
    await dom.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
}, 15000);
