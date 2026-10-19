/// <reference lib="webworker" />

import * as z from 'zod/mini';

// NOTE: keep the Workbox injection point so vite-plugin-pwa can build.
// We intentionally do not use Workbox runtime helpers here: iOS Safari can be
// fragile with more complex SW bundles. For push notifications we only need a
// minimal SW.

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision?: string }>;
};

const __precacheManifest = self.__WB_MANIFEST;

// Push data crosses a browser boundary. Decode each field independently so one
// bad field cannot discard the rest of a notification.
const stringField = z.catch(z.optional(z.string()), undefined);
const notificationData = z.catch(z.object({ url: stringField, sessionId: stringField, type: stringField }), {});
const pushPayload = z.catch(z.object({
  title: stringField,
  body: stringField,
  tag: stringField,
  icon: stringField,
  badge: stringField,
  data: notificationData,
}), { data: {} });

const sessionTarget = (data: z.infer<typeof notificationData>): string => {
  const fallback = data.sessionId?.trim() ? `/?session=${encodeURIComponent(data.sessionId.trim())}` : '/';
  try {
    const target = new URL(data.url?.trim() || fallback, self.location.origin);
    if (target.origin === self.location.origin && ['https:', 'http:'].includes(target.protocol)) return target.href;
  } catch {
    // A malformed URL still opens the session when its id is available.
  }
  return new URL(fallback, self.location.origin).href;
};

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  event.waitUntil((async () => {
    let payload = z.parse(pushPayload, undefined);
    try {
      payload = z.parse(pushPayload, event.data?.json());
    } catch {
      // Chromium requires user-visible delivery even for an unreadable push.
    }
    const title = payload.title?.trim() || 'OpenChamber';
    const body = payload.body ?? 'Open OpenChamber to view the update.';
    const icon = payload.icon?.trim() || '/pwa-192.png';
    const badge = payload.badge?.trim() || '/favicon-32.png';

    await self.registration.showNotification(title, {
      body,
      icon,
      badge,
      tag: payload.tag,
      data: payload.data,
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const data = z.parse(notificationData, event.notification.data);

  event.waitUntil((async () => {
    // Prefer focusing an already-open window (e.g. the installed PWA) and
    // navigating it to the target, instead of always spawning a new window.
    const target = sessionTarget(data);
    const windowClients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true,
    });

    for (const client of windowClients) {
      try {
        if ('navigate' in client) {
          await client.navigate(target);
        }
        if ('focus' in client) return await client.focus();
      } catch {
        // A closed or uncontrolled window must not prevent opening the session.
      }
    }

    if (self.clients.openWindow) {
      return self.clients.openWindow(target);
    }
  })());
});
