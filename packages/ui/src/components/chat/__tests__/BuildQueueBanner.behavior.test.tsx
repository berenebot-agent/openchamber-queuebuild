import React, { act } from 'react';
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from 'bun:test';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getRuntimeKey } from '@/lib/runtime-switch';

const browser = new Window({ url: 'http://localhost/repo' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage,
  IS_REACT_ACT_ENVIRONMENT: true,
});
const { BuildQueueBanner } = await import('../BuildQueueBanner');

const DIRECTORY = '/repo';
const SESSION = 'ses_repo';

afterAll(() => browser.close());

type QueueEntry = { id: string; sessionId: string; directory: string; content: string; createdAt: number; order: number; paused: boolean };
type QueueLease = { directory: string; sessionId: string; itemId: string; startedAt: number; needsReview?: boolean; reviewReason?: string };
type QueueForced = { directory: string; sessionId: string; startedAt: number };
type QueueSnapshot = {
  revision: number; active: QueueLease[]; queued: QueueEntry[];
  issues: Array<{ directory: string; issue: string }>; forced: QueueForced[];
};
const snapshot: QueueSnapshot = {
  revision: 1,
  active: [],
  queued: [],
  issues: [],
  forced: [],
};

let queue: typeof snapshot;
let root: Root;
let container: HTMLDivElement;
let fetchSpy: ReturnType<typeof spyOn>;
let respond: (call: { url: string; method: string }) => Response | undefined = () => undefined;

beforeEach(async () => {
  queue = { revision: 1, active: [], queued: [], issues: [], forced: [] };
  respond = () => undefined;
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => (
    respond({ url: String(input), method: init?.method ?? 'GET' }) ?? Response.json(queue)
  ));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetchSpy.mockRestore();
});

const render = async (props: { sessionId?: string | null; directory?: string | null; onMessageRestored?: (message: { content: string }) => void } = {}) => {
  await act(async () => root.render(
    <I18nProvider>
      <BuildQueueBanner
        sessionId={props.sessionId ?? SESSION}
        directory={props.directory ?? DIRECTORY}
        onMessageRestored={props.onMessageRestored}
      />
    </I18nProvider>,
  ));
};

test('no indicator while this project holds no build', async () => {
  await render();
  expect(container.textContent).toBe('');
});

test('shows the queued position and detail for this chat, with cancel and the board link', async () => {
  queue = {
    revision: 1,
    active: [],
    queued: [
      { id: 'a', sessionId: SESSION, directory: DIRECTORY, content: 'x', createdAt: 1, order: 0, paused: false },
      { id: 'b', sessionId: SESSION, directory: DIRECTORY, content: 'y', createdAt: 2, order: 1, paused: false },
    ],
    issues: [],
    forced: [],
  };
  await render();
  expect(container.textContent).toContain('#1 of 2');
  expect(container.textContent).toContain('2 builds from this chat');
  // A queued build can be pulled back out of the queue from its own chat; the
  // board link stays for managing the rest of the project's queue.
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons.map(button => button.textContent)).toEqual(['Cancel', 'View on Work Board']);
});

test('cancelling pulls the build out of the queue and restores the draft to the composer', async () => {
  queue = {
    revision: 1,
    active: [],
    queued: [{ id: 'a', sessionId: SESSION, directory: DIRECTORY, content: 'typed brief', createdAt: 1, order: 0, paused: false }],
    issues: [],
    forced: [],
  };
  const calls: Array<{ url: string; method: string }> = [];
  respond = (call) => {
    calls.push(call);
    if (call.method !== 'DELETE') return undefined;
    return Response.json({
      revision: 2,
      session: { sessionId: SESSION, directory: DIRECTORY, items: [], sendingId: null },
      item: { id: 'a', createdAt: 1, content: 'typed brief', text: 'typed brief', attachments: [], sendConfig: { providerID: 'p', modelID: 'm' } },
    });
  };
  const restored: Array<{ content: string }> = [];
  await render({ onMessageRestored: message => restored.push(message) });

  const cancel = [...container.querySelectorAll('button')].find(button => button.textContent === 'Cancel');
  if (!cancel) throw new Error('expected a Cancel control');
  await act(async () => cancel.click());

  expect(calls.find(call => call.method === 'DELETE')?.url).toContain('/api/message-queue/sessions/ses_repo/items/a');
  expect(restored).toHaveLength(1);
  expect(restored[0]?.content).toBe('typed brief');
});

test('shows a review state for a build parked for review', async () => {
  queue = {
    revision: 1,
    active: [{ directory: DIRECTORY, sessionId: SESSION, itemId: 'a', startedAt: 1, needsReview: true }],
    queued: [],
    issues: [],
    forced: [],
  };
  await render();
  expect(container.textContent).toContain('needs review');
});

test('a queued entry that is the active lease reads as running, not a queue position', async () => {
  queue = {
    revision: 1,
    active: [{ directory: DIRECTORY, sessionId: SESSION, itemId: 'a', startedAt: 1 }],
    queued: [{ id: 'a', sessionId: SESSION, directory: DIRECTORY, content: 'x', createdAt: 1, order: 0, paused: false }],
    issues: [],
    forced: [],
  };
  await render();
  expect(container.textContent).toContain('Build running');
  expect(container.textContent).not.toContain('#1 of 1');
});

test('a waiting build counts only waiting entries, not the running lease', async () => {
  queue = {
    revision: 1,
    active: [{ directory: DIRECTORY, sessionId: 'other', itemId: 'a', startedAt: 1 }],
    queued: [
      { id: 'a', sessionId: 'other', directory: DIRECTORY, content: 'x', createdAt: 1, order: 0, paused: false },
      { id: 'b', sessionId: SESSION, directory: DIRECTORY, content: 'y', createdAt: 2, order: 1, paused: false },
    ],
    issues: [],
    forced: [],
  };
  await render();
  expect(container.textContent).toContain('#1 of 1');
});

test('stays silent for another session\'s active build in this project', async () => {
  queue = {
    revision: 1,
    active: [{ directory: DIRECTORY, sessionId: 'other', itemId: 'a', startedAt: 1 }],
    queued: [],
    issues: [],
    forced: [],
  };
  await render();
  expect(container.textContent).toBe('');
});

test('another project\'s queue never surfaces here', async () => {
  queue = {
    revision: 1,
    active: [],
    queued: [{ id: 'a', sessionId: SESSION, directory: '/other', content: 'x', createdAt: 1, order: 0, paused: false }],
    issues: [],
    forced: [],
  };
  await render();
  expect(container.textContent).toBe('');
});

test('the board link opens the Work Board on this session\'s project, not another tab', async () => {
  const runtimeKey = getRuntimeKey();
  const projects = useProjectsStore.getState();
  const ui = useUIStore.getState();
  const sessionUI = useSessionUIStore.getState();
  try {
    useProjectsStore.setState({
      projects: [
        { id: 'project', path: DIRECTORY, label: 'Repo', addedAt: 1 },
        { id: 'other', path: '/other', label: 'Other', addedAt: 1 },
      ],
      activeProjectId: 'other',
      hasServerSnapshot: true,
    });
    useUIStore.setState({
      workBoardProjectTabsByRuntime: { [runtimeKey]: { projectIds: ['other'], activeProjectId: 'other' } },
      workBoardProjectId: 'other',
      isWorkBoardOpen: false,
    });
    useSessionUIStore.setState({ currentSessionId: SESSION, currentSessionDirectory: DIRECTORY });
    queue = {
      revision: 1,
      active: [],
      queued: [{ id: 'a', sessionId: SESSION, directory: DIRECTORY, content: 'x', createdAt: 1, order: 0, paused: false }],
      issues: [],
      forced: [],
    };
    await render();

    const link = [...container.querySelectorAll('button')].find(button => button.textContent === 'View on Work Board');
    if (!link) throw new Error('expected the Work Board link');
    await act(async () => link.click());

    expect(useUIStore.getState().isWorkBoardOpen).toBe(true);
    expect(useUIStore.getState().workBoardProjectId).toBe('project');
    expect(useUIStore.getState().workBoardProjectTabsByRuntime[runtimeKey]?.activeProjectId).toBe('project');
  } finally {
    useProjectsStore.setState(projects);
    useUIStore.setState(ui);
    useSessionUIStore.setState(sessionUI);
  }
});
