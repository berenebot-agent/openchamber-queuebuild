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

test('board actions, live activity and viewed turn attention use shared session behavior', async () => {
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
  const cards: WorkBoardCard[] = [
    { id: 'todo', directory: '/repo', text: 'Saved brief', attachments: [], stage: 'todo', createdAt: 1, updatedAt: 1 },
    { id: 'plan', directory: '/repo', text: 'Inherited plan', attachments: [], stage: 'plan', sessionId: 'session1', createdAt: 1, updatedAt: 1 },
    { id: 'older', directory: '/repo', text: 'Older completion', attachments: [], stage: 'done', completedAt: 5, createdAt: 100, updatedAt: 100 },
    { id: 'newer', directory: '/repo', text: 'Newer completion', attachments: [], stage: 'done', completedAt: 10, createdAt: 1, updatedAt: 1 },
  ];
  let completionRequests = 0;
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/api/work-board/complete')) { completionRequests += 1; return Response.json({ completed: ['plan'], failed: [] }); }
    if (url.includes('/api/work-board')) return Response.json({ cards });
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
    for (const [label, lane, origin] of [['New to-do', 'To-do', 'workBoard'], ['New Plan session', 'Plan', 'workBoardPlan'], ['New Build session', 'Building', 'workBoardBuild']]) {
      expect(button(label).closest('section')?.getAttribute('aria-label')).toBe(lane);
      await act(async () => button(label).click());
      expect(draftSpy.mock.calls.at(-1)).toEqual([{ selectedProjectId: 'project', target: 'project', directoryOverride: '/repo', origin }]);
    }
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
    expect(linkedCard().querySelector('[data-session-activity-indicator]')).toBeNull();
    await act(async () => useNotificationStore.getState().append({ type: 'error', session: 'session1', directory: '/repo', time: Date.now(), viewed: false }));
    expect(linkedCard().textContent).toContain('Needs attention');
    // Opening through another session entry point uses this same transition.
    await act(async () => useSessionUIStore.getState().setCurrentSession('session1', '/repo'));
    expect(linkedCard().textContent).not.toContain('Needs attention');
  } finally {
    await act(async () => root.unmount());
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
