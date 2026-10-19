// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { usePushVisibilityBeacon } from '@openchamber/ui/hooks/usePushVisibilityBeacon';
import { registerRuntimeAPIs } from '@openchamber/ui/contexts/runtimeAPIRegistry';

afterEach(() => {
  registerRuntimeAPIs(null);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('tracks each page independently, reports lifecycle changes, and refreshes after subscribing', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const setVisibility = vi.fn(async () => ({ ok: true }));
  registerRuntimeAPIs({ push: { setVisibility } });
  const Beacon = () => { usePushVisibilityBeacon(); return null; };
  const root = createRoot(document.createElement('div'));
  try {
    await act(() => root.render(React.createElement(React.Fragment, null, React.createElement(Beacon), React.createElement(Beacon))));
    expect(setVisibility).toHaveBeenCalledTimes(2);
    const [first, second] = setVisibility.mock.calls.map(([payload]) => payload);
    expect(first.clientId).not.toBe(second.clientId);
    expect(first.visible).toBe(true);
    await act(() => { vi.advanceTimersByTime(20_000); });
    expect(setVisibility).toHaveBeenCalledTimes(4);
    window.dispatchEvent(new Event('pagehide'));
    expect(setVisibility.mock.calls.slice(-2).every(([payload]) => !payload.visible)).toBe(true);
    window.dispatchEvent(new Event('openchamber:push-subscription-changed'));
    expect(setVisibility.mock.calls.slice(-2).every(([payload]) => payload.visible)).toBe(true);
  } finally {
    await act(() => root.unmount());
  }
  expect(setVisibility.mock.calls.slice(-2).every(([payload]) => !payload.visible)).toBe(true);
});
