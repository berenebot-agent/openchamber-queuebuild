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
