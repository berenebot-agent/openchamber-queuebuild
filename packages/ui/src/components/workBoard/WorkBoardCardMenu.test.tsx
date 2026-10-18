import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { OpenCode } from '@opencode/client';
import { opencodeClient } from '@/lib/opencode/client';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';

// The card menu is the board's own entries plus the session menu a sidebar row
// offers. Pin is deliberately absent: a card already carries its own place.

const domGlobals = (dom: Window) => ({
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement, HTMLButtonElement: dom.HTMLButtonElement,
  MutationObserver: dom.MutationObserver,
  Event: dom.Event, KeyboardEvent: dom.KeyboardEvent, PointerEvent: dom.PointerEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const sessionRecord = (title: string) => ({
  id: 'session1', directory: '/repo', projectID: 'project', title,
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated: 1 },
});

test('a card linked to a session carries the session menu, and rename writes the title', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = domGlobals(dom);
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  // react-dom reads the document's event support at import time, so it loads
  // only now that the DOM globals exist.
  const { createRoot } = await import('react-dom/client');
  opencodeClient.reconnectToRuntimeBaseUrl();
  const writes: Array<{ path: string; method: string; body: string }> = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost');
    const method = String(init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const body = input instanceof Request ? await input.clone().text() : String(init?.body ?? '');
    if (method !== 'GET' && url.pathname.startsWith('/api/session/') && !url.pathname.endsWith('/active')) {
      writes.push({ path: url.pathname, method, body });
    }
    if (url.pathname.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    if (url.pathname.endsWith('/session/session1')) {
      return Response.json({ data: { ...sessionRecord(body.includes('Renamed from the board') ? 'Renamed from the board' : 'Original title'), location: { directory: '/repo' } } });
    }
    if (url.pathname.endsWith('/location')) return Response.json({ directory: '/repo', project: { id: 'project', directory: '/repo', canonical: '/repo' } });
    if (url.pathname.endsWith('/vcs')) return Response.json({ data: { branch: { current: 'main', default: 'main' } } });
    if (url.pathname.endsWith('/session/active')) return Response.json({ data: {} });
    if (url.pathname.endsWith('/shell')) return Response.json({ location: { directory: '/repo' }, data: [] });
    if (url.pathname.endsWith('/config') || url.pathname.endsWith('/project')) return Response.json([]);
    return Response.json({ data: [] });
  });
  const sdk = OpenCode.make({ baseUrl: 'http://localhost', fetch: (input, init) => globalThis.fetch(input, init) });
  const { WorkBoardCardMenu } = await import('./WorkBoardCardMenu');
  const { I18nProvider } = await import('@/lib/i18n');
  const { SyncProvider } = await import('@/sync/sync-context');
  const sessions = useGlobalSessionsStore.getState();
  useGlobalSessionsStore.setState({ activeSessions: [], archivedSessions: [], status: 'ready', entityById: new Map() });
  useGlobalSessionsStore.getState().upsertSession(sessionRecord('Original title'));
  const boardCalls: string[] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root: Root | undefined;
  const items = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map(item => item.textContent);
  const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
  const openMenu = async () => {
    const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Actions for Card title"]');
    if (!trigger) throw new Error('Missing card menu trigger');
    await act(async () => { trigger.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
  };
  const clickItem = async (label: string) => {
    const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(entry => entry.textContent === label);
    if (!item) throw new Error(`Missing menu item: ${label}`);
    await act(async () => { item.click(); await new Promise(resolve => setTimeout(resolve, 30)); });
  };
  const saveRename = async () => {
    const save = [...dialog()!.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Save session name');
    if (!save) throw new Error('Missing save action');
    await act(async () => { save.click(); await new Promise(resolve => setTimeout(resolve, 40)); });
  };
  try {
    root = createRoot(container);
    await act(async () => {
      root!.render(<I18nProvider><SyncProvider sdk={sdk} directory="/repo">
        <WorkBoardCardMenu
          sessionId="session1"
          directory="/repo"
          title="Card title"
          disabled={false}
          onStartPlan={null}
          onReturnToTodo={() => boardCalls.push('back')}
          onRemove={() => boardCalls.push('remove')}
          onRemoveTodo={() => boardCalls.push('removeTodo')}
        />
      </SyncProvider></I18nProvider>);
      await new Promise(resolve => setTimeout(resolve, 30));
    });
    await openMenu();
    // The board's own entries, then the session's, in one menu. Removing the
    // saved brief is its own entry: the card and its session stay.
    expect(items().filter(Boolean)).toEqual([
      'Back to To-do', 'Remove to-do', 'Remove card', 'Rename', 'Rename with AI', 'Copy session ID', 'Export Markdown', 'Track as in work', 'Archive', 'Delete',
    ]);
    await clickItem('Remove to-do');
    expect(boardCalls).toEqual(['removeTodo']);
    await openMenu();
    await clickItem('Remove card');
    expect(boardCalls).toEqual(['removeTodo', 'remove']);
    // Renaming to what it already says is a close, not a write.
    await openMenu();
    await clickItem('Rename');
    expect(dialog()?.querySelector<HTMLInputElement>('input')?.value).toBe('Original title');
    await saveRename();
    expect(dialog()).toBeNull();
    expect(writes).toEqual([]);
    // A typed title is written for the session the card points at.
    await openMenu();
    await clickItem('Rename');
    const input = dialog()?.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('Missing rename input');
    const setInputValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setInputValue?.call(input, 'Renamed from the board');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await saveRename();
    expect(writes).toHaveLength(1);
    expect(writes[0].body).toContain('Renamed from the board');
    expect(writes[0].path).toBe('/api/session/session1');
  } finally {
    if (root) await act(async () => root!.unmount());
    fetchSpy.mockRestore();
    useGlobalSessionsStore.setState(sessions);
    opencodeClient.reconnectToRuntimeBaseUrl();
    await dom.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
