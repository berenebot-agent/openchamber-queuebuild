import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPushRuntime } from './push-runtime.js';
import { sessionKeyFor } from './session-key.js';

const createRuntime = ({ subscriptionsBySession = {}, sendNotification = vi.fn(async () => {}) } = {}) => createPushRuntime({
  fsPromises: {
    mkdir: vi.fn(async () => {}),
    readFile: vi.fn(async () => JSON.stringify({ version: 1, subscriptionsBySession })),
    writeFile: vi.fn(async () => {}),
  },
  path: { dirname: () => '/tmp' },
  loadWebPush: async () => ({
    generateVAPIDKeys: vi.fn(() => ({ publicKey: 'public', privateKey: 'private' })),
    sendNotification,
    setVapidDetails: vi.fn(),
  }),
  PUSH_SUBSCRIPTIONS_FILE_PATH: '/tmp/push-subscriptions.json',
  readSettingsFromDiskMigrated: vi.fn(async () => ({})),
  writeSettingsToDisk: vi.fn(async () => {}),
});

describe('push recipient routing', () => {
  const payload = { title: 'Build ready', body: 'Done', tag: 'ready-ses_1', data: { sessionId: 'ses_1', url: '/?session=ses_1' } };
  const subscription = (endpoint, platform = 'android') => ({ endpoint, p256dh: 'key', auth: 'auth', platform });
  const fixture = () => {
    const sendNotification = vi.fn(async () => {});
    const runtime = createRuntime({
      subscriptionsBySession: {
        [sessionKeyFor('phone')]: [subscription('phone'), subscription('other-phone')],
        [sessionKeyFor('desktop')]: [subscription('desktop', 'web')],
      },
      sendNotification,
    });
    return { runtime, sendNotification };
  };
  const endpoints = (sender) => sender.mock.calls.map(([sub]) => sub.endpoint).sort();

  it('sends meaningful payloads to background and closed PWAs', async () => {
    const { runtime, sendNotification } = fixture();
    runtime.updateUiVisibility('phone', false, 'android', 'page', 'phone');
    await runtime.sendPushToAllUiSessions(payload, { requireNoSse: true });
    expect(endpoints(sendNotification)).toEqual(['desktop', 'other-phone', 'phone']);
    expect(sendNotification.mock.calls.every(([, body]) => body === JSON.stringify(payload))).toBe(true);
  });

  it.each([true, false])('suppresses only the foreground phone subscription with requireNoSse=%s', async (requireNoSse) => {
    const { runtime, sendNotification } = fixture();
    runtime.updateUiVisibility('phone', true, 'android', 'visible-page', 'phone');
    runtime.updateUiVisibility('phone', false, 'android', 'hidden-page', 'phone');
    await runtime.sendPushToAllUiSessions(payload, { requireNoSse });
    expect(endpoints(sendNotification)).toEqual(['desktop', 'other-phone']);
    expect(runtime.isUiVisible('phone')).toBe(true);
  });

  it('keeps desktop-to-phone suppression in hidden-only mode', async () => {
    const { runtime, sendNotification } = fixture();
    runtime.updateUiVisibility('desktop', true, 'desktop', 'desktop-page', 'desktop');
    await runtime.sendPushToAllUiSessions(payload, { requireNoSse: true });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it('allows background phones in always mode while desktop delivers locally', async () => {
    const { runtime, sendNotification } = fixture();
    runtime.updateUiVisibility('desktop', true, 'desktop', 'desktop-page', 'desktop');
    await runtime.sendPushToAllUiSessions(payload, { requireNoSse: false });
    expect(endpoints(sendNotification)).toEqual(['other-phone', 'phone']);
  });

  it('does not let a different authenticated session suppress an endpoint', async () => {
    const { runtime, sendNotification } = fixture();
    runtime.updateUiVisibility('unrelated', true, 'android', 'page', 'phone');
    await runtime.sendPushToAllUiSessions(payload, { requireNoSse: true });
    expect(endpoints(sendNotification)).toContain('phone');
  });

  it('expires crashed-client presence and resumes push', async () => {
    vi.useFakeTimers();
    const { runtime, sendNotification } = fixture();
    runtime.updateUiVisibility('phone', true, 'android', 'page', 'phone');
    vi.advanceTimersByTime(30_001);
    await runtime.sendPushToAllUiSessions(payload, { requireNoSse: true });
    expect(endpoints(sendNotification)).toContain('phone');
  });

  it('deduplicates an endpoint stored under multiple UI sessions and honors either foreground page', async () => {
    const sendNotification = vi.fn(async () => {});
    const runtime = createRuntime({
      subscriptionsBySession: { [sessionKeyFor('a')]: [subscription('shared')], [sessionKeyFor('b')]: [subscription('shared')] },
      sendNotification,
    });
    await runtime.sendPushToAllUiSessions(payload);
    expect(sendNotification).toHaveBeenCalledOnce();
    runtime.updateUiVisibility('b', true, 'android', 'page', 'shared');
    await runtime.sendPushToAllUiSessions(payload);
    expect(sendNotification).toHaveBeenCalledOnce();
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('push runtime visibility tracking', () => {
  it('keeps visible UI state when another client reports hidden', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const runtime = createRuntime();

    runtime.updateUiVisibility('visible-client', true);
    runtime.updateUiVisibility('hidden-client', false);

    expect(runtime.isAnyUiVisible()).toBe(true);
    expect(runtime.isUiVisible('visible-client')).toBe(true);
    expect(runtime.isUiVisible('hidden-client')).toBe(false);

    vi.advanceTimersByTime(30_001);

    expect(runtime.isAnyUiVisible()).toBe(false);
    expect(runtime.isUiVisible('visible-client')).toBe(false);
  });

  it('treats only mobile platforms as non-interactive for isAnyInteractiveClientVisible', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const runtime = createRuntime();

    // Only the phone (foreground) is connected → no interactive client to absorb the notification.
    runtime.updateUiVisibility('phone', true, 'ios');
    expect(runtime.isAnyUiVisible()).toBe(true);
    expect(runtime.isAnyInteractiveClientVisible()).toBe(false);

    // A visible desktop counts as interactive → suppress mobile push.
    runtime.updateUiVisibility('desktop', true, 'desktop');
    expect(runtime.isAnyInteractiveClientVisible()).toBe(true);

    // Desktop hidden again → back to mobile-only, push should flow to the phone.
    runtime.updateUiVisibility('desktop', false, 'desktop');
    expect(runtime.isAnyInteractiveClientVisible()).toBe(false);

    // A client that never reported a platform is treated as interactive (conservative).
    runtime.updateUiVisibility('legacy', true);
    expect(runtime.isAnyInteractiveClientVisible()).toBe(true);
  });

  it('remembers the last platform when a heartbeat omits it', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const runtime = createRuntime();
    runtime.updateUiVisibility('phone', true, 'android');
    runtime.updateUiVisibility('phone', true); // heartbeat without platform
    expect(runtime.isAnyInteractiveClientVisible()).toBe(false);
  });
});
