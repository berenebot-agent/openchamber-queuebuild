import React, { act } from 'react';
import { afterAll, expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true });
const { useBuildQueueSnapshot } = await import('./useBuildQueueSnapshot');

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

/** Flush the resolved fetch promise and the state update it schedules. */
const settle = async () => {
  for (let index = 0; index < 4; index += 1) await Promise.resolve();
};

const withMockEventSource = async <T,>(run: () => Promise<T>): Promise<T> => {
  MockEventSource.instances.length = 0;
  Object.defineProperty(globalThis, 'EventSource', { value: MockEventSource, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    Reflect.deleteProperty(globalThis, 'EventSource');
  }
};

const mount = async (Probe: React.FC) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(<Probe />); await settle(); });
  return {
    container,
    unmount: async () => { await act(async () => root.unmount()); container.remove(); },
  };
};

/** The event source the hook opened for this test (the last one). */
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

test('no polling timer exists: the snapshot arrives once and then only on a server event', async () => {
  await withMockEventSource(async () => {
    // A poll would call this; the hook must never schedule a timer.
    const interval = spyOn(globalThis, 'setInterval').mockImplementation(() => { throw new Error('interval must not be used'); });
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ revision: 1, active: [], queued: [], issues: [] }));
    const probe = await mount(function Probe() {
      const { snapshot } = useBuildQueueSnapshot();
      return <span>{snapshot ? 'loaded' : 'unknown'}</span>;
    });
    try {
      expect(probe.container.textContent).toBe('loaded');
      const before = fetch.mock.calls.length;

      // A reconnect re-announces readiness; the hook re-reads without any timer.
      await emit('openchamber:event-stream-ready');
      expect(fetch.mock.calls.length).toBe(before + 1);
      expect(interval.mock.calls).toHaveLength(0);
    } finally {
      await probe.unmount();
      fetch.mockRestore();
      interval.mockRestore();
    }
  });
});

test('a build queue broadcast refetches the snapshot without waiting for a poll', async () => {
  await withMockEventSource(async () => {
    let queued = 0;
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
      revision: 1, active: [], issues: [],
      queued: queued === 0 ? [] : [{ id: 'q1', sessionId: 's1', directory: '/repo', content: 'Build', createdAt: 1, order: 0, paused: false }],
    }));
    const probe = await mount(function Probe() {
      const { snapshot } = useBuildQueueSnapshot();
      return <span>{String(snapshot?.queued.length ?? 'unknown')}</span>;
    });
    try {
      expect(probe.container.textContent).toBe('0');
      queued = 1;
      await emit('openchamber:build-queue.updated');
      expect(probe.container.textContent).toBe('1');
    } finally {
      await probe.unmount();
      fetch.mockRestore();
    }
  });
});

test('a failed read keeps the last snapshot and reports the error on top of it', async () => {
  await withMockEventSource(async () => {
    let fail = false;
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => (
      fail
        ? new Response('', { status: 503 })
        : Response.json({ revision: 1, active: [], issues: [], queued: [{ id: 'q1', sessionId: 's1', directory: '/repo', content: 'Build', createdAt: 1, order: 0, paused: false }] })
    ));
    const probe = await mount(function Probe() {
      const { snapshot, error } = useBuildQueueSnapshot();
      return <span>{`${snapshot?.queued.length ?? 'none'}/${error ? 'error' : 'ok'}`}</span>;
    });
    try {
      expect(probe.container.textContent).toBe('1/ok');

      // The refresh after a mutation fails: the row stays, the error is shown.
      fail = true;
      await emit('openchamber:build-queue.updated');
      expect(probe.container.textContent).toBe('1/error');
    } finally {
      await probe.unmount();
      fetch.mockRestore();
    }
  });
});

test('an adopted live build needs no queued item id', async () => {
  await withMockEventSource(async () => {
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
      revision: 1, active: [{ directory: '/repo', sessionId: 'live', startedAt: 1, adopted: true }],
      queued: [], issues: [],
    }));
    const probe = await mount(function Probe() {
      const { snapshot, error } = useBuildQueueSnapshot();
      return <span>{`${snapshot?.active[0]?.sessionId ?? 'none'}/${error ? 'error' : 'ok'}`}</span>;
    });
    try {
      expect(probe.container.textContent).toBe('live/ok');
    } finally {
      await probe.unmount();
      fetch.mockRestore();
    }
  });
});

test('a counted live build remains a queue badge entry', async () => {
  await withMockEventSource(async () => {
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
      revision: 1, active: [], queued: [], issues: [],
      forced: [{ directory: '/repo', sessionId: 'included', startedAt: 1, counts: true }],
    }));
    const probe = await mount(function Probe() {
      const { snapshot } = useBuildQueueSnapshot();
      return <span>{String(snapshot?.forced?.[0]?.counts ?? 'unknown')}</span>;
    });
    try {
      expect(probe.container.textContent).toBe('true');
    } finally {
      await probe.unmount();
      fetch.mockRestore();
    }
  });
});

test('a malformed payload is an error, never an empty queue', async () => {
  await withMockEventSource(async () => {
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ revision: 1, active: [] }));
    const probe = await mount(function Probe() {
      const { snapshot, error } = useBuildQueueSnapshot();
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

test('disabled reads nothing, and an in-flight result is dropped when disabled', async () => {
  await withMockEventSource(async () => {
    let complete: ((response: Response) => void) | undefined;
    const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    function Probe({ enabled }: { enabled: boolean }) {
      const { snapshot, error } = useBuildQueueSnapshot(enabled);
      return <span>{snapshot ? 'loaded' : error ? 'error' : 'unknown'}</span>;
    }
    try {
      await act(async () => { root.render(<Probe enabled={false} />); });
      expect(fetch.mock.calls).toHaveLength(0);
      await act(async () => { root.render(<Probe enabled />); await settle(); });
      // One read for this mount (the shared control stream may reconnect a
      // previous mount's source, which legitimately reads too).
      const readsWhileEnabled = fetch.mock.calls.length;
      expect(readsWhileEnabled).toBeGreaterThanOrEqual(1);

      await act(async () => { root.render(<Probe enabled={false} />); });
      await act(async () => { complete?.(Response.json({ revision: 1, active: [], queued: [], issues: [] })); await settle(); });
      // Disabling cancels: the in-flight result is dropped and no new read starts.
      expect(container.textContent).toBe('unknown');
      expect(fetch.mock.calls).toHaveLength(readsWhileEnabled);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      fetch.mockRestore();
    }
  });
});
