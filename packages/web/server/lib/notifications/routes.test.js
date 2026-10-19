import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { registerNotificationRoutes } from './routes.js';

const fixture = (token = 'authenticated-session') => {
  const app = express();
  app.use(express.json());
  const updateUiVisibility = vi.fn();
  registerNotificationRoutes(app, { getUiSessionTokenFromRequest: () => token, updateUiVisibility });
  return { app, updateUiVisibility };
};

describe('push visibility route', () => {
  it('passes client and subscription identity under the authenticated session', async () => {
    const { app, updateUiVisibility } = fixture();
    await request(app).post('/api/push/visibility').send({ visible: true, platform: 'android', clientId: 'page', endpoint: 'https://push.example/phone', token: 'forged' }).expect(200);
    expect(updateUiVisibility).toHaveBeenCalledExactlyOnceWith('authenticated-session', true, 'android', 'page', 'https://push.example/phone');
  });

  it('continues accepting legacy beacons', async () => {
    const { app, updateUiVisibility } = fixture();
    await request(app).post('/api/push/visibility').send({ visible: true }).expect(200);
    expect(updateUiVisibility).toHaveBeenCalledExactlyOnceWith('authenticated-session', true, undefined, undefined, undefined);
  });

  it('ignores malformed and oversized identities', async () => {
    const { app, updateUiVisibility } = fixture();
    await request(app).post('/api/push/visibility').send({ visible: 'yes', platform: [], clientId: 'x'.repeat(129), endpoint: 'x'.repeat(4097) }).expect(200);
    expect(updateUiVisibility).toHaveBeenCalledExactlyOnceWith('authenticated-session', false, undefined, undefined, undefined);
  });

  it('rejects unauthenticated beacons', async () => {
    const { app, updateUiVisibility } = fixture(null);
    await request(app).post('/api/push/visibility').send({ visible: true }).expect(401);
    expect(updateUiVisibility).not.toHaveBeenCalled();
  });
});
