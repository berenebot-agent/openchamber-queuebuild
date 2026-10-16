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
import type { WorkBoardCard } from '@/lib/workBoardApi';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('the board reads every linked session history together and stops refetching an unchanged one', async () => {
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
  // Six linked cards, each a settled Plan turn. A sequential batch of four would
  // start only four of them at a time.
  const cards: WorkBoardCard[] = suffixes.map((suffix, index) => ({
    id: `card-${suffix}`, directory: '/repo', text: `Brief ${suffix}`, attachments: [],
    sessionId: `session-${suffix}`, stage: 'plan' as const, createdAt: 1, updatedAt: index + 1,
  }));
  const sessionIds = suffixes.map(suffix => `session-${suffix}`);
  // The linked sessions live in another directory, so the board shows its own
  // cards only and the request count is not complicated by inherited ones.
  const sessionRecords = suffixes.map((suffix, index) => ({
    id: `session-${suffix}`, directory: '/elsewhere', projectID: 'project', title: `Session ${suffix}`,
    cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: index + 1, updated: index + 2 },
  }));
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('/api/build-queue')) return Response.json({ revision: 1, active: [], queued: [], issues: [] });
    if (url.includes('/api/work-board')) return Response.json({ cards });
    return Response.json({});
  });
  const statusSpy = spyOn(opencodeClient, 'getActiveSessionStatuses').mockResolvedValue({});
  const inFlight = new Map<string, () => void>();
  const historyCalls: string[] = [];
  let failHistory = false;
  const historySpy = spyOn(opencodeClient, 'getSessionMessages').mockImplementation(async (sessionId: string) => {
    historyCalls.push(sessionId);
    // Hold every request open so the board's concurrency, not the mock's speed,
    // decides when the histories resolve.
    await new Promise<void>(resolve => { inFlight.set(sessionId, resolve); });
    if (failHistory) throw new Error('History offline');
    return { items: [
      { info: { id: `idle-${sessionId}`, sessionID: sessionId, role: 'idle', outcome: 'succeeded', time: { created: 5 } }, parts: [] },
      { info: { id: `build-${sessionId}`, sessionID: sessionId, role: 'assistant', agent: 'build', providerID: 'provider', modelID: 'model', time: { created: 4 } }, parts: [] },
    ], cursor: {} };
  });
  const draftSpy = spyOn(useSessionUIStore.getState(), 'openNewSessionDraft').mockImplementation(() => {});
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repository', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [getRuntimeKey()]: { projectIds: ['project'], activeProjectId: 'project' } } });
  useConfigStore.setState({ agents: [] });
  const oldSessions = Array.from({ length: 100 }, (_, index) => ({
    ...sessionRecords[0], id: `old-${index}`, directory: '/repo', title: `Old session ${index}`,
  }));
  useGlobalSessionsStore.setState({ activeSessions: [...sessionRecords, ...oldSessions], status: 'ready', hasLoaded: true });
  useNotificationStore.setState({ list: [], index: { session: { unseenCount: {}, unseenHasError: {} }, project: { unseenCount: {}, unseenHasError: {} } } });
  useSessionDisplayStore.setState({ animatedActivityIndicators: false });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(<I18nProvider><WorkBoardView /></I18nProvider>); await sleep(30); });

    // The board's own cards arrive from the fetch; the linked histories then
    // start together. A batch of four would have started only four.
    expect([...inFlight.keys()].sort()).toEqual([...sessionIds].sort());
    expect(container.textContent).not.toContain('Old session');
    const settled = historyCalls.length;

    // Let every history resolve.
    await act(async () => { for (const resolve of [...inFlight.values()]) resolve(); inFlight.clear(); await sleep(40); });

    // No card's session moved and none is running, so the next poll reuses the
    // history it already has instead of refetching every settled card.
    await act(async () => { await sleep(5200); });
    expect(historyCalls.length).toBe(settled);

    const doneCards = () => container.querySelector('section[aria-label="Done"]')!.querySelectorAll('article');
    expect(doneCards()).toHaveLength(6);
    await act(async () => {
      useProjectsStore.setState({ projects: [
        { id: 'project', path: '/repo', label: 'Repository', addedAt: 1 },
        { id: 'other', path: '/other', label: 'Other', addedAt: 1 },
      ] });
      useUIStore.getState().setWorkBoardProjectTabs(getRuntimeKey(), { projectIds: ['project', 'other'], activeProjectId: 'other' });
    });
    await act(async () => {
      useUIStore.getState().setWorkBoardProjectTabs(getRuntimeKey(), { projectIds: ['project', 'other'], activeProjectId: 'project' });
    });
    // Histories are deliberately unresolved. All 6 cards must already be back
    // in Done, without a fallback through Plan or a false failure notice.
    expect(doneCards()).toHaveLength(6);
    expect(container.textContent).not.toContain('Status unavailable');
    expect(container.querySelector('section[aria-label="Plan"]')!.querySelectorAll('article')).toHaveLength(0);
    failHistory = true;
    await act(async () => { for (const resolve of inFlight.values()) resolve(); inFlight.clear(); await sleep(40); });
    expect(doneCards()).toHaveLength(6);
    expect(container.textContent).toContain('Status unavailable');
    // Explicitly saved cards above remain visible despite their old timestamps.
    // Opting in admits the inherited old sessions and starts their history reads.
    const includeOlder = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(includeOlder?.checked).toBe(false);
    await act(async () => { includeOlder!.click(); await sleep(30); });
    expect(container.textContent).toContain('Old session 0');
    expect(historyCalls).toContain('old-0');
    await act(async () => { for (const resolve of inFlight.values()) resolve(); inFlight.clear(); await sleep(30); });
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore(); statusSpy.mockRestore(); historySpy.mockRestore(); draftSpy.mockRestore();
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
