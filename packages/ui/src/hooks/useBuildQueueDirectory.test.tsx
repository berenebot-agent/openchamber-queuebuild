import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { OpenCode } from '@opencode/client';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { SyncProvider } from '@/sync/sync-context';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useBuildQueueDirectory } from './useEffectiveDirectory';

const chatDirectory = '/chat';

/**
 * Mount `useBuildQueueDirectory` on the real stores and sync provider, then
 * hand the test a reader for the latest value and the change it should react to.
 */
async function withDirectoryProbe(run: (read: () => string | undefined) => Promise<void>) {
  const dom = new Window({ url: 'http://queue.test' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [name, value] of Object.entries({
    window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage,
    Element: dom.Element, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.Event,
    KeyboardEvent: dom.KeyboardEvent, CustomEvent: dom.CustomEvent,
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  Object.defineProperty(dom.document, 'visibilityState', { value: 'visible', configurable: true });
  const sdk = OpenCode.make({
    baseUrl: 'https://queue.test',
    fetch: async (request: Request | URL | string) => {
      const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
      if (path.endsWith('/event')) return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
      if (path.endsWith('/location')) return Response.json({ directory: chatDirectory, project: { id: 'chat', directory: chatDirectory, canonical: chatDirectory } });
      if (path.endsWith('/vcs')) return Response.json({ data: { branch: { current: 'main', default: 'main' } } });
      if (path.endsWith('/session/active')) return Response.json({ data: {} });
      if (path.endsWith('/config') || path.endsWith('/project')) return Response.json([]);
      return Response.json({ data: [] });
    },
  });
  const projects = useProjectsStore.getState();
  const ui = useUIStore.getState();
  const directoryState = useDirectoryStore.getState();
  useDirectoryStore.setState({ currentDirectory: chatDirectory });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const seen: (string | undefined)[] = [];
  function Probe() {
    seen.push(useBuildQueueDirectory());
    return null;
  }
  const read = () => seen.at(-1);
  try {
    await act(async () => root.render(
      <SyncProvider sdk={sdk} directory={chatDirectory}><Probe /></SyncProvider>,
    ));
    await run(read);
  } finally {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    useProjectsStore.setState(projects); useUIStore.setState(ui); useDirectoryStore.setState(directoryState);
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
    await dom.happyDOM.close();
  }
}

/**
 * The Build queue pane reads one project's queue. That project comes from the
 * work board's active tab while a board project is loaded, because the pane and
 * the board are two surfaces on the same queue and a board tab switch moves
 * neither the chat session nor the app directory the pane would otherwise
 * follow. Without a board project the pane keeps the chat's directory.
 */
test('the pane follows the work board project tab, then the chat directory', async () => {
  const runtimeKey = getRuntimeKey();
  useProjectsStore.setState({
    projects: [
      { id: 'project', path: '/project', label: 'Board project', addedAt: 1 },
      { id: 'other', path: '/other', label: 'Other project', addedAt: 2 },
    ],
    activeProjectId: 'project',
    hasServerSnapshot: true,
  });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [runtimeKey]: { projectIds: ['project', 'other'], activeProjectId: 'project' } } });
  await withDirectoryProbe(async (read) => {
    expect(read()).toBe('/project');

    // The board's tab switch moves the pane with it, with no chat session
    // change and no app directory change.
    await act(async () => {
      useUIStore.getState().setWorkBoardProjectTabs(runtimeKey, { projectIds: ['project', 'other'], activeProjectId: 'other' });
    });
    expect(read()).toBe('/other');

    // No board tab: the pane falls back to the chat's own directory.
    await act(async () => {
      useUIStore.getState().setWorkBoardProjectTabs(runtimeKey, { projectIds: [], activeProjectId: null });
    });
    expect(read()).toBe(chatDirectory);
  });
});

test('an active board tab whose project is not loaded falls back to the chat directory', async () => {
  const runtimeKey = getRuntimeKey();
  useProjectsStore.setState({ projects: [], activeProjectId: null, hasServerSnapshot: true });
  useUIStore.setState({ workBoardProjectTabsByRuntime: { [runtimeKey]: { projectIds: [], activeProjectId: 'deleted' } } });
  await withDirectoryProbe(async (read) => {
    expect(read()).toBe(chatDirectory);
  });
});
