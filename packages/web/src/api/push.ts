import type { ApnsTokenPayload, PushAPI, PushSubscribePayload, PushUnsubscribePayload } from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import { getPushClientPlatform, isCapacitorApp } from '@openchamber/ui/lib/platform';

const fetchJson = async <T>(input: string | URL | Request, init?: RequestInit): Promise<T | null> => {
  try {
    const res = await runtimeFetch(input, {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init?.headers ?? {}),
      },
    });

    if (!res.ok) {
      return null;
    }

    return (await res.json()) as T;
  } catch {
    return null;
  }
};

export const createWebPushAPI = (): PushAPI => {
  let endpoint: string | undefined;
  let visibilityRevision = 0;
  return {
    async getVapidPublicKey() {
      return fetchJson<{ publicKey: string }>('/api/push/vapid-public-key');
    },

    async subscribe(payload: PushSubscribePayload) {
      endpoint = payload.endpoint;
      const result = await fetchJson<{ ok: true }>('/api/push/subscribe', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...payload, platform: getPushClientPlatform() }),
      });
      if (result?.ok) window.dispatchEvent(new Event('openchamber:push-subscription-changed'));
      return result;
    },

    async unsubscribe(payload: PushUnsubscribePayload) {
      if (endpoint === payload.endpoint) endpoint = undefined;
      return fetchJson<{ ok: true }>('/api/push/subscribe', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    },

    async setVisibility(payload) {
      const revision = ++visibilityRevision;
      if (payload.visible && !isCapacitorApp() && 'serviceWorker' in navigator) {
        try {
          const registration = await navigator.serviceWorker.getRegistration();
          endpoint = (await registration?.pushManager?.getSubscription())?.endpoint;
        } catch {
          // Presence still works when push is unavailable or permission was revoked.
          endpoint = undefined;
        }
      }
      // A blur/pagehide can supersede the async subscription lookup on focus.
      if (revision !== visibilityRevision) return null;
      return fetchJson<{ ok: true }>('/api/push/visibility', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ...payload, endpoint }),
        keepalive: true,
      });
    },

    async registerApnsToken(payload: ApnsTokenPayload) {
      return fetchJson<{ ok: true }>('/api/push/apns-token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    },

    async unregisterApnsToken(payload: ApnsTokenPayload) {
      return fetchJson<{ ok: true }>('/api/push/apns-token', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    },
  };
};
