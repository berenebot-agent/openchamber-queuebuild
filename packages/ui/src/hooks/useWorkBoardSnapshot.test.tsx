import React, { act } from 'react';
import { afterAll, expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { makeSnapshot } from '@/components/workBoard/workBoardSnapshot.fixture';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true });
const { useWorkBoardSnapshot } = await import('./useWorkBoardSnapshot');

afterAll(() => browser.close());

class MockEventSource {
  static CLOSED = 2;
  static instances: MockEventSource[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public readonly url: string) { MockEventSource.instances.push(this); }
  close() { this.readyState = MockEventSource.CLOSED; }
}

const settle = async () => { for (let index = 0; index < 4; index += 1) await Promise.resolve(); };

const withMockEventSource = async <T,>(run: () => Promise<T>): Promise<T> => {
  MockEventSource.instances.length = 0;
  Object.defineProperty(globalThis, 'EventSource', { value: MockEventSource, configurable: true, writable: true });
  try { return await run(); } finally { Reflect.deleteProperty(globalThis, 'EventSource'); }
};

const mount = async (Probe: React.FC) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Probe />); await settle(); });
  return { container, unmount: async () => { await act(async () => root.unmount()); container.remove(); } };
};

const stream = () => {
  const source = MockEventSource.instances.at(-1);
  if (!source) throw new Error('the hook did not open the control stream');
  return source;
};

const emit = async (type: string) => {
  await act(async () => {
    stream().onmessage?.({ data: JSON.stringify({ type, properties: { directory: '/repo' } }) });
    await settle();
  });
};

test('the snapshot arrives once and then only on a server event', async () => {
  await withMockEventSource(async () => {
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(makeSnapshot()));
    const probe = await mount(function Probe() {
      const { snapshot } = useWorkBoardSnapshot('/repo');
      return <span>{snapshot ? 'loaded' : 'unknown'}</span>;
    });
    try {
      expect(probe.container.textContent).toBe('loaded');
      const before = fetch.mock.calls.length;
      // A build queue broadcast re-reads the board without waiting for a poll.
      await emit('openchamber:build-queue.updated');
      expect(fetch.mock.calls.length).toBe(before + 1);
      // So does a work-board event, which is how a Plan turn or card write lands.
      await emit('openchamber:work-board.updated');
      expect(fetch.mock.calls.length).toBe(before + 2);
    } finally {
      await probe.unmount();
      fetch.mockRestore();
    }
  });
});

test('a failed read keeps the last snapshot and reports the error on top of it', async () => {
  await withMockEventSource(async () => {
    let fail = false;
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () =>
      fail ? new Response('', { status: 503 }) : Response.json(makeSnapshot({ cards: [{
        id: 'card', lane: 'todo', status: 'none', directory: '/repo', text: 'Brief', attachments: [],
        createdAt: 1, updatedAt: 1, stage: 'todo', availableActions: ['complete', 'startPlan', 'remove'],
      }] })));
    const probe = await mount(function Probe() {
      const { snapshot, error } = useWorkBoardSnapshot('/repo');
      return <span>{`${snapshot?.cards.length ?? 'none'}/${error ? 'error' : 'ok'}`}</span>;
    });
    try {
      expect(probe.container.textContent).toBe('1/ok');
      fail = true;
      await emit('openchamber:build-queue.updated');
      // The card stays; the failure is shown rather than replacing the board.
      expect(probe.container.textContent).toBe('1/error');
    } finally {
      await probe.unmount();
      fetch.mockRestore();
    }
  });
});

test('a malformed payload is an error, never an empty board', async () => {
  await withMockEventSource(async () => {
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ directory: '/repo' }));
    const probe = await mount(function Probe() {
      const { snapshot, error } = useWorkBoardSnapshot('/repo');
      return <span>{`${snapshot ? 'snapshot' : 'none'}/${error ? 'error' : 'ok'}`}</span>;
    });
    try {
      expect(probe.container.textContent).toBe('none/error');
    } finally {
      await probe.unmount();
      fetch.mockRestore();
    }
  });
});

test('no directory reads nothing', async () => {
  await withMockEventSource(async () => {
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(makeSnapshot()));
    const probe = await mount(function Probe() {
      const { snapshot } = useWorkBoardSnapshot('');
      return <span>{snapshot ? 'loaded' : 'unknown'}</span>;
    });
    try {
      expect(probe.container.textContent).toBe('unknown');
      expect(fetch.mock.calls).toHaveLength(0);
    } finally {
      await probe.unmount();
      fetch.mockRestore();
    }
  });
});
