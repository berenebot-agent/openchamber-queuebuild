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

beforeEach(async () => {
  queue = { revision: 1, active: [], queued: [], issues: [], forced: [] };
  fetchSpy = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(queue));
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  fetchSpy.mockRestore();
});

const render = async (props: { sessionId?: string | null; directory?: string | null } = {}) => {
  await act(async () => root.render(
    <I18nProvider>
      <BuildQueueBanner sessionId={props.sessionId ?? SESSION} directory={props.directory ?? DIRECTORY} />
    </I18nProvider>,
  ));
};

test('no indicator while this project holds no build', async () => {
  await render();
  expect(container.textContent).toBe('');
});

test('shows the queued position and detail for this chat, with the board link as its only control', async () => {
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
  // The Work Board is the one place a build queue is managed: the indicator
  // shows state and opens it, and offers no cancel/restore of its own.
  const buttons = [...container.querySelectorAll('button')];
  expect(buttons).toHaveLength(1);
  expect(buttons[0].textContent).toBe('View on Work Board');
  expect(container.textContent).not.toContain('Cancel');
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
