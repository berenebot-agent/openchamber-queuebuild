import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { registerQueuePromptAdmission } from './prompt-admission-routes.js';
import { createAdmissionFacts } from './admission.js';

const SESSION = 'ses_route_admit_1';
const DIRECTORY = '/repo';

/**
 * The admission middleware sits in front of the generic OpenCode proxy. These
 * tests mount it ahead of a stand-in proxy that records what it would forward,
 * so both halves are observable: what was queued, and what reached OpenCode.
 */
const createApp = ({ session = { id: SESSION, agent: 'build' }, enabled = true, agents = [{ id: 'build', default: true }], commands = [] } = {}) => {
  const forwarded = [];
  const admitted = [];
  const messageQueueRuntime = {
    admitSubmission: vi.fn(async ({ sessionId, directory, item }) => {
      admitted.push({ sessionId, directory, item });
      return { admitted: true, itemId: 'queued-1' };
    }),
    queueEnabledStateFor: vi.fn(async () => enabled),
    resolveProjectIdentity: async ({ directory }) => (
      directory === DIRECTORY ? { directory, projectId: 'project-1' } : { directory: null, projectId: null }
    ),
  };
  const facts = createAdmissionFacts({
    openCodeFetch: async (fetchPath) => {
      if (fetchPath === `/api/session/${SESSION}`) return session;
      if (fetchPath === '/api/agent') return agents;
      if (fetchPath === '/api/command') return commands;
      return null;
    },
  });
  const app = express();
  // Parse for the stand-in proxy the way the real route family does, so the
  // tests see the same `req.body` shape an upstream call would.
  app.use(express.json({ limit: '50mb' }));
  registerQueuePromptAdmission(app, { messageQueueRuntime, facts, now: () => 1760000000000 });
  app.use('/api', (req, res) => {
    forwarded.push({ method: req.method, path: req.path, body: req.body });
    res.json({ data: { reached: 'opencode' } });
  });
  return { app, forwarded, admitted, messageQueueRuntime };
};

const post = (app, path, body, { admit = false, query = `?directory=${encodeURIComponent(DIRECTORY)}` } = {}) => {
  const req = request(app).post(`${path}${query}`).send(body);
  return admit ? req.set('x-openchamber-build-queue', 'admit') : req;
};

describe('queue admission routes', () => {
  it('queues a marked Build prompt and answers the inbox record the SDK decodes', async () => {
    const { app, forwarded, admitted, messageQueueRuntime } = createApp();
    const response = await post(app, `/api/session/${SESSION}/prompt`, { id: 'msg_9', text: 'ship it' }, { admit: true });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      data: {
        id: 'msg_9',
        sessionID: SESSION,
        time: { created: 1760000000000 },
        type: 'user',
        payload: { text: 'ship it' },
        delivery: 'queue',
      },
      queued: true,
    });
    // The headers are how the sender learns its prompt was queued and which
    // optimistic record can settle.
    expect(response.headers['x-openchamber-queued']).toBe('true');
    expect(response.headers['x-openchamber-queued-id']).toBe('msg_9');
    // It never reached OpenCode, and the queue got the prompt's identity.
    expect(forwarded).toEqual([]);
    expect(admitted).toHaveLength(1);
    expect(admitted[0].item.messageId).toBe('msg_9');
    expect(messageQueueRuntime.admitSubmission).toHaveBeenCalledTimes(1);
  });

  it('forwards an unmarked prompt of a non-Build session untouched', async () => {
    const { app, forwarded, messageQueueRuntime } = createApp({
      session: { id: SESSION, agent: 'plan' },
      agents: [{ id: 'plan', default: true }],
    });
    const response = await post(app, `/api/session/${SESSION}/prompt`, { id: 'msg_9', text: 'explain' });
    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0].body).toEqual({ id: 'msg_9', text: 'explain' });
    expect(messageQueueRuntime.admitSubmission).not.toHaveBeenCalled();
  });

  it('refuses an unmarked prompt that would bypass the queue on a Build session', async () => {
    const { app, forwarded, messageQueueRuntime } = createApp();
    const response = await post(app, `/api/session/${SESSION}/prompt`, { id: 'msg_9', text: 'ship it' });
    expect(response.status).toBe(409);
    expect(response.body.reason).toBe('build-session');
    expect(forwarded).toEqual([]);
    expect(messageQueueRuntime.admitSubmission).not.toHaveBeenCalled();
  });

  it('refuses an execution-starting synthetic that would start a Build turn', async () => {
    const { app, forwarded } = createApp();
    const withResume = await post(app, `/api/session/${SESSION}/synthetic`, { text: 'go', resume: true });
    expect(withResume.status).toBe(409);
    expect(withResume.body.reason).toBe('build-session');
    // The default is starting, so omitting the flag is refused too.
    const without = await post(app, `/api/session/${SESSION}/synthetic`, { text: 'go' });
    expect(without.status).toBe(409);
    expect(forwarded).toEqual([]);
  });

  it('lets an unmarked context-only synthetic through, and stages a marked one for the prompt that follows', async () => {
    const { app, forwarded, admitted } = createApp();
    // Unmarked: the queue is not involved, so it reaches OpenCode as it always did.
    const unmarked = await post(app, `/api/session/${SESSION}/synthetic`, { text: 'other context', resume: false });
    expect(unmarked.status).toBe(200);
    expect(forwarded).toHaveLength(1);

    // Marked: it rides the prompt the composer is about to queue.
    const marked = await post(app, `/api/session/${SESSION}/synthetic`, { text: 'standing context', resume: false }, { admit: true });
    expect(marked.status).toBe(200);

    await post(app, `/api/session/${SESSION}/prompt`, { id: 'msg_9', text: 'ship it' }, { admit: true });
    expect(admitted[0].item.admission.leading).toEqual([{ text: 'standing context' }]);
  });

  it('refuses a marked synthetic that would start execution', async () => {
    const { app, admitted } = createApp();
    const response = await post(app, `/api/session/${SESSION}/synthetic`, { text: 'go', resume: true }, { admit: true });
    expect(response.status).toBe(409);
    expect(response.body.reason).toBe('synthetic-execution');
    expect(admitted).toEqual([]);
  });

  it('answers a queued command with 204 and queues it', async () => {
    const { app, forwarded, admitted } = createApp({ commands: [{ name: 'ship', agent: 'build' }] });
    const response = await post(app, `/api/session/${SESSION}/command`, { name: 'ship', text: '' }, { admit: true });
    expect(response.status).toBe(204);
    expect(forwarded).toEqual([]);
    expect(admitted).toHaveLength(1);
  });

  it('forwards everything when the project turned the queue off', async () => {
    const { app, forwarded, messageQueueRuntime } = createApp({ enabled: false });
    const response = await post(app, `/api/session/${SESSION}/prompt`, { id: 'msg_9', text: 'ship it' }, { admit: true });
    expect(response.status).toBe(200);
    expect(forwarded).toHaveLength(1);
    expect(messageQueueRuntime.admitSubmission).not.toHaveBeenCalled();
  });

  it('reports a directory outside every project as a client error on the settings-facing path', async () => {
    const { app } = createApp();
    const response = await post(app, `/api/session/${SESSION}/prompt`, { id: 'msg_9', text: 'ship it' }, { admit: true, query: '?directory=/nowhere' });
    // No project to place it in: the request is not the queue's to take, so it
    // is forwarded to OpenCode as it arrived.
    expect(response.status).toBe(200);
  });

  it('does not forward a marked prompt when the queue refuses it', async () => {
    const { app, messageQueueRuntime } = createApp();
    messageQueueRuntime.admitSubmission.mockRejectedValueOnce(Object.assign(new Error('queue is full'), { status: 409 }));
    const response = await post(app, `/api/session/${SESSION}/prompt`, { id: 'msg_9', text: 'ship it' }, { admit: true });
    expect(response.status).toBe(409);
    expect(response.body.error).toBe('queue is full');
  });
});
