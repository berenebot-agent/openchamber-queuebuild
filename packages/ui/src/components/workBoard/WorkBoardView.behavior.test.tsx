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
import { applyGlobalSessionStatusSnapshot, useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { applyGlobalBlockingRequestEvents, resetGlobalBlockingRequests } from '@/sync/global-blocking-requests';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { createChatDraftIdentity, getChatDraftIdentityKey } from '@/lib/chatDraftPersistence';
import { useInputStore } from '@/sync/input-store';
import { toast } from '@/components/ui';
import type { WorkBoardSnapshot } from '@/lib/workBoardApi';
import { completeTodoSave, showWorkBoardForDirectory, useWorkBoardSavedTodo } from './workBoardSavedTodo';
import { makeSnapshot, snapshotCard } from './workBoardSnapshot.fixture';

// The board is a server-owned projection now, so these tests drive it the way
// the browser does: a mocked `/api/work-board/snapshot` answers with derived
// lanes and order, and the board renders and acts on that. Lane classification
// itself is covered by the server projection tests.

const domGlobals = (dom: Window) => ({
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
  HTMLIFrameElement: dom.HTMLIFrameElement, HTMLTextAreaElement: dom.HTMLTextAreaElement, MutationObserver: dom.MutationObserver,
  Event: dom.Event, KeyboardEvent: dom.KeyboardEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
});

test('board actions, live activity and viewed turn attention use shared session behavior', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = domGlobals(dom);
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
  const cards: WorkBoardSnapshot['cards'] = [
    snapshotCard({ id: 'todo', lane: 'todo', text: 'Saved brief' }),
    snapshotCard({ id: 'plan', lane: 'plan', text: 'Inherited plan', sessionId: 'session1', stage: 'plan' }),
    snapshotCard({ id: 'older', lane: 'done', text: 'Older completion', completedAt: 5 }),
    snapshotCard({ id: 'newer', lane: 'done', text: 'Newer completion', completedAt: 10 }),
  ];
  let placementRequests = 0;
  let serverCards = cards;
  const activity: WorkBoardSnapshot['activities'] = {
    session1: { busy: false, messages: [
      { id: 'failed', sessionID: 'session1', role: 'idle', outcome: 'interrupted', time: { created: 5 } },
    ] },
  };
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.includes('/api/build-queue/settings')) return Response.json({ enabled: true });
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/api/work-board/snapshot')) {
      return Response.json(makeSnapshot({
        cards: serverCards.map(card => ({ ...card })),
        activities: activity,
      }));
    }
    if (url.includes('/api/work-board/placement') || url.includes('/placement')) {
      placementRequests += 1;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const ids: string[] = body.targets ? body.targets.map((target: { id: string }) => target.id) : ['plan'];
      const placed = ids.map(id => ({ ...serverCards.find(card => card.id === id)!, lane: 'done' as const, stage: 'done' as const, completedAt: 20 }));
      serverCards = serverCards.map(card => placed.find(entry => entry.id === card.id) ?? card);
      return Response.json(Array.isArray(body.targets) ? { placed, failed: [] } : { card: placed[0] });
    }
    if (url.endsWith('/api/work-board/todo') && method === 'PATCH') {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const updated = { ...serverCards.find(card => card.id === 'todo')!, text: body.text, updatedAt: 3 };
      serverCards = serverCards.map(card => card.id === 'todo' ? updated : card);
      return Response.json({ card: updated });
    }
    if (url.includes('/api/work-board')) return Response.json({ cards: serverCards });
    return Response.json({});
  });
  const draftSpy = spyOn(useSessionUIStore.getState(), 'openNewSessionDraft').mockImplementation(() => {});
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repository', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } } });
  useConfigStore.setState({ agents: ['plan', 'build'].map(name => ({ id: name, name, displayName: name, mode: 'primary', hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions: [] })) });
  useGlobalSessionsStore.setState({ activeSessions: [], status: 'ready' });
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  useNotificationStore.getState().append({ type: 'turn-complete', session: 'session1', directory: '/repo', time: Date.now(), viewed: false });
  useSessionDisplayStore.setState({ animatedActivityIndicators: false });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const button = (label: string) => {
    const element = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!element) throw new Error(`Missing button: ${label}`);
    return element;
  };
  try {
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(container.querySelector('header button[aria-label="New to-do"]')).toBeNull();
    // A card opens into its session, never into a form on the board: a To-do
    // brief is asked for as the composer's draft and written back to its card.
    const briefTitle = container.querySelector<HTMLButtonElement>('button[title="Saved brief"]');
    if (!briefTitle) throw new Error('Missing saved brief card');
    await act(async () => briefTitle.click());
    expect(container.querySelector('textarea')).toBeNull();
    expect(draftSpy.mock.calls.at(-1)).toEqual([{ selectedProjectId: 'project', target: 'project', directoryOverride: '/repo', origin: 'workBoard' }]);
    expect(useWorkBoardSavedTodo.getState().pendingLoad?.card.id).toBe('todo');
    useWorkBoardSavedTodo.setState({ pendingLoad: null });
    // Creating a new build now happens from the queue column's empty active
    // slot, beside the two lanes that still open a composer directly.
    for (const [label, lane, origin] of [['New to-do', 'To-do', 'workBoard'], ['New Plan session', 'Plan', 'workBoardPlan']]) {
      expect(button(label).closest('section')?.getAttribute('aria-label')).toBe(lane);
      await act(async () => button(label).click());
      expect(draftSpy.mock.calls.at(-1)).toEqual([{ selectedProjectId: 'project', target: 'project', directoryOverride: '/repo', origin }]);
    }
    expect(button('New Build session').closest('section')?.getAttribute('aria-label')).toBe('Build queue');
    await act(async () => button('New Build session').click());
    expect(draftSpy.mock.calls.at(-1)).toEqual([{ selectedProjectId: 'project', target: 'project', directoryOverride: '/repo', origin: 'workBoardBuild' }]);
    const done = container.querySelector('section[aria-label="Done"]');
    expect([...done!.querySelectorAll('article')].map(article => article.textContent)).toEqual(['Newer completion', 'Older completion']);
    // The Plan lane's own menu moves every card it can into Done, in one write.
    expect(placementRequests).toBe(0);
    await act(async () => { button('Column actions').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await new Promise(resolve => setTimeout(resolve, 20)); });
    const bulk = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Move all cards to Done');
    if (!bulk) throw new Error('Missing bulk completion action');
    await act(async () => { bulk.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(placementRequests).toBe(1);
    const linkedCard = () => container.querySelector('button[title="Inherited plan"]')!.closest('article')!;
    expect(linkedCard().textContent).toContain('Needs attention');
    expect(linkedCard().querySelector('[data-session-activity-indicator="unread"]')).not.toBeNull();
    // These updates use the same live index as the sidebar, without waiting
    // for a board history poll.
    await act(async () => applyGlobalSessionStatusSnapshot('/repo', { session1: { type: 'busy' } }));
    expect(linkedCard().querySelector('[data-session-activity-indicator="running"] use')?.getAttribute('href')).toBe('#oc-circle');
    await act(async () => useSessionDisplayStore.getState().setAnimatedActivityIndicators(true));
    expect(linkedCard().querySelector('[data-spinner]')).not.toBeNull();
    await act(async () => applyGlobalSessionStatusSnapshot('/repo', {}));
    expect(linkedCard().querySelector('[data-spinner]')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Inherited plan"]')!.click());
    expect(useSessionUIStore.getState().currentSessionId).toBe('session1');
    expect(linkedCard().textContent).not.toContain('Needs attention');
    const saved = { ...cards[0], text: 'Saved first line\nThe full saved dialogue', attachments: [
      { id: 'file1', filename: 'brief.txt', mimeType: 'text/plain', size: 2, dataUrl: 'data:text/plain;base64,aGk=' },
    ] };
    // A save returns to the board on the project that owns the card, and the
    // board itself never opens a dialog over the card it just wrote.
    await act(async () => { completeTodoSave(saved); showWorkBoardForDirectory(saved.directory); });
    expect(useUIStore.getState().isWorkBoardOpen).toBe(true);
    expect(useUIStore.getState().workBoardProjectTabsByRuntime[getRuntimeKey()]?.activeProjectId).toBe('project');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(useWorkBoardSavedTodo.getState().latestSave?.card.id).toBe(saved.id);
    // The move to Done stamps a fresh completion, so the card carries the
    // session list's unread mark until that completion is acknowledged.
    expect(linkedCard().querySelector('[data-session-activity-indicator="unread"]')).not.toBeNull();
    await act(async () => useNotificationStore.getState().append({ type: 'error', session: 'session1', directory: '/repo', time: Date.now(), viewed: false }));
    expect(linkedCard().textContent).toContain('Needs attention');
    expect(linkedCard().getAttribute('data-work-board-feedback')).toBe('blocked');
    // A card with nothing to report carries no marker.
    const quietCard = [...container.querySelectorAll<HTMLButtonElement>('article button[title]')]
      .find(button => button.title === 'Saved brief')?.closest('article');
    expect(quietCard?.getAttribute('data-work-board-feedback') ?? null).toBeNull();
    await act(async () => useSessionUIStore.getState().setCurrentSession('session1', '/repo'));
    expect(linkedCard().textContent).not.toContain('Needs attention');
    expect(linkedCard().getAttribute('data-work-board-feedback')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    useWorkBoardSavedTodo.setState({ latestSave: null });
    fetchSpy.mockRestore(); draftSpy.mockRestore();
    useProjectsStore.setState(projects); useUIStore.setState(ui); useConfigStore.setState(config); useGlobalSessionsStore.setState(sessions);
    useNotificationStore.setState(notifications); useSessionUIStore.setState(sessionUI);
    useGlobalSessionStatusStore.setState(sessionStatus); useSessionDisplayStore.setState(sessionDisplay);
    await dom.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
     }
  }
});

test('a completed card shows the green completion mark until it is opened, then clears on the server', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = domGlobals(dom);
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
  const cards: WorkBoardSnapshot['cards'] = [
    snapshotCard({ id: 'unviewed', lane: 'done', text: 'Finished build', stage: 'done', completedAt: 10 }),
    snapshotCard({ id: 'viewed', lane: 'done', text: 'Already seen', stage: 'done', completedAt: 5, viewedAt: 5 }),
  ];
  const viewedRequests: string[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue/settings')) return Response.json({ enabled: true });
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/viewed')) {
      viewedRequests.push(url);
      return Response.json({ card: { ...cards[0], viewedAt: 10 } });
    }
    if (url.includes('/api/work-board/snapshot')) return Response.json(makeSnapshot({ cards }));
    if (url.includes('/api/work-board')) return Response.json({ cards });
    return Response.json({});
  });
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repository', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } } });
  useConfigStore.setState({ agents: [] });
  useGlobalSessionsStore.setState({ activeSessions: [], status: 'ready' });
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const card = (title: string) => container.querySelector(`button[title="${title}"]`)!.closest('article')!;
  try {
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await new Promise(resolve => setTimeout(resolve, 30)); });
    const mark = card('Finished build').querySelector('[data-session-activity-indicator="unread"]');
    expect(mark).not.toBeNull();
    expect(mark!.querySelector('use')?.getAttribute('href')).toBe('#oc-checkbox-circle');
    expect(card('Finished build').querySelectorAll('[data-session-activity-indicator]')).toHaveLength(1);
    expect(card('Already seen').querySelector('[data-session-activity-indicator]')).toBeNull();
    await act(async () => { card('Finished build').querySelector<HTMLButtonElement>('button[title="Finished build"]')!.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(viewedRequests).toHaveLength(1);
    expect(viewedRequests[0]).toContain('/api/work-board/unviewed/viewed');
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore();
    useProjectsStore.setState(projects); useUIStore.setState(ui); useConfigStore.setState(config);
    useGlobalSessionsStore.setState(sessions); useNotificationStore.setState(notifications);
    useSessionUIStore.setState(sessionUI); useGlobalSessionStatusStore.setState(sessionStatus);
    await dom.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('an idle Build session is Build complete, and a build the queue holds for review stays in the queue column', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = domGlobals(dom);
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
  // The server's projection already placed a settled Build in Build complete and
  // a lease parked for review in the queue column.
  const cards: WorkBoardSnapshot['cards'] = [
    snapshotCard({ id: 'finished', lane: 'build', text: 'Finished build', sessionId: 'finished', availableActions: ['complete', 'returnToTodo'] }),
    snapshotCard({ id: 'review', lane: 'queue', text: 'Build needing review', sessionId: 'review', stage: 'done' }),
  ];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue/settings')) return Response.json({ enabled: true });
    if (url.includes('/api/build-queue')) return Response.json({
      revision: 1, issues: [],
      active: [{ directory: '/repo', sessionId: 'review', itemId: 'item1', startedAt: 1, needsReview: true, reviewReason: 'restart-unconfirmed' }],
      queued: [],
    });
    if (url.includes('/api/work-board/snapshot')) return Response.json(makeSnapshot({
      cards,
      queue: { active: { sessionId: 'review', itemId: 'item1', startedAt: 1, needsReview: true, retryAvailable: false, content: null, model: null } },
    }));
    if (url.includes('/api/work-board')) return Response.json({ cards });
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
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await new Promise(resolve => setTimeout(resolve, 40)); });
    const queue = container.querySelector('section[aria-label="Build queue"]')!;
    expect(queue.textContent).toContain('Waiting for review before the queue continues');
    // A parked lease is not running, so it carries no moving band.
    expect(queue.querySelector('.oc-build-stripes')).toBeNull();
    // Its card left the board's card lanes: it is queue work now, and offers no
    // card action that could hide the resolution being waited on.
    expect(container.querySelector('button[title="Build needing review"]')).toBeNull();
    expect(container.querySelector('[aria-label="Actions for Build needing review"]')).toBeNull();
    expect(container.querySelector('section[aria-label="Build complete"]')!.textContent).toContain('Finished build');
    expect(container.querySelector('[aria-label="Actions for Finished build"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore();
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
});

test('the build queue column runs one ordered list with its own row controls', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = domGlobals(dom);
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
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repository', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } } });
  useConfigStore.setState({ agents: [] });
  useGlobalSessionsStore.setState({ activeSessions: [], status: 'ready' });
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  useSessionDisplayStore.setState({ animatedActivityIndicators: false });
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  const infoSpy = spyOn(toast, 'info').mockImplementation(() => 'toast-id');
  useInputStore.setState({ pendingPromptAdoptions: new Map() });
  // Three queued builds in dispatch order and one still running. None of them
  // has a board card, and all three must still appear.
  const snapshot = makeSnapshot({
    queue: {
      active: { sessionId: 'running', itemId: 'active1', startedAt: 1, needsReview: false, retryAvailable: false, content: null, model: null },
      rows: [
        { itemId: 'queued1', sessionId: 's1', directory: '/repo', content: 'First build', paused: false, position: 0, model: { providerID: 'anthropic', id: 'claude' } },
        { itemId: 'queued2', sessionId: 's2', directory: '/repo', content: 'Second build', paused: true, position: 1, model: null },
        { itemId: 'queued3', sessionId: 's3', directory: '/repo', content: 'Third build', paused: false, position: 2, model: null },
      ],
      order: ['queued1', 'queued2', 'queued3'],
    },
  });
  // What the board reads once every waiting row has been paused, so the same
  // control flips from Pause all to Resume all.
  const allPausedSnapshot = makeSnapshot({
    queue: {
      active: { sessionId: 'running', itemId: 'active1', startedAt: 1, needsReview: false, retryAvailable: false, content: null, model: null },
      rows: [
        { itemId: 'queued1', sessionId: 's1', directory: '/repo', content: 'First build', paused: true, position: 0, model: { providerID: 'anthropic', id: 'claude' } },
        { itemId: 'queued2', sessionId: 's2', directory: '/repo', content: 'Second build', paused: true, position: 1, model: null },
        { itemId: 'queued3', sessionId: 's3', directory: '/repo', content: 'Third build', paused: true, position: 2, model: null },
      ],
      order: ['queued1', 'queued2', 'queued3'],
    },
  });
  let allPaused = false;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue/settings')) return Response.json({ enabled: true });
    if (url.includes('/api/build-queue')) {
      if (init?.method) requests.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null });
      // Once a pause-all write lands, the projection reads every waiting row paused.
      if (init?.method === 'PUT' && url.endsWith('/pause') && JSON.parse(String(init.body)).paused === true) allPaused = true;
      // A cancelled build hands its prompt back so the board can put it in the
      // session's draft.
      if (init?.method === 'DELETE') {
        return Response.json({
          revision: 2,
          session: { sessionId: 's3', directory: '/repo', items: [], sendingId: null },
          item: { content: 'Third build', attachments: [] },
        });
      }
      return Response.json({ revision: 1, issues: [], active: [], queued: [] });
    }
    if (url.includes('/api/work-board/snapshot')) return Response.json(allPaused ? allPausedSnapshot : snapshot);
    if (url.includes('/api/work-board')) return Response.json({ cards: [] });
    return Response.json({});
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const lane = () => container.querySelector('section[aria-label="Build queue"]')!;
  const click = async (label: string) => {
    const target = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    if (!target) throw new Error(`Missing control: ${label}`);
    await act(async () => { target.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
  };
  try {
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await new Promise(resolve => setTimeout(resolve, 40)); });
    const text = lane().textContent ?? '';
    expect(text).toContain('Up next');
    expect(text.indexOf('Building now')).toBeLessThan(text.indexOf('Up next'));
    const titles = [...lane().querySelectorAll('button[title^="Move "]')]
      .map(element => element.getAttribute('title')!.replace(/^Move /, '').replace(/ (up|down)$/, ''))
      .filter((title, index, all) => all.indexOf(title) === index);
    expect(titles).toEqual(['Session s1', 'Session s2', 'Session s3']);
    expect(text).toContain('First build');
    expect(text).toContain('Third build');
    expect(text).toContain('Paused');
    expect(text.indexOf('First build')).toBeLessThan(text.indexOf('Paused'));
    expect(lane().querySelector('.oc-build-stripes')).not.toBeNull();
    // Hovering a card names the model it was submitted with and shows its build
    // message.
    const firstRow = lane().querySelector<HTMLElement>('[data-slot="tooltip-trigger"]')!;
    await act(async () => {
      firstRow.dispatchEvent(new window.PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }));
      firstRow.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }));
      firstRow.dispatchEvent(new window.MouseEvent('mouseenter', { bubbles: true }));
      firstRow.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true }));
      // The house tooltip opens after Base UI's default hover delay.
      await new Promise(resolve => setTimeout(resolve, 700));
    });
    const cardTooltip = document.querySelector('[data-slot="tooltip-content"]');
    // The model and the message sit on their own rows, never one line.
    const tooltipRows = [...(cardTooltip?.firstElementChild?.children ?? [])].map(row => row.textContent);
    expect(tooltipRows).toEqual(['Model: Claude', 'First build']);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Move Session s1 up"]')?.disabled).toBe(true);
    expect(container.querySelector<HTMLButtonElement>('button[aria-label="Move Session s3 down"]')?.disabled).toBe(true);
    // A move sends the project's whole order with just those two swapped, so
    // the queue never loses a row the board cannot see.
    await click('Move Session s2 up');
    expect(requests.at(-1)?.method).toBe('PUT');
    expect(requests.at(-1)?.url.endsWith('/api/build-queue/order')).toBe(true);
    expect(requests.at(-1)?.body).toEqual({ directory: '/repo', ids: ['queued2', 'queued1', 'queued3'] });
    await click('Resume Session s2');
    expect(requests.at(-1)?.method).toBe('PUT');
    expect(requests.at(-1)?.url.endsWith('/api/build-queue/sessions/s2/items/queued2/pause')).toBe(true);
    expect(requests.at(-1)?.body).toEqual({ paused: false });
    // A running row carries the pause glyph, a paused row the play glyph.
    expect(container.querySelector('button[aria-label="Pause Session s1"] use[href="#oc-pause"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Resume Session s2"] use[href="#oc-play"]')).not.toBeNull();
    // Pause all hits the waiting builds, not the row that is already paused.
    await click('Pause all queued builds');
    expect(requests.slice(-2).map(request => [request.url.split('/sessions/')[1], request.body])).toEqual([
      ['s1/items/queued1/pause', { paused: true }],
      ['s3/items/queued3/pause', { paused: true }],
    ]);
    // Every waiting row now reads paused, so the one control resumes them all —
    // including the row paused on its own.
    await click('Resume all queued builds');
    expect(requests.slice(-3).map(request => [request.url.split('/sessions/')[1], request.body])).toEqual([
      ['s1/items/queued1/pause', { paused: false }],
      ['s2/items/queued2/pause', { paused: false }],
      ['s3/items/queued3/pause', { paused: false }],
    ]);
    await click('Cancel Session s3');
    expect(requests.at(-1)?.method).toBe('DELETE');
    expect(requests.at(-1)?.url.endsWith('/api/build-queue/sessions/s3/items/queued3')).toBe(true);
    expect(requests.at(-1)?.body).toBeNull();
    // The cancelled prompt is adopted into that session's draft, not discarded.
    const cancelledIdentity = createChatDraftIdentity(getRuntimeKey(), '/repo', 's3');
    expect(cancelledIdentity).not.toBeNull();
    expect(useInputStore.getState().pendingPromptAdoptions.get(getChatDraftIdentityKey(cancelledIdentity!)))
      .toEqual({ text: 'Third build', files: [] });
    expect(infoSpy.mock.calls.length).toBe(1);
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore();
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
});

test('returning from a chat opens the board on that session\'s project', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = domGlobals(dom);
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  Object.defineProperty(dom.document, 'visibilityState', { value: 'visible', configurable: true });
  const { WorkBoardView } = await import('./WorkBoardView');
  const { rememberWorkBoardReturn } = await import('./workBoardReturn');
  const { I18nProvider } = await import('@/lib/i18n');
  const projectState = useProjectsStore.getState();
  const ui = useUIStore.getState();
  const config = useConfigStore.getState();
  const sessions = useGlobalSessionsStore.getState();
  const notifications = useNotificationStore.getState();
  const sessionUI = useSessionUIStore.getState();
  const sessionStatus = useGlobalSessionStatusStore.getState();
  const card = (id: string): WorkBoardSnapshot['cards'][number] => snapshotCard({ id, lane: 'todo', text: `${id} brief` });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue/settings')) return Response.json({ enabled: true });
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/api/work-board/snapshot')) {
      const directory = new URL(url, 'http://localhost').searchParams.get('directory');
      return Response.json(makeSnapshot({ directory: directory ?? '/repo', cards: directory === '/other' ? [card('other-todo')] : [card('repo-todo')] }));
    }
    if (url.includes('/api/work-board')) {
      const directory = new URL(url, 'http://localhost').searchParams.get('directory');
      return Response.json({ cards: directory === '/repo' ? [card('repo-todo')]
        : directory === '/other' ? [card('other-todo')] : [] });
    }
    return Response.json({});
  });
  useProjectsStore.setState({
    projects: [
      { id: 'project', path: '/repo', label: 'Repository', addedAt: 1 },
      { id: 'other', path: '/other', label: 'Other', addedAt: 1 },
    ],
    activeProjectId: 'project', hasServerSnapshot: true,
  });
  useUIStore.setState({
    workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } },
    workBoardProjectId: 'project',
  });
  useConfigStore.setState({ agents: [] });
  useGlobalSessionsStore.setState({ activeSessions: [], status: 'ready' });
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(container.querySelector('button[title="repo-todo brief"]')).not.toBeNull();
    await act(async () => {
      useUIStore.getState().setWorkBoardOpen(false);
      useSessionUIStore.setState({ currentSessionId: 'session', currentSessionDirectory: '/other' });
      rememberWorkBoardReturn();
      useUIStore.getState().setWorkBoardOpen(true);
      await new Promise(resolve => setTimeout(resolve, 40));
    });
    expect(useUIStore.getState().workBoardProjectTabsByRuntime[getRuntimeKey()]).toEqual({
      projectIds: ['project', 'other'], activeProjectId: 'other',
    });
    expect(container.querySelector('button[title="other-todo brief"]')).not.toBeNull();
    expect(container.querySelector('button[title="repo-todo brief"]')).toBeNull();
    const tabs = container.querySelector('nav[aria-label="Work board projects"]');
    expect([...tabs!.querySelectorAll('button')].map(tab => tab.textContent).filter(text => text)).toEqual(['Repository', 'Other']);
    // A pending ask on a project the board is not showing still reaches its tab:
    // the cross-directory index is the only place that knows it.
    const tabFor = (label: string) => [...tabs!.querySelectorAll('button')]
      .find(button => button.textContent?.includes(label))?.parentElement;
    expect(tabFor('Other')!.querySelector('[data-work-board-ask]')).toBeNull();
    await act(async () => {
      applyGlobalBlockingRequestEvents('/other', [{
        type: 'form.created',
        properties: { form: { id: 'q1', sessionID: 'other-session', title: 'Pick one', fields: [{ key: 'answer', type: 'boolean' }] } },
      }]);
    });
    expect(tabFor('Other')!.querySelector('[data-work-board-ask="question"]')).not.toBeNull();
    expect(tabFor('Repository')!.querySelector('[data-work-board-ask]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore();
    useProjectsStore.setState(projectState); useUIStore.setState(ui); useConfigStore.setState(config);
    useGlobalSessionsStore.setState(sessions); useNotificationStore.setState(notifications);
    useSessionUIStore.setState(sessionUI); useGlobalSessionStatusStore.setState(sessionStatus);
    resetGlobalBlockingRequests();
    await dom.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('cards drag from the whole card, the check moves one to Done, and queue rows drag too', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = domGlobals(dom);
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
  const draftSpy = spyOn(useSessionUIStore.getState(), 'openNewSessionDraft').mockImplementation(() => {});
  let serverCards: WorkBoardSnapshot['cards'] = [snapshotCard({ id: 'todo', lane: 'todo', text: 'Draft the release notes' })];
  const placementBodies: Array<{ url: string; lane: string; before?: string | null }> = [];
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repository', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } } });
  useConfigStore.setState({ agents: [] });
  useGlobalSessionsStore.setState({ activeSessions: [], status: 'ready' });
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  useSessionDisplayStore.setState({ animatedActivityIndicators: false });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (url.includes('/api/build-queue/settings')) return Response.json({ enabled: true });
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/placement')) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      const id = url.match(/work-board\/([^/]+)\/placement/)?.[1];
      placementBodies.push({ url, lane: body.lane, before: body.before });
      if (id) {
        const placed = { ...serverCards.find(card => card.id === id)!, lane: 'done' as const, stage: 'done' as const, completedAt: 30 };
        serverCards = serverCards.map(card => card.id === id ? placed : card);
        return Response.json({ card: placed });
      }
      return Response.json({ placed: [], failed: [] });
    }
    if (url.includes('/api/work-board/snapshot')) return Response.json(makeSnapshot({ cards: serverCards }));
    if (url.includes('/api/work-board') && method === 'GET') return Response.json({ cards: serverCards });
    return Response.json({});
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await new Promise(resolve => setTimeout(resolve, 40)); });
    // One lane per card category, and every card lane takes a drop while the
    // build queue does not.
    expect([...container.querySelectorAll('section[data-work-board-lane]')].map(section => section.getAttribute('data-work-board-lane'))).toEqual(['todo', 'plan', 'queue', 'build', 'done']);
    const card = container.querySelector<HTMLElement>('article[aria-label="Drag Draft the release notes"]');
    expect(card).not.toBeNull();
    expect(card!.getAttribute('role')).toBe('button');
    // A press and release on the card body opens it into its session, never a
    // form on the board: the brief is asked for as the composer's draft.
    await act(async () => { card!.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(container.querySelector('textarea')).toBeNull();
    expect(draftSpy.mock.calls.at(-1)).toEqual([{ selectedProjectId: 'project', target: 'project', directoryOverride: '/repo', origin: 'workBoard' }]);
    expect(useWorkBoardSavedTodo.getState().pendingLoad?.card.id).toBe('todo');
    useWorkBoardSavedTodo.setState({ pendingLoad: null });
    const check = container.querySelector<HTMLButtonElement>('button[aria-label="Move Draft the release notes to Done"]');
    if (!check) throw new Error('Missing completion check');
    await act(async () => { check.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(placementBodies).toHaveLength(1);
    expect(placementBodies[0].lane).toBe('done');
    expect(container.querySelector('section[aria-label="Done"]')!.textContent).toContain('Draft the release notes');
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore(); draftSpy.mockRestore();
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
});

test('the board header opens this project\'s settings and closes the board', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = domGlobals(dom);
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
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue/settings')) return Response.json({ enabled: true });
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/api/work-board/snapshot')) return Response.json(makeSnapshot({ directory: '/repo', cards: [] }));
    if (url.includes('/api/work-board')) return Response.json({ cards: [] });
    return Response.json({});
  });
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repository', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({
    workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } },
    isWorkBoardOpen: true, isSettingsDialogOpen: false, settingsJumpRequest: null,
  });
  useConfigStore.setState({ agents: [] });
  useGlobalSessionsStore.setState({ activeSessions: [], status: 'ready' });
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await new Promise(resolve => setTimeout(resolve, 40)); });
    const settingsButton = container.querySelector<HTMLButtonElement>('button[title="Board settings"]');
    expect(settingsButton).not.toBeNull();
    await act(async () => { settingsButton!.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    // The board is a full-window surface; it steps aside so the Settings dialog is not behind it.
    expect(useUIStore.getState().isWorkBoardOpen).toBe(false);
    expect(useUIStore.getState().isSettingsDialogOpen).toBe(true);
    // The project's own overrides live on its page, so the jump selects this
    // board's project and targets the Work board section that holds them.
    expect(useUIStore.getState().settingsProjectsSelectedId).toBe('project');
    expect(useUIStore.getState().settingsJumpRequest).toEqual({ page: 'projects', itemId: 'projects.work-board' });
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore();
    useProjectsStore.setState(projects); useUIStore.setState(ui); useConfigStore.setState(config);
    useGlobalSessionsStore.setState(sessions); useNotificationStore.setState(notifications);
    useSessionUIStore.setState(sessionUI); useGlobalSessionStatusStore.setState(sessionStatus);
    await dom.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('the board search narrows every card lane as it is typed and leaves the build queue alone', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = domGlobals(dom);
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
  const cards: WorkBoardSnapshot['cards'] = [
    snapshotCard({ id: 'notes', lane: 'todo', text: 'Draft the release notes\nWith the detail lines' }),
    snapshotCard({ id: 'changelog', lane: 'todo', text: 'Update the changelog' }),
    snapshotCard({ id: 'redirect', lane: 'plan', text: 'Fix the login redirect', sessionId: 'session1', stage: 'plan' }),
    snapshotCard({ id: 'older', lane: 'done', text: 'Older completion', completedAt: 5 }),
  ];
  const snapshot = makeSnapshot({
    cards,
    sessionTitles: { 's-wait': 'Ship the queued build' },
    queue: {
      rows: [{ itemId: 'queued1', sessionId: 's-wait', directory: '/repo', content: 'Build it', paused: false, position: 0, model: null }],
      order: ['queued1'],
    },
  });
  const placements: string[][] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue/settings')) return Response.json({ enabled: true });
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/api/work-board/snapshot')) return Response.json(snapshot);
    if (url.includes('/placement')) {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      placements.push(Array.isArray(body.targets)
        ? body.targets.map((target: { id: string }) => target.id)
        : [url.match(/work-board\/([^/]+)\/placement/)?.[1]]);
      return Response.json({ placed: [], failed: [] });
    }
    if (url.includes('/api/work-board')) return Response.json({ cards });
    return Response.json({});
  });
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repository', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } } });
  useConfigStore.setState({ agents: [] });
  useGlobalSessionsStore.setState({ activeSessions: [], status: 'ready' });
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const lane = (name: string) => container.querySelector(`section[aria-label="${name}"]`)!;
  try {
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await new Promise(resolve => setTimeout(resolve, 40)); });
    expect(lane('To-do').getAttribute('data-count')).toBe('2');
    const search = container.querySelector<HTMLInputElement>('input[aria-label="Search cards"]');
    if (!search) throw new Error('Missing board search field');
    // Typing filters every card lane as it goes: matching cards stay, the rest
    // leave the column and its count. A test process that loaded react-dom
    // without a DOM (a static import in this file) reports a field only on keyup
    // against the focused field, while one that saw a DOM reports it on input,
    // so the typing below covers both.
    const setValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      search.dispatchEvent(new Event('focusin', { bubbles: true }));
      setValue?.call(search, 'changelog');
      search.dispatchEvent(new Event('input', { bubbles: true }));
      search.dispatchEvent(new Event('keyup', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(lane('To-do').getAttribute('data-count')).toBe('1');
    expect(lane('To-do').textContent).toContain('Update the changelog');
    expect(lane('To-do').textContent).not.toContain('Draft the release notes');
    expect(lane('Plan').getAttribute('data-count')).toBe('0');
    expect(lane('Plan').textContent).not.toContain('Fix the login redirect');
    expect(lane('Done').textContent).not.toContain('Older completion');
    // The queue column keeps its own rows: they are what the project is
    // building, not cards a query can hide.
    expect(lane('Build queue').getAttribute('data-count')).toBe('1');
    expect(lane('Build queue').textContent).toContain('Ship the queued build');
    // The column's bulk action follows what the column shows, not what it hides.
    await act(async () => {
      lane('To-do').querySelector<HTMLButtonElement>('button[aria-label="Column actions"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    const bulk = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Move all cards to Done');
    if (!bulk) throw new Error('Missing bulk completion action');
    await act(async () => { bulk.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(placements.at(-1)).toEqual(['changelog']);
    // Escape clears the query, so every card comes back where it was.
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 20));
    });
    expect(search.value).toBe('');
    expect(lane('To-do').textContent).toContain('Draft the release notes');
    expect(lane('Plan').textContent).toContain('Fix the login redirect');
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore();
    useProjectsStore.setState(projects); useUIStore.setState(ui); useConfigStore.setState(config);
    useGlobalSessionsStore.setState(sessions); useNotificationStore.setState(notifications);
    useSessionUIStore.setState(sessionUI); useGlobalSessionStatusStore.setState(sessionStatus);
    await dom.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('a queue row is named from the snapshot when the device has not loaded the session list', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = domGlobals(dom);
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
  // The phone never synced the session list, so the only name for the waiting
  // build is the one the snapshot carries.
  const snapshot = makeSnapshot({
    sessionTitles: { 's-wait': 'Allocated build name' },
    queue: {
      rows: [{ itemId: 'queued1', sessionId: 's-wait', directory: '/repo', content: 'Build it', paused: false, position: 0, model: null }],
      order: ['queued1'],
    },
  });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue/settings')) return Response.json({ enabled: true });
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/api/work-board/snapshot')) return Response.json(snapshot);
    if (url.includes('/api/work-board')) return Response.json({ cards: [] });
    return Response.json({});
  });
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repository', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } } });
  useConfigStore.setState({ agents: [] });
  useGlobalSessionsStore.setState({ activeSessions: [], status: 'ready' });
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await new Promise(resolve => setTimeout(resolve, 40)); });
    const queue = container.querySelector('section[aria-label="Build queue"]')!;
    expect(queue.textContent).toContain('Allocated build name');
    // The id fallback is gone from the row and its controls.
    expect(queue.textContent).not.toContain('Session s-wait');
    expect(queue.querySelector('button[title="Move Allocated build name up"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore();
    useProjectsStore.setState(projects); useUIStore.setState(ui); useConfigStore.setState(config);
    useGlobalSessionsStore.setState(sessions); useNotificationStore.setState(notifications);
    useSessionUIStore.setState(sessionUI); useGlobalSessionStatusStore.setState(sessionStatus);
    await dom.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
