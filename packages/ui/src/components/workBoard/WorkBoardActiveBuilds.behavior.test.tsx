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
import { makeSnapshot, snapshotCard } from './workBoardSnapshot.fixture';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Live builds the board has no queue entry for. The server projection places
 * them in the queue lane with their own status; the board renders them once per
 * session, with no queue mutation controls, and a Plan turn running gets the
 * green band instead of the blue one.
 */
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
    time: { created: 1, updated: Date.now() },
  }));
  // Two live Build sessions the queue does not manage, and one running Plan.
  let snapshot: WorkBoardSnapshot = makeSnapshot({
    cards: [
      snapshotCard({ id: 'session:direct-a', lane: 'queue', text: 'direct-a', sessionId: 'direct-a', stage: 'done' }),
      snapshotCard({ id: 'session:direct-b', lane: 'queue', text: 'direct-b', sessionId: 'direct-b', stage: 'done' }),
      snapshotCard({ id: 'session:planning', lane: 'plan', text: 'planning', sessionId: 'planning', stage: 'plan' }),
    ],
    activities: {
      'direct-a': { busy: false, messages: [] },
      'direct-b': { busy: false, messages: [] },
      planning: { busy: true, messages: [] },
    },
  });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue/settings')) return Response.json({ enabled: true });
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/api/work-board/snapshot')) return Response.json(snapshot);
    if (url.includes('/api/work-board')) return Response.json({ cards: snapshot.cards });
    return Response.json({});
  });
  const openSpy = spyOn(useSessionUIStore.getState(), 'setCurrentSession').mockImplementation(() => {});
  const closeSurfacesSpy = spyOn(useUIStore.getState(), 'closeMainSurfaces');
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
  const refresh = async () => {
    await act(async () => { dom.document.dispatchEvent(new dom.Event('visibilitychange')); await sleep(30); });
  };
  try {
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await sleep(50); });
    expect([...openButtons()].map(button => button.textContent)).toHaveLength(2);
    expect(lane('Build queue').textContent).toContain('direct-a');
    expect(lane('Build queue').textContent).toContain('direct-b');
    expect(lane('Build queue').querySelector('h2')?.textContent).toBe('Build queue2');
    // A live build the queue does not manage offers no queue mutation controls.
    expect(lane('Build queue').querySelector('button[aria-label="New Build session"]')).toBeNull();
    expect(lane('Build queue').querySelector('button[aria-label^="Cancel "]')).toBeNull();
    expect(lane('Plan').textContent).toContain('planning');
    // A running plan turn gets the same moving band as a running build, but in
    // green: the plan card carries the plan stripe and the build card does not.
    const planCard = lane('Plan').querySelector('button[title="planning"]')!.closest('article')!;
    expect(planCard.querySelector('.oc-build-stripes-plan')).not.toBeNull();
    expect(planCard.hasAttribute('data-work-board-working')).toBe(true);
    await act(async () => { openButtons()[0].click(); });
    expect(openSpy.mock.calls.at(-1)).toEqual(['direct-a', '/repo']);

    // The server now manages one of them: it becomes a queue row with controls,
    // and the other stays a live build without them.
    snapshot = makeSnapshot({
      cards: snapshot.cards,
      activities: snapshot.activities,
      queue: {
        active: { sessionId: 'direct-a', itemId: 'active-a', startedAt: 1, needsReview: false, retryAvailable: false, content: null, model: null },
        rows: [{ itemId: 'waiting-b', sessionId: 'direct-b', directory: '/repo', content: 'Queued build', paused: false, position: 0, model: null }],
        order: ['waiting-b'],
      },
    });
    await refresh();
    expect(openButtons()).toHaveLength(1);
    expect(lane('Build queue').querySelectorAll('.oc-build-stripes')).toHaveLength(1);
    expect(lane('Build queue').querySelector('.oc-build-stripes-plan')).toBeNull();
    expect(lane('Build queue').querySelectorAll('button[aria-label="Cancel direct-b"]')).toHaveLength(1);
    expect(lane('Build queue').querySelector('h2')?.textContent).toBe('Build queue2');
    // Opening a build/queue session must also dismiss the board.
    expect(closeSurfacesSpy.mock.calls).toHaveLength(1);

    // A queue read failing cannot hide builds whose live activity is known: the
    // snapshot still carries them, and the queue section reports its own failure
    // rather than an empty queue.
    snapshot = makeSnapshot({
      cards: [
        snapshotCard({ id: 'session:direct-a', lane: 'queue', text: 'direct-a', sessionId: 'direct-a', stage: 'done' }),
        snapshotCard({ id: 'session:direct-b', lane: 'build', text: 'direct-b', sessionId: 'direct-b', stage: 'done' }),
        snapshotCard({ id: 'session:planning', lane: 'plan', text: 'planning', sessionId: 'planning', stage: 'plan' }),
      ],
      activities: snapshot.activities,
      queue: { known: false },
    });
    await refresh();
    expect(openButtons()).toHaveLength(1);
    expect(container.querySelector('[role="alert"]')?.textContent).toBeTruthy();
    expect(lane('Build complete').textContent).toContain('direct-b');
    expect(lane('Plan').textContent).toContain('planning');
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore(); openSpy.mockRestore(); closeSurfacesSpy.mockRestore();
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

/**
 * A session waiting for the user's answer is busy in OpenCode's status the whole
 * time it waits, so the board must not paint it as running: no moving band, no
 * "Active" pill, the ask named instead, and the question mark on the card.
 */
test('a session waiting for an answer stops reading as active and names the ask', async () => {
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
  const sessionRecords = ['planning', 'lease'].map(id => ({
    id, directory: '/repo', projectID: 'project', title: id,
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: 1, updated: Date.now() },
  }));
  const card = snapshotCard({ id: 'session:planning', lane: 'plan', text: 'planning', sessionId: 'planning', stage: 'plan' });
  const queue = { active: { sessionId: 'lease', itemId: 'lease', startedAt: 1, needsReview: false, retryAvailable: false, content: null, model: null } };
  // Both wait on a question while OpenCode still reports their turns busy.
  let snapshot: WorkBoardSnapshot = makeSnapshot({
    cards: [card],
    activities: { planning: { busy: true, messages: [] }, lease: { busy: true, messages: [] } },
    waitingFor: { planning: 'question', lease: 'question' },
    queue,
  });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue/settings')) return Response.json({ enabled: true });
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/api/work-board/snapshot')) return Response.json(snapshot);
    if (url.includes('/api/work-board')) return Response.json({ cards: snapshot.cards });
    return Response.json({});
  });
  const openSpy = spyOn(useSessionUIStore.getState(), 'setCurrentSession').mockImplementation(() => {});
  const closeSurfacesSpy = spyOn(useUIStore.getState(), 'closeMainSurfaces');
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
  const planCard = () => lane('Plan').querySelector('button[title="planning"]')!.closest('article')!;
  const leaseRow = () => lane('Build queue').querySelector('button[aria-label^="Open the build running now:"]')!;
  const refresh = async () => {
    await act(async () => { dom.document.dispatchEvent(new dom.Event('visibilitychange')); await sleep(30); });
  };
  try {
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await sleep(50); });
    // The plan turn is busy, but it waits for the user: no band, no green
    // "working" treatment, the ask named, and the question mark on the card.
    expect(planCard().hasAttribute('data-work-board-working')).toBe(false);
    expect(planCard().querySelector('.oc-build-stripes-plan')).toBeNull();
    expect(planCard().textContent).toContain('Pending question');
    expect(planCard().querySelector('use[href="#oc-question"]')).not.toBeNull();
    // The running lease is the same session state: no band, no Active pill.
    expect(leaseRow().querySelector('.oc-build-stripes')).toBeNull();
    expect(leaseRow().textContent).not.toContain('Active');
    expect(leaseRow().textContent).toContain('Pending question');
    expect(leaseRow().querySelector('use[href="#oc-question"]')).not.toBeNull();

    // The answer arrives: the same busy turn reads as running again.
    snapshot = makeSnapshot({
      cards: [card],
      activities: snapshot.activities,
      queue,
    });
    await refresh();
    expect(planCard().hasAttribute('data-work-board-working')).toBe(true);
    expect(planCard().querySelector('.oc-build-stripes-plan')).not.toBeNull();
    expect(planCard().textContent).not.toContain('Pending question');
    expect(leaseRow().querySelector('.oc-build-stripes')).not.toBeNull();
    expect(leaseRow().textContent).toContain('Active');
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore(); openSpy.mockRestore(); closeSurfacesSpy.mockRestore();
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

/**
 * A forced build whose prompt may not have started is ambiguous. It must not
 * read as a plain running build, and it must offer its own recovery.
 */
test('an unconfirmed forced build shows its recovery instead of reading as running', async () => {
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
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const snapshot = makeSnapshot({
    queue: {
      forced: [{ sessionId: 'forced-1', startedAt: 2, itemId: 'item-1', needsReview: true, action: 'resolve', content: null, model: null }],
    },
  });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue/settings')) return Response.json({ enabled: true });
    if (url.includes('/api/build-queue')) {
      if (init?.method) requests.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null });
      return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    }
    if (url.includes('/api/work-board/snapshot')) return Response.json(snapshot);
    if (url.includes('/api/work-board')) return Response.json({ cards: [] });
    return Response.json({});
  });
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repository', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } } });
  useConfigStore.setState({ agents: [] });
  useGlobalSessionsStore.setState({ activeSessions: [], status: 'ready' });
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  useSessionDisplayStore.setState({ animatedActivityIndicators: false });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await sleep(40); });
    const lane = container.querySelector('section[aria-label="Build queue"]')!;
    expect(lane.textContent).toContain('The prompt was not confirmed');
    // It is not presented as an active running build.
    expect(lane.querySelector('.oc-build-stripes')).toBeNull();
    const recover = [...lane.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Continue queue');
    if (!recover) throw new Error('Missing forced-build recovery');
    await act(async () => { recover.click(); await sleep(30); });
    expect(requests.at(-1)?.url.endsWith('/api/build-queue/resolve')).toBe(true);
    expect(requests.at(-1)?.body).toEqual({ directory: '/repo', itemId: 'item-1', action: 'skip' });
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
