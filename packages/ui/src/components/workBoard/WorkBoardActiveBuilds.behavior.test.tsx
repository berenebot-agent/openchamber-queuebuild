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
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { BuildQueueSnapshot } from '@/hooks/useBuildQueueSnapshot';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('live builds without queue entries remain visible and reconcile without duplicates', async () => {
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
  const sessionDisplay = useSessionDisplayStore.getState();
  const sessionRecords = ['direct-a', 'direct-b', 'planning'].map(id => ({
    id, directory: '/repo', projectID: 'project', title: id,
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: 3 },
  }));
  let running = true;
  let queue: BuildQueueSnapshot = { revision: 1, active: [], queued: [], issues: [] };
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue')) return Response.json(queue);
    if (url.includes('/api/work-board')) return Response.json({ cards: [] });
    return Response.json({});
  });
  const statusSpy = spyOn(opencodeClient, 'getActiveSessionStatuses').mockImplementation(async (): ReturnType<typeof opencodeClient.getActiveSessionStatuses> => running
    ? { 'direct-a': { type: 'busy' }, 'direct-b': { type: 'busy' }, planning: { type: 'busy' } }
    : {});
  const historySpy = spyOn(opencodeClient, 'getSessionMessages').mockImplementation(async sessionId => ({
    items: [{ info: {
      id: `assistant-${sessionId}`, sessionID: sessionId, role: 'assistant',
      agent: sessionId === 'planning' ? 'plan' : 'build', providerID: 'provider', modelID: 'model',
      time: { created: 2, completed: 3 },
    }, parts: [] }], cursor: {},
  }));
  const openSpy = spyOn(useSessionUIStore.getState(), 'setCurrentSession').mockImplementation(() => {});
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repository', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } } });
  useConfigStore.setState({ agents: [] });
  useGlobalSessionsStore.setState({ activeSessions: sessionRecords, status: 'ready', hasLoaded: true });
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  useSessionDisplayStore.setState({ animatedActivityIndicators: false });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const lane = (name: string) => container.querySelector(`section[aria-label="${name}"]`)!;
  const openButtons = () => lane('Build queue').querySelectorAll<HTMLButtonElement>('button[aria-label^="Open the build running now:"]');
  const refreshQueue = async () => {
    await act(async () => { dom.document.dispatchEvent(new dom.Event('visibilitychange')); await sleep(30); });
  };
  try {
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await sleep(50); });
    expect([...openButtons()].map(button => button.textContent)).toHaveLength(2);
    expect(lane('Build queue').textContent).toContain('direct-a');
    expect(lane('Build queue').textContent).toContain('direct-b');
    expect(lane('Build queue').querySelector('h2')?.textContent).toBe('Build queue2');
    expect(lane('Build queue').querySelector('button[aria-label="New Build session"]')).toBeNull();
    expect(lane('Build queue').querySelector('button[aria-label^="Cancel "]')).toBeNull();
    expect(lane('Plan').textContent).toContain('planning');
    await act(async () => { openButtons()[0].click(); });
    expect(openSpy.mock.calls.at(-1)).toEqual(['direct-a', '/repo']);

    // Queue authority can arrive after the live read. Each session still has one
    // row, and only the waiting queue item gains queue controls.
    queue = {
      revision: 2, issues: [],
      active: [{ directory: '/repo', sessionId: 'direct-a', itemId: 'active-a', startedAt: 1 }],
      queued: [{ directory: '/repo', sessionId: 'direct-b', id: 'waiting-b', content: 'Queued build', createdAt: 1, order: 0, paused: false }],
    };
    await refreshQueue();
    expect(openButtons()).toHaveLength(1);
    expect(lane('Build queue').querySelectorAll('.oc-build-stripes')).toHaveLength(1);
    expect(lane('Build queue').querySelectorAll('button[aria-label="Cancel direct-b"]')).toHaveLength(1);
    expect(lane('Build queue').querySelector('h2')?.textContent).toBe('Build queue2');

    // A queue read failing cannot hide builds whose live activity is known.
    fetchSpy.mockImplementation(async input => {
      const url = String(input instanceof Request ? input.url : input);
      return url.includes('/api/build-queue') ? new Response('', { status: 503 }) : Response.json({ cards: [] });
    });
    await refreshQueue();
    expect(openButtons()).toHaveLength(2);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('503');

    fetchSpy.mockImplementation(async input => {
      const url = String(input instanceof Request ? input.url : input);
      return url.includes('/api/build-queue') ? Response.json({ revision: 3, active: [], queued: [], issues: [] }) : Response.json({ cards: [] });
    });
    await refreshQueue();
    running = false;
    await act(async () => { await sleep(5200); });
    expect(openButtons()).toHaveLength(0);
    expect(lane('Done').textContent).toContain('direct-a');
    expect(lane('Done').textContent).toContain('direct-b');
    expect(lane('Plan').textContent).toContain('planning');
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore(); statusSpy.mockRestore(); historySpy.mockRestore(); openSpy.mockRestore();
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
