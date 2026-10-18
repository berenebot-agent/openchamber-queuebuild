import { afterAll, expect, spyOn, test } from 'bun:test';
import { plugin } from 'bun';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Window } from 'happy-dom';
import { z } from 'zod';
import type { RuntimeAPIs } from '@/lib/api/types';
import type { EditorView as ComposerEditorView } from '@codemirror/view';
import type { WorkBoardCard } from '@/lib/workBoardApi';

/**
 * Counts which components render per keystroke without instrumenting them.
 *
 * React reports every commit to the DevTools hook. The walk mirrors React
 * DevTools' own render detection: a subtree whose child pointer is unchanged
 * was skipped entirely, and a component fiber carrying the PerformedWork flag
 * actually ran its render function in this commit (a memo bailout does not).
 */
type ComponentFunction = { name: string };
type CommitFiber = {
  tag: number;
  // Read only for component tags: the function itself (0, 15), a forwardRef
  // object with `render` (11), or a memo object with `type` (14).
  type: (ComponentFunction & { type?: ComponentFunction; render?: ComponentFunction }) | null;
  flags: number;
  child: CommitFiber | null;
  sibling: CommitFiber | null;
  alternate: CommitFiber | null;
};

const FUNCTION_COMPONENT = 0;
const FORWARD_REF = 11;
const MEMO_COMPONENT = 14;
const SIMPLE_MEMO_COMPONENT = 15;
const COMPONENT_TAGS = new Set([FUNCTION_COMPONENT, FORWARD_REF, MEMO_COMPONENT, SIMPLE_MEMO_COMPONENT]);
const PERFORMED_WORK = 1;

const renderedByName = new Map<string, number>();
let counting = false;

const fiberName = (fiber: CommitFiber): string => {
  if (fiber.tag === FORWARD_REF) return fiber.type?.render?.name ?? '';
  if (fiber.tag === MEMO_COMPONENT) return fiber.type?.type?.name ?? '';
  return fiber.type?.name ?? '';
};

const walk = (fiber: CommitFiber | null, mounted: boolean): void => {
  for (let node = fiber; node; node = node.sibling) {
    const isMount = mounted || node.alternate === null;
    const didRender = isMount || (node.flags & PERFORMED_WORK) === PERFORMED_WORK;
    if (didRender && COMPONENT_TAGS.has(node.tag)) {
      const name = fiberName(node);
      if (name) renderedByName.set(name, (renderedByName.get(name) ?? 0) + 1);
    }
    if (isMount || node.child !== node.alternate?.child) {
      walk(node.child, isMount);
    }
  }
};

Object.assign(globalThis, {
  __REACT_DEVTOOLS_GLOBAL_HOOK__: {
    isDisabled: false,
    supportsFiber: true,
    renderers: new Map(),
    inject: () => 1,
    onScheduleFiberRoot: () => undefined,
    onCommitFiberRoot: (_id: number, root: { current: CommitFiber }) => {
      if (!counting) return;
      const current = root.current;
      walk(current.child, current.alternate === null);
    },
    onCommitFiberUnmount: () => undefined,
    onPostCommitFiberRoot: () => undefined,
    checkDCE: () => undefined,
  },
});

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  Node: browser.Node,
  Text: browser.Text,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement,
  HTMLTextAreaElement: browser.HTMLTextAreaElement,
  HTMLFormElement: browser.HTMLFormElement,
  Range: browser.Range,
  Selection: browser.Selection,
  DocumentFragment: browser.DocumentFragment,
  Event: browser.Event,
  KeyboardEvent: browser.KeyboardEvent,
  MouseEvent: browser.MouseEvent,
  FocusEvent: browser.FocusEvent,
  InputEvent: browser.InputEvent,
  CustomEvent: browser.CustomEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  IntersectionObserver: browser.IntersectionObserver,
  matchMedia: browser.matchMedia.bind(browser),
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  customElements: browser.customElements,
  HTMLDivElement: browser.HTMLDivElement,
  HTMLSpanElement: browser.HTMLSpanElement,
  SVGElement: browser.SVGElement,
  ShadowRoot: browser.ShadowRoot,
  CSSStyleSheet: browser.CSSStyleSheet,
  DOMParser: browser.DOMParser,
  IS_REACT_ACT_ENVIRONMENT: true,
});

// Nothing typed here reaches a server; every request answers empty.
const writes: string[] = [];
let savedCards: WorkBoardCard[] = [];
let failBoardWrite = false;
let loseNextBoardResponse = false;
const patches: Array<{ text?: string; stage?: string; removeBrief?: boolean; expectedUpdatedAt?: number }> = [];
spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
  const path = new URL(input instanceof Request ? input.url : input.toString(), 'http://localhost/').pathname;
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  if (method !== 'GET' && path !== '/auth/url-token') writes.push(path);
  if (path.startsWith('/api/work-board') && method === 'GET') return Response.json({ cards: savedCards });
  if (path.startsWith('/api/work-board/') && method === 'PATCH') {
    const body = z.object({ text: z.string().optional(), stage: z.enum(['todo', 'plan']).optional(), removeBrief: z.literal(true).optional(),
      expectedUpdatedAt: z.number().optional(), attachments: z.array(z.object({ id: z.string(), filename: z.string(), mimeType: z.string(), size: z.number(), dataUrl: z.string() })).optional(),
    }).parse(JSON.parse(String(init?.body)));
    patches.push(body);
    if (failBoardWrite) return Response.json({ error: 'Board offline' }, { status: 503 });
    const card = savedCards.find(card => path.endsWith(`/${card.id}`));
    if (!card) return Response.json({ error: 'Missing card' }, { status: 404 });
    if (body.expectedUpdatedAt !== card.updatedAt) return Response.json({ error: 'Card changed' }, { status: 409 });
    const updated: WorkBoardCard = body.removeBrief
      ? { ...card, text: '', attachments: [], briefRemoved: true }
      : { ...card, text: body.text ?? card.text, attachments: body.attachments ?? card.attachments, stage: body.stage ?? card.stage, updatedAt: card.updatedAt + 1 };
    savedCards = savedCards.map(entry => entry.id === card.id ? updated : entry);
    if (loseNextBoardResponse) {
      loseNextBoardResponse = false;
      return Response.json({ error: 'Response lost after commit' }, { status: 503 });
    }
    return Response.json({ card: updated });
  }
  if (path.startsWith('/api/work-board') && method === 'POST') {
    const body = z.object({ directory: z.string(), text: z.string() }).parse(JSON.parse(String(init?.body)));
    return Response.json({ card: { ...body, id: 'saved-todo', attachments: [], createdAt: 1, updatedAt: 1, stage: 'todo',
      ...(path.includes('/sessions/') ? { sessionId: 'ses_typing' } : {}),
    } });
  }
  if (path === '/api/build-queue') return Response.json({ revision: 0, active: [], queued: [], issues: [] });
  if (path.endsWith('/location')) {
    return Response.json({ directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } });
  }
  if (path.endsWith('/session')) return Response.json({ data: [] });
  return Response.json({});
});

// Vite-only module forms the composer's import graph reaches.
plugin({
  name: 'composer-keystroke-vite-modules',
  setup(build) {
    // A load transform, as the sibling tests do it, and never an onResolve into a namespace of
    // its own: Bun keeps transpiled files in a cache on disk that every test process shares, and
    // a rewritten import specifier cached from this file broke every later file that imports
    // markdown-worker with "Cannot find module 'worker-url:...'".
    build.onLoad({ filter: /markdown-shiki\.worker\.ts\?worker&url$/ }, () => ({ contents: 'export default "";', loader: 'js' }));
    build.onLoad({ filter: /useProviderLogo\.ts$/ }, ({ path }) => {
      const directory = resolve(dirname(path), '../assets/provider-logos');
      const logos = Object.fromEntries(readdirSync(directory).filter((name) => name.endsWith('.svg')).map((name) => [
        `../assets/provider-logos/${name}`, pathToFileURL(resolve(directory, name)).href,
      ]));
      return { contents: readFileSync(path, 'utf8').replace(/import\.meta\.glob<string>\([\s\S]*?\);/, `${JSON.stringify(logos)};`), loader: 'ts' };
    });
  },
});

const { act, Profiler } = await import('react');
const { createRoot } = await import('react-dom/client');
const { EditorView } = await import('@codemirror/view');
const { setLanguageContext } = await import('../composer/editor/composerLanguage');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemProvider } = await import('@/contexts/ThemeSystemContext');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { ChatInput } = await import('../ChatInput');
const { SyncProvider } = await import('@/sync/sync-context');
const { useDirectoryStore } = await import('@/stores/useDirectoryStore');
const { OpenCode } = await import('@opencode/client');

const sdk = OpenCode.make({
  baseUrl: 'https://sync.test',
  fetch: async (request) => {
    const path = new URL(request instanceof Request ? request.url : request.toString()).pathname;
    if (path.endsWith('/event')) {
      return new Response(new ReadableStream(), { headers: { 'content-type': 'text/event-stream' } });
    }
    const body = path.endsWith('/location')
      ? { directory: '/workspace', project: { id: 'project', directory: '/workspace', canonical: '/workspace' } }
      : path.endsWith('/session/active') ? {}
      : { data: [] };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
});

// SAFETY: Mounting and typing read only the runtime descriptor and the
// source-control object's identity; no runtime API method is invoked.
const runtimeAPIs = { runtime: { platform: 'web', isDesktop: false, isVSCode: false }, sourceControl: {} } as RuntimeAPIs;

const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useConfigStore } = await import('@/stores/useConfigStore');
const { getSyncChildStores } = await import('@/sync/sync-refs');

const KEYSTROKES = 20;

type TypingCost = {
  commits: number;
  renderMs: number;
  componentRenders: number;
  languageContextUpdates: number;
  rendersByComponent: Map<string, number>;
};

/** Mounts a fresh composer, types KEYSTROKES characters, and reports the per-keystroke cost. */
const measureTyping = async (scenario: 'session' | 'draft', exercise?: (container: HTMLElement, view: ComposerEditorView) => Promise<void>): Promise<TypingCost> => {
  useDirectoryStore.setState({ currentDirectory: '/workspace' });
  useSessionUIStore.setState(scenario === 'session'
    ? { currentSessionId: 'ses_typing', currentSessionDirectory: '/workspace', newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, open: false } }
    : {
        currentSessionId: null,
        currentSessionDirectory: null,
        newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, open: true, target: 'project', directoryOverride: '/workspace' },
      });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let commits = 0;
  let renderMs = 0;
  try {
    await act(async () => {
      root.render(
        <RuntimeAPIContext.Provider value={runtimeAPIs}>
          <ThemeSystemProvider>
            <I18nProvider>
              <SyncProvider sdk={sdk} directory="/workspace">
                  <Profiler id="composer" onRender={(_id, _phase, actual) => { commits += 1; renderMs += actual; }}>
                  <ChatInput />
                  </Profiler>
              </SyncProvider>
            </I18nProvider>
          </ThemeSystemProvider>
        </RuntimeAPIContext.Provider>,
      );
    });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });

    const content = container.querySelector<HTMLElement>('.cm-content');
    const view = content ? EditorView.findFromDOM(content) : null;
    if (!view) throw new Error('The composer editor did not mount');
    if (exercise) {
      await exercise(container, view);
      await act(async () => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } }); });
    }

    let languageContextUpdates = 0;
    const update = view.update.bind(view);
    view.update = (transactions) => {
      if (transactions.some((transaction) => transaction.effects.some((effect) => effect.is(setLanguageContext)))) {
        languageContextUpdates += 1;
      }
      update(transactions);
    };

    commits = 0;
    renderMs = 0;
    renderedByName.clear();
    counting = true;
    for (let index = 0; index < KEYSTROKES; index += 1) {
      await act(async () => {
        view.dispatch({ changes: { from: view.state.doc.length, insert: 'a' }, userEvent: 'input.type' });
      });
    }
    counting = false;
    // The instrument has to have fired: every keystroke reaches the editor.
    expect(view.state.doc.length).toBe(KEYSTROKES);
    const componentRenders = [...renderedByName.values()].reduce((sum, count) => sum + count, 0);
    const cost: TypingCost = {
      commits: commits / KEYSTROKES,
      renderMs: renderMs / KEYSTROKES,
      componentRenders: componentRenders / KEYSTROKES,
      languageContextUpdates,
      rendersByComponent: new Map(renderedByName),
    };
    console.log(`[${scenario}] commits/keystroke=${cost.commits} renderMs/keystroke=${cost.renderMs.toFixed(2)} componentRenders/keystroke=${cost.componentRenders} languageContextUpdates=${languageContextUpdates}`);
    console.log([...renderedByName.entries()].map(([name, count]) => `${name}:${count / KEYSTROKES}`).sort().join(' '));
    return cost;
  } finally {
    counting = false;
    await act(async () => root.unmount());
    container.remove();
  }
};

afterAll(() => {
  browser.close();
});

/**
 * Children of the composer that do not depend on the draft text. Each may
 * render once over the run, on the first keystroke, when the composer turns
 * from empty to sendable; never on every keystroke.
 *
 * Before this guard (same scenario, 20 keystrokes): an existing session
 * rendered 23 components and re-tokenized the editor's language context on
 * every keystroke; a new-session draft rendered 52 components per keystroke.
 */
const TEXT_INDEPENDENT_CHILDREN = [
  'ComposerFooterView',
  'ComposerAutocompletePopupsView',
  'PermissionDockView',
  'FormDockView',
  'BtwPanelView',
  'DraftTargetSelectorsView',
  'DraftPresetChipsView',
  'ReviewFlowDialogView',
  'QueuedMessagesStrip',
  'ComposerDictation',
  'SessionGoalObjectiveCounter',
];

const expectOnlyTheEditorFollowsTheText = (cost: TypingCost) => {
  expect(cost.rendersByComponent.get('ChatInputComponent')).toBe(KEYSTROKES);
  expect(cost.languageContextUpdates).toBe(0);
  for (const name of TEXT_INDEPENDENT_CHILDREN) {
    // Paired with the name so a failure says which child followed the text.
    const renders = cost.rendersByComponent.get(name) ?? 0;
    expect([name, renders]).toEqual([name, Math.min(renders, 1)]);
  }
};

test('typing in an existing session re-renders only the composer shell and its editor', async () => {
  expectOnlyTheEditorFollowsTheText(await measureTyping('session'));
});

test('typing in a new-session draft re-renders only the composer shell and its editor', async () => {
  expectOnlyTheEditorFollowsTheText(await measureTyping('draft'));
});

test('To-do refuses queue and keyboard submission if the idle session becomes busy', async () => {
  await measureTyping('session', async (container, view) => {
    await act(async () => {
      useConfigStore.setState({ currentProviderId: 'provider', currentModelId: 'model', currentAgentName: 'review', agents: [
        { id: 'review', name: 'review', displayName: 'Review', mode: 'primary', hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions: [] },
      ] });
    });
    await act(async () => { view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true })); });
    expect(container.querySelector('[aria-label="Save to To-do"]')).not.toBeNull();
    await act(async () => {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Keep these notes private from execution' } });
      getSyncChildStores().ensureChild('/workspace', { bootstrap: false }).getState().patch({ session_status: { ses_typing: { type: 'busy' } } });
    });
    writes.length = 0;
    const queue = container.querySelector<HTMLButtonElement>('button[aria-label="Queue message"]');
    expect(queue).not.toBeNull();
    await act(async () => { queue?.click(); });
    await act(async () => { view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true })); });
    expect(writes).toEqual([]);
    expect(view.state.doc.toString()).toBe('Keep these notes private from execution');
    await act(async () => { getSyncChildStores().ensureChild('/workspace', { bootstrap: false }).getState().patch({ session_status: { ses_typing: { type: 'idle' } } }); });
  });
});

test('Auto model ignores the agent shortcut instead of entering an invisible To-do mode', async () => {
  await measureTyping('session', async (container, view) => {
    await act(async () => { useConfigStore.setState({ currentProviderId: 'openchamber', currentModelId: 'auto', currentAgentName: 'review' }); });
    await act(async () => { view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true })); });
    expect(container.querySelector('[aria-label="Save to To-do"]')).toBeNull();
    expect(useConfigStore.getState().currentAgentName).toBe('review');
  });
});

for (const scenario of ['session', 'draft'] as const) {
  test(`To-do saves full composer text from a ${scenario} without starting a model`, async () => {
    const { useProjectsStore } = await import('@/stores/useProjectsStore');
    const { useUIStore } = await import('@/stores/useUIStore');
    const { useWorkBoardSavedTodo } = await import('@/components/workBoard/workBoardSavedTodo');
    const projects = useProjectsStore.getState();
    const ui = useUIStore.getState();
    useProjectsStore.setState({ projects: [{ id: 'project', path: '/workspace', label: 'Workspace', addedAt: 1 }], activeProjectId: 'project' });
    try {
      await measureTyping(scenario, async (container, view) => {
        await act(async () => {
          useConfigStore.setState({ currentProviderId: 'provider', currentModelId: 'model', currentAgentName: 'review', agents: [
            { id: 'review', name: 'review', displayName: 'Review', mode: 'primary', hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions: [] },
          ] });
          if (scenario === 'draft') useSessionUIStore.setState({ newSessionDraft: { ...useSessionUIStore.getState().newSessionDraft, selectedProjectId: 'project', origin: 'workBoard' } });
          useUIStore.getState().setWorkBoardOpen(false);
        });
        if (scenario === 'session') await act(async () => { view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true, cancelable: true })); });
        await act(async () => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Full saved brief\nFollow-up details' } }); });
        writes.length = 0;
        const save = container.querySelector<HTMLButtonElement>('[aria-label="Save to To-do"]');
        expect(save).not.toBeNull();
        await act(async () => { save!.click(); });
        expect(writes).toEqual([scenario === 'draft' ? '/api/work-board' : '/api/work-board/sessions/ses_typing/todo']);
        expect(useWorkBoardSavedTodo.getState().latestSave?.card.text).toBe('Full saved brief\nFollow-up details');
        // A save always returns to the project's board; it is announced by a
        // toast on both paths.
        expect(useUIStore.getState().isWorkBoardOpen).toBe(true);
        expect(view.state.doc.toString()).toBe('');
      });
    } finally {
      useProjectsStore.setState(projects);
      useUIStore.setState(ui);
      useWorkBoardSavedTodo.setState({ latestSave: null });
    }
  });
}

const prepareSavedTodo = async () => {
  const { useWorkBoardSavedTodo } = await import('@/components/workBoard/workBoardSavedTodo');
  const { useSelectionStore } = await import('@/sync/selection-store');
  const { useAuthSessionStore } = await import('@/lib/runtime-auth-expiry');
  useAuthSessionStore.setState({ state: 'ok' });
  useWorkBoardSavedTodo.setState({ latestSave: null });
  patches.length = 0;
  writes.length = 0;
  failBoardWrite = false;
  loseNextBoardResponse = false;
  savedCards = [{ id: 'brief1', sessionId: 'ses_typing', directory: '/workspace', text: 'Saved brief\nDetails', attachments: [
    { id: 'saved-file', filename: 'notes.txt', mimeType: 'text/plain', size: 2, dataUrl: 'data:text/plain;base64,aGk=' },
  ], createdAt: 1, updatedAt: 1, stage: 'todo' }];
  useConfigStore.setState({ currentProviderId: 'provider', currentModelId: 'model', currentAgentName: 'review', agents: ['review', 'plan', 'build'].map(name => ({
    id: name, name, displayName: name, mode: 'primary', hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions: [],
  })) });
  useSelectionStore.getState().saveSessionAgentSelection('ses_typing', 'review');
};

// The board opens a To-do card by handing its brief to the composer, which is
// how these tests reach the saved-to-do flow now that the transcript carries no
// entry for it.
const loadSavedTodo = async (card?: WorkBoardCard) => {
  const { requestTodoLoad } = await import('@/components/workBoard/workBoardSavedTodo');
  await act(async () => { requestTodoLoad(card ?? savedCards[0]!); await new Promise(resolve => setTimeout(resolve, 10)); });
};

// Leaving To-do mode is the user's own move: pick a real agent, which is what
// turns the composer back to Send.
const pickAgent = async (container: HTMLElement, name: string) => {
  const trigger = [...container.querySelectorAll<HTMLElement>('.model-controls__agent-label')].find(node => node.textContent?.trim() === 'To-do');
  if (!trigger) throw new Error('Missing agent picker');
  await act(async () => { trigger.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === name);
  if (!item) throw new Error(`Missing agent ${name}`);
  await act(async () => { item.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
};

test('a card opens its brief into the real composer and updates the same to-do with its attachments', async () => {
  await prepareSavedTodo();
  await measureTyping('session', async (container, view) => {
    await act(async () => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Existing draft' } }); });
    await loadSavedTodo();
    expect(view.state.doc.toString()).toBe('Existing draft\n\nSaved brief\nDetails');
    expect(container.querySelector('[aria-label="Update to-do"]')).not.toBeNull();
    expect(writes).toEqual([]);
    await act(async () => { view.dispatch({ changes: { from: view.state.doc.length, insert: '\nEdited' } }); });
    await act(async () => { container.querySelector<HTMLButtonElement>('[aria-label="Update to-do"]')!.click(); });
    expect(writes).toEqual(['/api/work-board/brief1']);
    expect(patches[0]?.text).toBe('Existing draft\n\nSaved brief\nDetails\nEdited');
    expect(patches[0]?.expectedUpdatedAt).toBe(1);
    expect(savedCards).toHaveLength(1);
    expect(savedCards[0]?.attachments.map(file => file.id)).toEqual(['saved-file']);
    expect(view.state.doc.toString()).toBe('');
    savedCards = [];
  });
});

test('a card opens the brief after the draft, and Cancel restores text, files and agent', async () => {
  await prepareSavedTodo();
  const { useInputStore } = await import('@/sync/input-store');
  await measureTyping('session', async (container, view) => {
    await act(async () => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: 'Keep this draft' } }); });
    const previousFiles = [...useInputStore.getState().attachedFiles];
    const previousAgent = useConfigStore.getState().currentAgentName;
    await loadSavedTodo();
    expect(view.state.doc.toString()).toBe('Keep this draft\n\nSaved brief\nDetails');
    expect(container.textContent).toContain('Editing saved to-do');
    expect(writes).toEqual([]);
    const cancel = [...container.querySelectorAll<HTMLButtonElement>('[role="status"] button')].find(button => button.textContent === 'Cancel');
    if (!cancel) throw new Error('Missing conversion Cancel');
    await act(async () => cancel.click());
    expect(view.state.doc.toString()).toBe('Keep this draft');
    expect(useConfigStore.getState().currentAgentName).toBe(previousAgent);
    expect(useInputStore.getState().attachedFiles).toEqual(previousFiles);
    expect(savedCards[0]?.stage).toBe('todo');
    savedCards = [];
  });
});

test('editing merges existing files without duplicating a saved attachment and retains edits after a failed update', async () => {
  await prepareSavedTodo();
  const { useInputStore } = await import('@/sync/input-store');
  await measureTyping('session', async (container, view) => {
    await act(async () => {
      view.focus();
      useInputStore.getState().setAttachedFiles([
        { ...savedCards[0]!.attachments[0]!, file: new File(['hi'], 'notes.txt'), source: 'local' },
        { id: 'draft-file', filename: 'draft.txt', mimeType: 'text/plain', size: 2, dataUrl: 'data:text/plain;base64,aGk=', file: new File(['hi'], 'draft.txt'), source: 'local' },
      ]);
    });
    await act(async () => { await loadSavedTodo(); });
    expect(useInputStore.getState().attachedFiles.map(file => file.id)).toEqual(['saved-file', 'draft-file']);
    failBoardWrite = true;
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Update to-do"]')!.click());
    expect(view.state.doc.toString()).toContain('Saved brief');
    expect(useInputStore.getState().attachedFiles).toHaveLength(2);
    expect(savedCards[0]?.updatedAt).toBe(1);
    failBoardWrite = false;
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Update to-do"]')!.click());
    expect(savedCards[0]?.attachments.map(file => file.id)).toEqual(['saved-file', 'draft-file']);
    expect(savedCards[0]?.updatedAt).toBe(2);
    savedCards = [];
  });
});

test('a failed Plan send keeps the to-do and restores the draft; success promotes only after acceptance', async () => {
  await prepareSavedTodo();
  const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockRejectedValueOnce(new Error('Rejected by server'));
  let accept = () => {};
  try {
    await measureTyping('session', async (container, view) => {
      await loadSavedTodo();
      await pickAgent(container, 'plan');
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
      expect(send.mock.calls).toHaveLength(1);
      expect(patches).toEqual([]);
      expect(savedCards[0]?.stage).toBe('todo');
      expect(view.state.doc.toString()).toContain('Saved brief');
      send.mockImplementation(() => new Promise<void>(resolve => { accept = resolve; }));
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
      expect(send.mock.calls).toHaveLength(2);
      expect(patches).toEqual([]);
      expect(container.querySelector<HTMLButtonElement>('[role="status"] button')?.disabled).toBe(true);
      await act(async () => accept());
      expect(savedCards[0]?.stage).toBe('plan');
      expect(patches).toEqual([{ stage: 'plan', expectedUpdatedAt: 1 }]);
      expect(container.textContent).not.toContain('Saved brief');
      expect(view.state.doc.toString()).toBe('');
      savedCards = [];
    });
  } finally { accept(); send.mockRestore(); }
});

test('a board update failure after sending offers a board-only retry without resending', async () => {
  await prepareSavedTodo();
  const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockResolvedValue(undefined);
  try {
    await measureTyping('session', async (container, view) => {
      await loadSavedTodo();
      await pickAgent(container, 'plan');
      failBoardWrite = true;
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
      expect(send.mock.calls).toHaveLength(1);
      expect(view.state.doc.toString()).toBe('');
      expect(savedCards[0]?.stage).toBe('todo');
      expect(container.textContent).toContain('Message sent. The board could not be updated.');
      failBoardWrite = false;
      const retry = [...container.querySelectorAll<HTMLButtonElement>('[role="status"] button')].find(button => button.textContent === 'Try again')!;
      await act(async () => retry.click());
      expect(send.mock.calls).toHaveLength(1);
      expect(patches).toHaveLength(2);
      expect(savedCards[0]?.stage).toBe('plan');
      savedCards = [];
    });
  } finally { failBoardWrite = false; send.mockRestore(); }
});

test('switching a Plan conversion to Build retains it through failed admission and consumes it when accepted', async () => {
  await prepareSavedTodo();
  const { useSelectionStore } = await import('@/sync/selection-store');
  const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockRejectedValueOnce(new Error('Queue unavailable'));
  try {
    await measureTyping('session', async (container, view) => {
      await loadSavedTodo();
      await pickAgent(container, 'plan');
      await act(async () => {
        useConfigStore.getState().setAgent('build');
        useSelectionStore.getState().saveSessionAgentSelection('ses_typing', 'build');
      });
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
      expect(send.mock.calls).toHaveLength(1);
      expect(savedCards[0]?.stage).toBe('todo');
      expect(view.state.doc.toString()).toContain('Saved brief');
      expect(patches).toEqual([]);
      send.mockResolvedValue(undefined);
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
      expect(send.mock.calls).toHaveLength(2);
      expect(savedCards[0]?.stage).toBe('plan');
      expect(view.state.doc.toString()).toBe('');
      savedCards = [];
    });
  } finally { send.mockRestore(); }
});

test('an accepted conversion still updates its original card after switching sessions', async () => {
  await prepareSavedTodo();
  let accept = () => {};
  const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockImplementation(() => new Promise<void>(resolve => { accept = resolve; }));
  try {
    await measureTyping('session', async (container) => {
      await loadSavedTodo();
      await pickAgent(container, 'plan');
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
      await act(async () => useSessionUIStore.setState({ currentSessionId: 'other-session' }));
      await act(async () => accept());
      expect(patches).toEqual([{ stage: 'plan', expectedUpdatedAt: 1 }]);
      expect(savedCards[0]?.sessionId).toBe('ses_typing');
      expect(savedCards[0]?.stage).toBe('plan');
      expect(useSessionUIStore.getState().currentSessionId).toBe('other-session');
      savedCards = [];
    });
  } finally { accept(); send.mockRestore(); }
});

test('a lost promotion response reconciles on retry without sending another message', async () => {
  await prepareSavedTodo();
  const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockResolvedValue(undefined);
  try {
    await measureTyping('session', async (container) => {
      await loadSavedTodo();
      await pickAgent(container, 'plan');
      loseNextBoardResponse = true;
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
      expect(savedCards[0]?.stage).toBe('plan');
      expect(container.textContent).toContain('Message sent. The board could not be updated.');
      await act(async () => [...container.querySelectorAll<HTMLButtonElement>('[role="status"] button')].find(button => button.textContent === 'Try again')!.click());
      expect(send.mock.calls).toHaveLength(1);
      expect(patches).toHaveLength(2);
      expect(container.textContent).not.toContain('Message sent. The board could not be updated.');
      savedCards = [];
    });
  } finally { send.mockRestore(); }
});

test('switching runtimes during a send never promotes a card on the new server', async () => {
  await prepareSavedTodo();
  const { getRuntimeKey, getRuntimeApiBaseUrl, switchRuntimeEndpoint } = await import('@/lib/runtime-switch');
  const original = { runtimeKey: getRuntimeKey(), apiBaseUrl: getRuntimeApiBaseUrl() };
  let accept = () => {};
  const send = spyOn(useSessionUIStore.getState(), 'sendMessage').mockImplementation(() => new Promise<void>(resolve => { accept = resolve; }));
  try {
    await measureTyping('session', async (container) => {
      await loadSavedTodo();
      await pickAgent(container, 'plan');
      await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!.click());
      await act(async () => switchRuntimeEndpoint({ runtimeKey: 'other-todo-runtime', apiBaseUrl: 'https://other-todo.test' }));
      await act(async () => accept());
      expect(patches).toEqual([]);
      expect(savedCards[0]?.stage).toBe('todo');
      savedCards = [];
    });
  } finally { accept(); switchRuntimeEndpoint(original); send.mockRestore(); }
});
