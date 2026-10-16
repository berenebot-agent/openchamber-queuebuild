import React, { act } from 'react';
import { afterAll, expect, spyOn, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, { window: browser, document: browser.document, navigator: browser.navigator,
  localStorage: browser.localStorage, sessionStorage: browser.sessionStorage, IS_REACT_ACT_ENVIRONMENT: true });
const { useBuildQueueSnapshot } = await import('./useBuildQueueSnapshot');

afterAll(() => browser.close());

test('disabled queue polling sends no requests and drops an in-flight result when disabled', async () => {
  let complete: ((response: Response) => void) | undefined;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(() => new Promise<Response>(resolve => { complete = resolve; }));
  const interval = spyOn(globalThis, 'setInterval');
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
    expect(interval.mock.calls).toHaveLength(0);
    await act(async () => { root.render(<Probe enabled />); });
    expect(fetch.mock.calls).toHaveLength(1);
    expect(interval.mock.calls).toHaveLength(1);
    await act(async () => { root.render(<Probe enabled={false} />); });
    await act(async () => { complete?.(Response.json({ revision: 1, active: [], queued: [], issues: [] })); });
    expect(container.textContent).toBe('unknown');
    expect(fetch.mock.calls).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    fetch.mockRestore();
    interval.mockRestore();
  }
});

test('a build queue broadcast refetches the snapshot without waiting for the poll', async () => {
  // The real stream path, driven the way the event-stream tests drive it, so the
  // hook is exercised through its actual subscription rather than a stub.
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
  Object.defineProperty(globalThis, 'EventSource', { value: MockEventSource, configurable: true, writable: true });
  let queued = 0;
  const fetch = spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({
    revision: 1, active: [], issues: [],
    queued: queued === 0 ? [] : [{ id: 'q1', sessionId: 's1', directory: '/repo', content: 'Build', createdAt: 1, order: 0, paused: false }],
  }));
  const interval = spyOn(globalThis, 'setInterval');
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  function Probe() {
    const { snapshot } = useBuildQueueSnapshot();
    return <span>{String(snapshot?.queued.length ?? 'unknown')}</span>;
  }
  try {
    await act(async () => { root.render(<Probe />); await Promise.resolve(); });
    expect(container.textContent).toBe('0');
    // The interval is stubbed and only the server changes `queued`, so the row
    // can only appear because the push caused the re-read.
    queued = 1;
    await act(async () => {
      MockEventSource.instances[0].onmessage?.({ data: JSON.stringify({ type: 'openchamber:build-queue.updated', properties: { directory: '/repo' } }) });
      await Promise.resolve();
    });
    expect(container.textContent).toBe('1');
  } finally {
    await act(async () => root.unmount());
    container.remove();
    Reflect.deleteProperty(globalThis, 'EventSource');
    fetch.mockRestore();
    interval.mockRestore();
  }
});
