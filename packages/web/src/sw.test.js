import { afterEach, describe, expect, it, vi } from 'vitest';

const installWorker = async (windows = []) => {
  const handlers = new Map();
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => {});
  const skipWaiting = vi.fn(async () => {});
  const claim = vi.fn(async () => {});
  vi.stubGlobal('self', {
    __WB_MANIFEST: [],
    location: { origin: 'https://chamber.example' },
    addEventListener: (type, handler) => handlers.set(type, handler),
    registration: { showNotification },
    clients: { matchAll: vi.fn(async () => windows), openWindow, claim },
    skipWaiting,
  });
  await import('./sw.ts');
  const dispatch = (type, event = {}) => {
    let completion;
    handlers.get(type)({ ...event, waitUntil: (promise) => { completion = promise; } });
    expect(completion).toBeInstanceOf(Promise);
    return completion;
  };
  return { dispatch, showNotification, openWindow, skipWaiting, claim };
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('PWA push delivery', () => {
  it.each(['foreground', 'background', 'closed'])('displays received push in a %s PWA', async (state) => {
    const windows = state === 'closed' ? [] : [{ visibilityState: state === 'foreground' ? 'visible' : 'hidden', focused: state === 'foreground' }];
    const worker = await installWorker(windows);
    const payload = {
      title: 'Build ready', body: 'Finished the task', icon: '/pwa-512.png', badge: '/favicon-32.png', tag: 'ready-session',
      data: { url: '/?session=ses_1', sessionId: 'ses_1', type: 'ready' },
    };
    await worker.dispatch('push', { data: { json: () => payload } });
    expect(worker.showNotification).toHaveBeenCalledExactlyOnceWith(payload.title, {
      body: payload.body, icon: payload.icon, badge: payload.badge, tag: payload.tag, data: payload.data,
    });
  });

  it.each([undefined, null, [], 42, 'invalid', {}, { title: {}, body: [], data: false }])('displays a branded fallback for %j', async (payload) => {
    const worker = await installWorker();
    await worker.dispatch('push', { data: payload === undefined ? undefined : { json: () => payload } });
    expect(worker.showNotification).toHaveBeenCalledExactlyOnceWith('OpenChamber', expect.objectContaining({
      body: 'Open OpenChamber to view the update.', icon: '/pwa-192.png', badge: '/favicon-32.png',
    }));
  });

  it('displays a fallback when JSON parsing throws', async () => {
    const worker = await installWorker();
    await worker.dispatch('push', { data: { json: () => { throw new SyntaxError('invalid JSON'); } } });
    expect(worker.showNotification).toHaveBeenCalledTimes(1);
  });

  it('retains valid fields when other fields are malformed and preserves a privacy-redacted body', async () => {
    const worker = await installWorker();
    await worker.dispatch('push', { data: { json: () => ({ title: 'Agent update', body: '', tag: 42, icon: {}, data: { sessionId: 'ses_private', url: [], type: 'ready' } }) } });
    expect(worker.showNotification).toHaveBeenCalledExactlyOnceWith('Agent update', expect.objectContaining({
      body: '', tag: undefined, icon: '/pwa-192.png', data: { sessionId: 'ses_private', url: undefined, type: 'ready' },
    }));
  });

  it('does not swallow a browser notification-display failure', async () => {
    const worker = await installWorker();
    worker.showNotification.mockRejectedValueOnce(new Error('permission revoked'));
    await expect(worker.dispatch('push')).rejects.toThrow('permission revoked');
  });
});

describe('PWA notification clicks and updates', () => {
  it('navigates and focuses an existing PWA window', async () => {
    const navigate = vi.fn(async () => {});
    const focus = vi.fn(async () => {});
    const worker = await installWorker([{ navigate, focus }]);
    const close = vi.fn();
    await worker.dispatch('notificationclick', { notification: { close, data: { url: '/?session=ses_1', sessionId: 'ses_1' } } });
    expect(close).toHaveBeenCalledOnce();
    expect(navigate).toHaveBeenCalledExactlyOnceWith('https://chamber.example/?session=ses_1');
    expect(focus).toHaveBeenCalledOnce();
    expect(worker.openWindow).not.toHaveBeenCalled();
  });

  it.each([
    [{ sessionId: 'session with spaces' }, 'https://chamber.example/?session=session%20with%20spaces'],
    [{ url: 'https://other.example', sessionId: 'ses_1' }, 'https://chamber.example/?session=ses_1'],
    [{ url: 'http://[', sessionId: 'ses_1' }, 'https://chamber.example/?session=ses_1'],
    [null, 'https://chamber.example/'],
  ])('opens a safe session target for %j', async (data, target) => {
    const worker = await installWorker();
    await worker.dispatch('notificationclick', { notification: { close: vi.fn(), data } });
    expect(worker.openWindow).toHaveBeenCalledExactlyOnceWith(target);
  });

  it('opens a new window when existing windows cannot navigate or focus', async () => {
    const worker = await installWorker([{ navigate: vi.fn(async () => { throw new Error('closed'); }), focus: vi.fn() }]);
    await worker.dispatch('notificationclick', { notification: { close: vi.fn(), data: { sessionId: 'ses_1' } } });
    expect(worker.openWindow).toHaveBeenCalledExactlyOnceWith('https://chamber.example/?session=ses_1');
  });

  it('activates an updated worker without waiting for every old tab to close', async () => {
    const worker = await installWorker();
    await worker.dispatch('install');
    await worker.dispatch('activate');
    expect(worker.skipWaiting).toHaveBeenCalledOnce();
    expect(worker.claim).toHaveBeenCalledOnce();
  });
});
