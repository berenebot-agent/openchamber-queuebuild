import React, { act } from 'react';
import { expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { WorkBoardCard } from '@/lib/workBoardApi';
import { useWorkBoardSavedTodo } from './workBoardSavedTodo';

// A To-do card is edited in a composer, never on the board: the card the user
// opened is handed to the composer for its session (or the open new-session
// draft), and saving writes the same card back and returns to the board.

const domGlobals = (dom: Window) => ({
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
  MutationObserver: dom.MutationObserver,
  Event: dom.Event, KeyboardEvent: dom.KeyboardEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
});

const card = (over: Partial<WorkBoardCard> = {}): WorkBoardCard => ({
  id: 'card1', directory: '/repo', text: 'Saved brief', attachments: [],
  createdAt: 1, updatedAt: 7, stage: 'todo', ...over,
});

test('a card the board opens becomes the session composer draft, and saving writes the same card back', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = domGlobals(dom);
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useSavedTodoComposer } = await import('./useSavedTodoComposer');
  const patches: Array<{ id: string; body: { text?: string; expectedUpdatedAt?: number } }> = [];
  const fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost');
    const method = String(init?.method ?? 'GET').toUpperCase();
    if (method === 'PATCH' && url.pathname.startsWith('/api/work-board/')) {
      const body = JSON.parse(String(init?.body ?? '{}'));
      const id = decodeURIComponent(url.pathname.split('/').pop()!);
      patches.push({ id, body });
      return Response.json({ card: card({ id, text: body.text, updatedAt: 8 }) });
    }
    return Response.json({});
  });
  const projects = useProjectsStore.getState();
  const ui = useUIStore.getState();
  const sessionUI = useSessionUIStore.getState();
  useProjectsStore.setState({ projects: [{ id: 'project', path: '/repo', label: 'Repo', addedAt: 1 }], activeProjectId: 'project', hasServerSnapshot: true });
  useUIStore.setState({ isWorkBoardOpen: false, workBoardProjectTabsByRuntime: {} });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let composer: ReturnType<typeof useSavedTodoComposer> | null = null;
  const Probe = () => {
    const [text, setText] = React.useState('My own note');
    const [files, setFiles] = React.useState<AttachedFile[]>([]);
    const [todoMode, setTodoMode] = React.useState(false);
    const options = React.useMemo(() => ({
      scope: 'scope', sessionId: 'session1', isPrimary: true, available: true,
      todoMode, setTodoMode,
      readText: () => text, setText, files, setFiles, focus: () => {},
    }), [text, files, todoMode]);
    composer = useSavedTodoComposer(options);
    return <div>{`${todoMode ? 'todo' : 'send'}:${text}:${files.length}`}</div>;
  };
  try {
    await act(async () => { root.render(<I18nProvider><Probe /></I18nProvider>); });
    // Opening the card asks this composer for its brief. The brief is appended
    // after whatever the draft already held, and To-do is selected.
    expect(useWorkBoardSavedTodo.getState().pendingLoad).toBeNull();
    await act(async () => {
      useWorkBoardSavedTodo.setState({ pendingLoad: { runtimeKey: getRuntimeKey(), card: card({ sessionId: 'session1' }) } });
    });
    expect(container.textContent).toBe('todo:My own note\n\nSaved brief:0');
    expect(composer!.active?.card.id).toBe('card1');
    expect(useWorkBoardSavedTodo.getState().pendingLoad).toBeNull();
    // Saving writes the same card, not a new one, and returns to its board.
    await act(async () => { await composer!.save(); });
    expect(patches).toHaveLength(1);
    expect(patches[0].id).toBe('card1');
    expect(patches[0].body).toMatchObject({ text: 'My own note\n\nSaved brief', expectedUpdatedAt: 7 });
    expect(useUIStore.getState().isWorkBoardOpen).toBe(true);
    expect(useUIStore.getState().workBoardProjectTabsByRuntime[getRuntimeKey()]?.activeProjectId).toBe('project');
    expect(useWorkBoardSavedTodo.getState().latestSave?.card.id).toBe('card1');
    expect(composer!.active).toBeNull();
  } finally {
    await act(async () => root.unmount());
    useWorkBoardSavedTodo.setState({ latestSave: null, pendingLoad: null });
    fetchSpy.mockRestore();
    useProjectsStore.setState(projects); useUIStore.setState(ui); useSessionUIStore.setState(sessionUI);
    await dom.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('a card with no session is taken by the new-session draft composer', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = domGlobals(dom);
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useSavedTodoComposer } = await import('./useSavedTodoComposer');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let composer: ReturnType<typeof useSavedTodoComposer> | null = null;
  const Probe = () => {
    const [text, setText] = React.useState('');
    const [files, setFiles] = React.useState<AttachedFile[]>([]);
    const [todoMode, setTodoMode] = React.useState(false);
    const options = React.useMemo(() => ({
      scope: 'draft', sessionId: null, isPrimary: true, available: true,
      todoMode, setTodoMode,
      readText: () => text, setText, files, setFiles, focus: () => {},
    }), [text, files, todoMode]);
    composer = useSavedTodoComposer(options);
    return <div>{`${todoMode ? 'todo' : 'send'}:${text}`}</div>;
  };
  try {
    await act(async () => { root.render(<I18nProvider><Probe /></I18nProvider>); });
    await act(async () => {
      useWorkBoardSavedTodo.setState({ pendingLoad: { runtimeKey: getRuntimeKey(), card: card({ sessionId: undefined }) } });
    });
    expect(container.textContent).toBe('todo:Saved brief');
    expect(composer!.active?.card.id).toBe('card1');
    expect(useWorkBoardSavedTodo.getState().pendingLoad).toBeNull();
  } finally {
    await act(async () => root.unmount());
    useWorkBoardSavedTodo.setState({ pendingLoad: null });
    await dom.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});

test('replacing the new-session draft withdraws the brief it was handed', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = domGlobals(dom);
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { useSavedTodoComposer } = await import('./useSavedTodoComposer');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let composer: ReturnType<typeof useSavedTodoComposer> | null = null;
  let replaceDraft = () => {};
  const Probe = () => {
    const [text, setText] = React.useState('Keep this draft');
    const [files, setFiles] = React.useState<AttachedFile[]>([]);
    const [todoMode, setTodoMode] = React.useState(false);
    // The open new-session draft's id: New Plan / New To-do opens a new one.
    const [draftId, setDraftId] = React.useState(1);
    replaceDraft = () => setDraftId(2);
    const options = React.useMemo(() => ({
      scope: 'draft', sessionId: null, newSessionDraftId: draftId, isPrimary: true, available: true,
      todoMode, setTodoMode,
      readText: () => text, setText, files, setFiles, focus: () => {},
    }), [text, files, todoMode, draftId]);
    composer = useSavedTodoComposer(options);
    return <div>{`${todoMode ? 'todo' : 'send'}:${text}:${files.length}`}</div>;
  };
  try {
    await act(async () => { root.render(<I18nProvider><Probe /></I18nProvider>); });
    await act(async () => {
      useWorkBoardSavedTodo.setState({ pendingLoad: { runtimeKey: getRuntimeKey(), card: card({ sessionId: undefined }) } });
    });
    expect(container.textContent).toBe('todo:Keep this draft\n\nSaved brief:0');
    expect(composer!.active?.card.id).toBe('card1');
    // The next draft the user opens is not the one that took the brief, so the
    // brief goes back and the draft they had returns.
    await act(async () => { replaceDraft(); });
    expect(container.textContent).toBe('send:Keep this draft:0');
    expect(composer!.active).toBeNull();
  } finally {
    await act(async () => root.unmount());
    useWorkBoardSavedTodo.setState({ pendingLoad: null });
    await dom.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
