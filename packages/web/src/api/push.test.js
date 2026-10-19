// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWebPushAPI } from './push';
import { getPushClientPlatform } from '@openchamber/ui/lib/platform';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const browser = (getSubscription = async () => ({ endpoint: 'https://push.example/phone' })) => {
  const fetch = vi.fn(async () => Response.json({ ok: true }));
  vi.stubGlobal('fetch', fetch);
  vi.stubGlobal('navigator', {
    userAgent: 'Mozilla/5.0 Android Chrome',
    serviceWorker: { getRegistration: async () => ({ pushManager: { getSubscription } }) },
  });
  return fetch;
};
const bodyOf = (fetch, index = 0) => JSON.parse(fetch.mock.calls[index][1].body);

describe('web push visibility adapter', () => {
  it('associates presence with the current subscription without resubscribing', async () => {
    const fetch = browser();
    const api = createWebPushAPI();
    await api.setVisibility({ visible: true, platform: 'android', clientId: 'page-1' });
    expect(bodyOf(fetch)).toEqual({ visible: true, platform: 'android', clientId: 'page-1', endpoint: 'https://push.example/phone' });
    expect(fetch.mock.calls[0][1].keepalive).toBe(true);
    await api.setVisibility({ visible: false, platform: 'android', clientId: 'page-1' });
    expect(bodyOf(fetch, 1)).toEqual({ visible: false, platform: 'android', clientId: 'page-1', endpoint: 'https://push.example/phone' });
  });

  it('does not send stale foreground presence after pagehide interrupts subscription lookup', async () => {
    let resolve;
    const fetch = browser(() => new Promise((done) => { resolve = done; }));
    const api = createWebPushAPI();
    const foreground = api.setVisibility({ visible: true, clientId: 'page-1' });
    await Promise.resolve();
    await api.setVisibility({ visible: false, clientId: 'page-1' });
    resolve({ endpoint: 'https://push.example/phone' });
    await foreground;
    expect(fetch).toHaveBeenCalledOnce();
    expect(bodyOf(fetch).visible).toBe(false);
  });

  it('reports presence when push is unsupported or subscription lookup fails', async () => {
    const fetch = browser(async () => { throw new Error('push unavailable'); });
    const api = createWebPushAPI();
    await api.setVisibility({ visible: true, clientId: 'page-1' });
    expect(bodyOf(fetch)).toEqual({ visible: true, clientId: 'page-1' });
  });

  it('registers mobile browser subscriptions with their push platform and refreshes presence', async () => {
    const fetch = browser();
    const changed = vi.fn();
    window.addEventListener('openchamber:push-subscription-changed', changed, { once: true });
    await createWebPushAPI().subscribe({ endpoint: 'https://push.example/phone', keys: { p256dh: 'key', auth: 'auth' }, platform: 'web' });
    expect(bodyOf(fetch).platform).toBe('android');
    expect(changed).toHaveBeenCalledOnce();
  });

  it.each([
    ['Mozilla/5.0 Android Chrome', 0, 'android'],
    ['Mozilla/5.0 iPhone Safari', 0, 'ios'],
    ['Mozilla/5.0 Macintosh Safari', 5, 'ios'],
    ['Mozilla/5.0 Macintosh Chrome', 0, 'web'],
  ])('identifies the mobile push platform for %s', (userAgent, maxTouchPoints, expected) => {
    vi.stubGlobal('navigator', { userAgent, maxTouchPoints });
    expect(getPushClientPlatform()).toBe(expected);
  });
});
