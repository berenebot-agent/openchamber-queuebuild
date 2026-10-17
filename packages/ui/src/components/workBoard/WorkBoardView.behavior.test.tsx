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
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { opencodeClient } from '@/lib/opencode/client';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { WorkBoardCard } from '@/lib/workBoardApi';
import { completeTodoSave, useWorkBoardSavedTodo } from './workBoardSavedTodo';

test('board actions, live activity and viewed turn attention use shared session behavior', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    HTMLIFrameElement: dom.HTMLIFrameElement, HTMLTextAreaElement: dom.HTMLTextAreaElement, MutationObserver: dom.MutationObserver,
    Event: dom.Event,
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
  const cards: WorkBoardCard[] = [
    { id: 'todo', directory: '/repo', text: 'Saved brief', attachments: [], stage: 'todo', createdAt: 1, updatedAt: 1 },
    { id: 'plan', directory: '/repo', text: 'Inherited plan', attachments: [], stage: 'plan', sessionId: 'session1', createdAt: 1, updatedAt: 1 },
    { id: 'older', directory: '/repo', text: 'Older completion', attachments: [], stage: 'done', completedAt: 5, createdAt: 100, updatedAt: 100 },
    { id: 'newer', directory: '/repo', text: 'Newer completion', attachments: [], stage: 'done', completedAt: 10, createdAt: 1, updatedAt: 1 },
  ];
  let completionRequests = 0;
  let serverCards = cards;
  let editPatchCount = 0;
  const editPatchBodies: Array<{ text: string; expectedUpdatedAt: number }> = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const request = input instanceof Request ? input : null;
    const method = init?.method ?? request?.method ?? 'GET';
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/api/work-board/complete')) { completionRequests += 1; return Response.json({ completed: ['plan'], failed: [] }); }
    if (url.endsWith('/api/work-board/todo') && method === 'PATCH') {
      const body = init?.body
        ? JSON.parse(String(init.body))
        : await request?.clone().json();
      editPatchBodies.push(body);
      editPatchCount += 1;
      if (editPatchCount === 1) {
        serverCards = serverCards.map(card => card.id === 'todo' ? { ...card, text: 'Saved in another window', updatedAt: 2 } : card);
        return Response.json({ error: 'Card changed. Choose which version to keep.' }, { status: 409 });
      }
      const updated = { ...serverCards.find(card => card.id === 'todo')!, text: body.text, attachments: body.attachments, updatedAt: 3 };
      serverCards = serverCards.map(card => card.id === 'todo' ? updated : card);
      return Response.json({ card: updated });
    }
    if (url.includes('/api/work-board')) return Response.json({ cards: serverCards });
    return Response.json({});
  });
  const statusSpy = spyOn(opencodeClient, 'getActiveSessionStatuses').mockResolvedValue({});
  const historySpy = spyOn(opencodeClient, 'getSessionMessages').mockResolvedValue({ items: [
    { info: { id: 'failed', sessionID: 'session1', role: 'idle', outcome: 'interrupted', time: { created: 5 } }, parts: [] },
  ], cursor: {} });
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
    const briefTitle = container.querySelector<HTMLButtonElement>('button[title="Saved brief"]');
    if (!briefTitle) throw new Error('Missing saved brief card');
    await act(async () => briefTitle.click());
    const editArea = container.querySelector<HTMLTextAreaElement>('textarea');
    if (!editArea) throw new Error('Missing brief editor');
    const setEditArea = Object.getOwnPropertyDescriptor(dom.HTMLTextAreaElement.prototype, 'value')?.set;
    await act(async () => {
      setEditArea?.call(editArea, 'My version');
      editArea.dispatchEvent(new Event('input', { bubbles: true }));
      editArea.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const saveEdit = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Save brief')!;
    await act(async () => { saveEdit().click(); await new Promise(resolve => setTimeout(resolve, 30)); });
    const conflictDialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
    expect(conflictDialog()?.textContent).toContain('Someone else changed this card while you were editing.');
    expect(conflictDialog()?.textContent).toContain('Saved in another window');
    const overwrite = [...conflictDialog()!.querySelectorAll<HTMLButtonElement>('button')]
      .find(item => item.textContent === 'Overwrite with my edits');
    if (!overwrite) throw new Error('Missing overwrite choice');
    await act(async () => { overwrite.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
    expect(editPatchBodies.map(body => body.expectedUpdatedAt)).toEqual([1, 2]);
    expect(editPatchBodies.map(body => body.text)).toEqual(['Saved brief', 'Saved brief']);
    expect(serverCards.find(card => card.id === 'todo')?.text).toBe('Saved brief');
    expect(conflictDialog()).toBeNull();
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
    await act(async () => { button('Column actions').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await new Promise(resolve => setTimeout(resolve, 20)); });
    const bulk = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(item => item.textContent === 'Move all cards to Done');
    if (!bulk) throw new Error('Missing bulk completion action');
    await act(async () => bulk.click());
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Cards to move to Done: 1');
    expect(dialog?.textContent).toContain('Inherited plan');
    expect(completionRequests).toBe(0);
    const confirm = [...dialog!.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === 'Move to Done');
    if (!confirm) throw new Error('Missing confirmation');
    await act(async () => { confirm.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(completionRequests).toBe(1);
    const linkedCard = () => container.querySelector('button[title="Inherited plan"]')!.closest('article')!;
    expect(linkedCard().textContent).toContain('Needs attention');
    expect(linkedCard().querySelector('[data-session-activity-indicator="unread"]')).not.toBeNull();
    // These updates use the same live index as the sidebar, without waiting
    // for the board's five-second history/status poll.
    await act(async () => applyGlobalSessionStatusSnapshot('/repo', { session1: { type: 'busy' } }));
    expect(linkedCard().querySelector('[data-session-activity-indicator="running"] use')?.getAttribute('href')).toBe('#oc-circle');
    await act(async () => useSessionDisplayStore.getState().setAnimatedActivityIndicators(true));
    expect(linkedCard().querySelector('.activity-spinner')).not.toBeNull();
    await act(async () => applyGlobalSessionStatusSnapshot('/repo', {}));
    expect(linkedCard().querySelector('.activity-spinner')).toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('button[title="Inherited plan"]')!.click());
    expect(useSessionUIStore.getState().currentSessionId).toBe('session1');
    expect(linkedCard().textContent).not.toContain('Needs attention');
    const saved = { ...cards[0], text: 'Saved first line\nThe full saved dialogue', attachments: [
      { id: 'file1', filename: 'brief.txt', mimeType: 'text/plain', size: 2, dataUrl: 'data:text/plain;base64,aGk=' },
    ] };
    await act(async () => completeTodoSave(saved, 'project'));
    expect(useUIStore.getState().isWorkBoardOpen).toBe(true);
    expect(useUIStore.getState().workBoardProjectTabsByRuntime[getRuntimeKey()]?.activeProjectId).toBe('project');
    const savedDialog = document.querySelector('[role="dialog"]');
    expect(savedDialog?.textContent).toContain('Saved to To-do');
    expect(savedDialog?.textContent).toContain(saved.text);
    expect(savedDialog?.querySelector('a')?.getAttribute('download')).toBe('brief.txt');
    // An existing-session save stays in its session and never opens the board.
    await act(async () => {
      useUIStore.getState().setWorkBoardOpen(false);
      completeTodoSave({ ...saved, sessionId: 'session1' });
    });
    expect(useUIStore.getState().isWorkBoardOpen).toBe(false);
    expect(useSessionUIStore.getState().currentSessionId).toBe('session1');
    expect(useWorkBoardSavedTodo.getState().confirmation).toBeNull();
    expect(completionRequests).toBe(1);
    expect(linkedCard().querySelector('[data-session-activity-indicator]')).toBeNull();
    await act(async () => useNotificationStore.getState().append({ type: 'error', session: 'session1', directory: '/repo', time: Date.now(), viewed: false }));
    expect(linkedCard().textContent).toContain('Needs attention');
    // The notice is the card's own state, not just a paragraph: the card carries
    // the marker index.css tints amber, so a card needing the user reads as one.
    expect(linkedCard().getAttribute('data-work-board-feedback')).toBe('blocked');
    // A card with nothing to report carries no marker, so the tint cannot sit on
    // an ordinary card.
    expect(container.querySelector('button[title="Saved brief"]')!.closest('article')!.getAttribute('data-work-board-feedback')).toBeNull();
    // Opening through another session entry point uses this same transition.
    await act(async () => useSessionUIStore.getState().setCurrentSession('session1', '/repo'));
    expect(linkedCard().textContent).not.toContain('Needs attention');
    expect(linkedCard().getAttribute('data-work-board-feedback')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    useWorkBoardSavedTodo.setState({ latestSave: null, confirmation: null });
    fetchSpy.mockRestore(); statusSpy.mockRestore(); historySpy.mockRestore(); draftSpy.mockRestore();
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
  // One manually completed card (no session, so no turn activity mark can hide
  // it) and one already-acknowledged card that must stay bare.
  const cards: WorkBoardCard[] = [
    { id: 'unviewed', directory: '/repo', text: 'Finished build', attachments: [], stage: 'done', createdAt: 10, updatedAt: 10, completedAt: 10 },
    { id: 'viewed', directory: '/repo', text: 'Already seen', attachments: [], stage: 'done', createdAt: 5, updatedAt: 5, completedAt: 5, viewedAt: 5 },
  ];
  const viewedRequests: string[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/viewed')) {
      viewedRequests.push(url);
      return Response.json({ card: { ...cards[0], viewedAt: 10 } });
    }
    if (url.includes('/api/work-board')) return Response.json({ cards });
    return Response.json({});
  });
  const statusSpy = spyOn(opencodeClient, 'getActiveSessionStatuses').mockResolvedValue({});
  const historySpy = spyOn(opencodeClient, 'getSessionMessages').mockResolvedValue({ items: [], cursor: {} });
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
    // The finished, unacknowledged card carries exactly one green checkbox.
    const mark = card('Finished build').querySelector('[data-session-activity-indicator="unread"]');
    expect(mark).not.toBeNull();
    expect(mark!.querySelector('use')?.getAttribute('href')).toBe('#oc-checkbox-circle');
    expect(card('Finished build').querySelectorAll('[data-session-activity-indicator]')).toHaveLength(1);
    // A card whose completion was already acknowledged shows no mark at all.
    expect(card('Already seen').querySelector('[data-session-activity-indicator]')).toBeNull();
    await act(async () => { card('Finished build').querySelector<HTMLButtonElement>('button[title="Finished build"]')!.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(viewedRequests).toHaveLength(1);
    expect(viewedRequests[0]).toContain('/api/work-board/unviewed/viewed');
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore(); statusSpy.mockRestore(); historySpy.mockRestore();
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

test('an idle Build session is Done, but a build the queue holds for review stays in the queue column', async () => {
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
  // Two sessions whose last turn is Build and which are not running. The first
  // is plain history; the second still holds a queue lease parked for review.
  const linked = (id: string, text: string): WorkBoardCard => ({
    id, directory: '/repo', text, attachments: [], stage: 'plan', sessionId: id, createdAt: 1, updatedAt: 1,
  });
  const cards: WorkBoardCard[] = [linked('finished', 'Finished build'), linked('review', 'Build needing review')];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue')) return Response.json({
      revision: 1, issues: [],
      active: [{ directory: '/repo', sessionId: 'review', itemId: 'item1', startedAt: 1, needsReview: true, reviewReason: 'restart-unconfirmed' }],
      queued: [],
    });
    if (url.includes('/api/work-board')) return Response.json({ cards });
    return Response.json({});
  });
  const statusSpy = spyOn(opencodeClient, 'getActiveSessionStatuses').mockResolvedValue({});
  const buildTurn = { items: [
    { info: { id: 'idle', sessionID: 'finished', role: 'idle' as const, outcome: 'failed' as const, time: { created: 9 } }, parts: [] },
    { info: { id: 'assistant', sessionID: 'finished', role: 'assistant' as const, agent: 'build', providerID: 'provider', modelID: 'model', time: { created: 8, completed: 8 } }, parts: [] },
    { info: { id: 'user', sessionID: 'finished', role: 'user' as const, time: { created: 7 } }, parts: [] },
  ], cursor: {} };
  const historySpy = spyOn(opencodeClient, 'getSessionMessages').mockResolvedValue(buildTurn);
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repository', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } } });
  useConfigStore.setState({ agents: [] });
  useGlobalSessionsStore.setState({ activeSessions: [], status: 'ready' });
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  useSessionDisplayStore.setState({ animatedActivityIndicators: false });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const cardOf = (title: string) => container.querySelector(`button[title="${title}"]`);
  const laneOf = (title: string) => cardOf(title)!.closest('article')!.closest('section')!.getAttribute('aria-label');
  // History arrives on the board's own poll, whose timing is not ours to
  // guarantee. Settle on the observable lane instead of a fixed delay.
  const settle = async (title: string, lane: string) => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (cardOf(title) && laneOf(title) === lane) return;
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 25)); });
    }
    throw new Error(`Card "${title}" never reached lane ${lane}; saw ${laneOf(title)}`);
  };
  try {
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await new Promise(resolve => setTimeout(resolve, 40)); });
    // A failed Build turn with nothing running is history, not pending work.
    await settle('Finished build', 'Done');
    expect(laneOf('Finished build')).toBe('Done');
    // The lease the server is holding for review keeps its work in the queue
    // column, shown as the running build and marked for review: the server will
    // not release it, so the board must not present it as settled history.
    const queue = container.querySelector('section[aria-label="Build queue"]')!;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)); });
    expect(queue.textContent).toContain('Waiting for review before the queue continues');
    // A parked lease is not running, so it carries no moving band.
    expect(queue.querySelector('.oc-build-stripes')).toBeNull();
    // Its card left the board's lanes entirely: it is queue work now, and it
    // offers no card action that could hide the resolution being waited on.
    expect(container.querySelector('button[title="Build needing review"]')).toBeNull();
    expect(container.querySelector('[aria-label="Actions for Build needing review"]')).toBeNull();
    // The plain history card is already Done, so it offers no completion. The
    // action menu itself is covered by the other behavior test; here the
    // contract is which cards expose one at all.
    expect(container.querySelector('[aria-label="Actions for Finished build"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore(); statusSpy.mockRestore(); historySpy.mockRestore();
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
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repository', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } } });
  useConfigStore.setState({ agents: [] });
  useGlobalSessionsStore.setState({ activeSessions: [], status: 'ready' });
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  useSessionDisplayStore.setState({ animatedActivityIndicators: false });
  const requests: Array<{ url: string; method: string; body: unknown }> = [];
  // Three queued builds in dispatch order and one still running. None of them
  // has a board card, and all three must still appear.
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue')) {
      if (init?.method) requests.push({ url, method: init.method, body: init.body ? JSON.parse(String(init.body)) : null });
      return Response.json({
        revision: 1, issues: [],
        active: [{ directory: '/repo', sessionId: 'running', itemId: 'active1', startedAt: 1 }],
        queued: [
          { id: 'queued1', sessionId: 's1', directory: '/repo', content: 'First build', createdAt: 1, order: 0, paused: false },
          { id: 'queued2', sessionId: 's2', directory: '/repo', content: 'Second build', createdAt: 2, order: 1, paused: true },
          { id: 'queued3', sessionId: 's3', directory: '/repo', content: 'Third build', createdAt: 3, order: 2, paused: false },
        ],
      });
    }
    if (url.includes('/api/work-board')) return Response.json({ cards: [] });
    return Response.json({});
  });
  const statusSpy = spyOn(opencodeClient, 'getActiveSessionStatuses').mockResolvedValue({});
  const historySpy = spyOn(opencodeClient, 'getSessionMessages').mockResolvedValue({ items: [], cursor: {} });
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
    // One column: the running build above the gap, the waiting ones below it in
    // the queue's own dispatch order rather than any card order.
    const text = lane().textContent ?? '';
    expect(text).toContain('Up next');
    expect(text.indexOf('Building now')).toBeLessThan(text.indexOf('Up next'));
    // Rows are keyed by the queue's own order, and each shows the prompt that
    // will run. A paused row says so where the snippet would otherwise be.
    const titles = [...lane().querySelectorAll('button[title^="Move "]')]
      .map(element => element.getAttribute('title')!.replace(/^Move /, '').replace(/ (up|down)$/, ''))
      .filter((title, index, all) => all.indexOf(title) === index);
    expect(titles).toEqual(['Session s1', 'Session s2', 'Session s3']);
    expect(text).toContain('First build');
    expect(text).toContain('Third build');
    expect(text).toContain('Paused');
    expect(text.indexOf('First build')).toBeLessThan(text.indexOf('Paused'));
    // The running build carries its own mark, and its row is not a queued one.
    expect(lane().querySelector('.oc-build-stripes')).not.toBeNull();
    // The running build and the waiting rows are the same card size, so the
    // column reads as one list rather than two slightly different ones. The
    // class is the whole contract: one padding is the one height.
    const runningBuild = lane().querySelector<HTMLElement>('button[aria-label^="Open the build running now:"]')!;
    const waitingRow = lane().querySelector('[aria-label="Move Session s1 up"]')!.closest<HTMLElement>('div.group')!;
    const cardPadding = (element: HTMLElement) => element.className.match(/\bpx-2\.5 (py-[0-9.]+)\b/)?.[1];
    expect(cardPadding(runningBuild)).toBe('py-2');
    expect(cardPadding(waitingRow)).toBe('py-2');
    // Up is a no-op on the first row and the control says so.
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
    await click('Cancel Session s3');
    // The pause and cancel routes name the session and the item separately.
    expect(requests.at(-1)?.method).toBe('DELETE');
    expect(requests.at(-1)?.url.endsWith('/api/build-queue/sessions/s3/items/queued3')).toBe(true);
    expect(requests.at(-1)?.body).toBeNull();
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore(); statusSpy.mockRestore(); historySpy.mockRestore();
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
  const { rememberWorkBoardReturn } = await import('./workBoardReturn');
  const { I18nProvider } = await import('@/lib/i18n');
  const projectState = useProjectsStore.getState();
  const ui = useUIStore.getState();
  const config = useConfigStore.getState();
  const sessions = useGlobalSessionsStore.getState();
  const notifications = useNotificationStore.getState();
  const sessionUI = useSessionUIStore.getState();
  const sessionStatus = useGlobalSessionStatusStore.getState();
  const card = (id: string, directory: string): WorkBoardCard => ({
    id, directory, text: `${id} brief`, attachments: [], stage: 'todo', createdAt: 1, updatedAt: 1,
  });
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/api/work-board')) {
      const directory = new URL(url, 'http://localhost').searchParams.get('directory');
      return Response.json({ cards: directory === '/repo' ? [card('repo-todo', '/repo')]
        : directory === '/other' ? [card('other-todo', '/other')] : [] });
    }
    return Response.json({});
  });
  const statusSpy = spyOn(opencodeClient, 'getActiveSessionStatuses').mockResolvedValue({});
  const historySpy = spyOn(opencodeClient, 'getSessionMessages').mockResolvedValue({ items: [], cursor: {} });
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

    // The user leaves for a session in another project and returns to the board
    // from that chat: the board follows the session, keeping the old tab open.
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
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore(); statusSpy.mockRestore(); historySpy.mockRestore();
    useProjectsStore.setState(projectState); useUIStore.setState(ui); useConfigStore.setState(config);
    useGlobalSessionsStore.setState(sessions); useNotificationStore.setState(notifications);
    useSessionUIStore.setState(sessionUI); useGlobalSessionStatusStore.setState(sessionStatus);
    await dom.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
