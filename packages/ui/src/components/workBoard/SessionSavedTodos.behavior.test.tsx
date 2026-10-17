import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { WorkBoardCard } from '@/lib/workBoardApi';

test('session view restores full to-do text and attachments, preserves it on failure, and rejects stale session reads', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const { SessionSavedTodos } = await import('./SessionSavedTodos');
  const { useWorkBoardSavedTodo } = await import('./workBoardSavedTodo');
  const { getRuntimeKey, getRuntimeApiBaseUrl, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
  const originalRuntime = { apiBaseUrl: getRuntimeApiBaseUrl(), runtimeKey: getRuntimeKey() };
  const { I18nProvider } = await import('@/lib/i18n');
  const card: WorkBoardCard = {
    id: 'card1', sessionId: 'plan1', directory: '/repo', stage: 'todo',
    text: 'First line\nFull saved text', createdAt: 1, updatedAt: 1,
    attachments: [{ id: 'file1', filename: 'notes.txt', mimeType: 'text/plain', size: 2, dataUrl: 'data:text/plain;base64,aGk=' }],
  };
  let fail = false;
  const pending: Array<(response: Response) => void> = [];
  let defer = false;
  const requests: string[] = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), 'http://localhost');
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    if (defer) return new Promise<Response>(resolve => { pending.push(resolve); });
    if (fail) return Response.json({ error: 'offline' }, { status: 503 });
    return Response.json({ cards: url.searchParams.get('sessionId') === 'plan1' ? [card] : [] });
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async (sessionId: string) => {
    await act(async () => { root.render(<I18nProvider><SessionSavedTodos sessionId={sessionId} /></I18nProvider>); });
  };
  try {
    await render('plan1');
    expect(container.textContent).toContain(card.text);
    expect(container.querySelector('a')?.getAttribute('download')).toBe('notes.txt');
    // A cold remount must read the server, without transient save state.
    await act(async () => root.render(null));
    useWorkBoardSavedTodo.setState({ latestSave: null });
    await render('plan1');
    expect(container.textContent).toContain(card.text);
    fail = true;
    await act(async () => dom.dispatchEvent(new dom.Event('focus')));
    expect(container.textContent).toContain(card.text);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not load saved to-do text.');
    fail = false;
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // The save response paints immediately, even while its refresh is pending.
    defer = true;
    const updated = { ...card, text: 'Newly saved follow-up', updatedAt: 2 };
    await act(async () => useWorkBoardSavedTodo.setState({ latestSave: { runtimeKey: getRuntimeKey(), card: updated } }));
    expect(container.textContent).toContain(updated.text);
    const oldRead = pending.at(-1);
    defer = false;
    await render('build1');
    expect(container.textContent).not.toContain(updated.text);
    await act(async () => { oldRead?.(Response.json({ cards: [card] })); });
    expect(container.textContent).not.toContain(card.text);
    expect(requests.every(request => request === 'GET /api/work-board')).toBe(true);
    await render('plan1');
    expect(container.textContent).toContain(card.text);
    defer = true;
    await act(async () => dom.dispatchEvent(new dom.Event('focus')));
    const previousRuntimeRead = pending.at(-1);
    defer = false;
    fail = true;
    await act(async () => switchRuntimeEndpoint({ apiBaseUrl: 'https://other.test', runtimeKey: 'other' }));
    await act(async () => { previousRuntimeRead?.(Response.json({ cards: [card] })); });
    expect(container.textContent).not.toContain(card.text);
    expect(container.textContent).not.toContain(updated.text);
  } finally {
    await act(async () => root.unmount());
    switchRuntimeEndpoint(originalRuntime);
    fetchSpy.mockRestore();
    useWorkBoardSavedTodo.setState({ latestSave: null });
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    await dom.happyDOM.close();
  }
});

test('only a parked To-do card shows a footer entry; promotion hides it and a return to To-do restores it', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = { window: dom, document: dom.document, navigator: dom.navigator, CustomEvent: dom.CustomEvent, IS_REACT_ACT_ENVIRONMENT: true };
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const { SessionSavedTodos } = await import('./SessionSavedTodos');
  const { I18nProvider } = await import('@/lib/i18n');
  const parked: WorkBoardCard = {
    id: 'card1', sessionId: 'plan1', directory: '/repo', stage: 'todo',
    text: 'Pending brief', createdAt: 1, updatedAt: 1, attachments: [],
  };
  let served: WorkBoardCard[] = [parked];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ cards: served }));
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = async () => {
    await act(async () => { root.render(<I18nProvider><SessionSavedTodos sessionId="plan1" /></I18nProvider>); await new Promise(resolve => setTimeout(resolve, 10)); });
  };
  try {
    await render();
    expect(container.textContent).toContain(parked.text);
    served = [{ ...parked, text: '', attachments: [], briefRemoved: true }];
    await act(async () => dom.dispatchEvent(new dom.Event('focus')));
    expect(container.querySelector('section')).toBeNull();
    // Promotion submits the text into the session, so the card leaves To-do. The
    // transcript already shows the message; the footer must not echo it.
    served = [{ ...parked, stage: 'plan', updatedAt: 2 }];
    await act(async () => dom.dispatchEvent(new dom.Event('focus')));
    expect(container.textContent).not.toContain(parked.text);
    // A later send to a done card returns it to To-do, so the pending entry comes back.
    served = [{ ...parked, stage: 'todo', updatedAt: 3 }];
    await act(async () => dom.dispatchEvent(new dom.Event('focus')));
    expect(container.textContent).toContain(parked.text);
  } finally {
    await act(async () => root.unmount());
    fetchSpy.mockRestore();
    for (const [name, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); }
    await dom.happyDOM.close();
  }
});
