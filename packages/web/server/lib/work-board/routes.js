import express from 'express';
import { z } from 'zod';
import { MAX_PAYLOAD_BYTES } from './store.js';

export function registerWorkBoardRoutes(app, { store, resolveProjectDirectory, messageQueueRuntime }) {
  const json = express.json({ limit: MAX_PAYLOAD_BYTES });
  const failure = (res, error) => res.status(error?.status || (error instanceof z.ZodError ? 400 : 500)).json({ error: error?.message || 'Work board request failed' });
  const resolveDirectory = async (req, directory) => {
    const request = directory === undefined
      ? req
      : { get: req.get.bind(req), query: { ...req.query, directory } };
    const resolved = await resolveProjectDirectory(request);
    if (!resolved.directory) throw Object.assign(new Error(resolved.error || 'Project directory is required'), { status: 400 });
    return resolved.directory;
  };
  app.get('/api/work-board', async (req, res) => {
    try {
      const query = z.object({ directory: z.string().trim().min(1).optional(), sessionId: z.string().trim().min(1).optional() }).parse(req.query);
      const directory = query.directory ? await resolveDirectory(req, query.directory) : undefined;
      return res.json({ cards: await store.list(directory, query.sessionId) });
    } catch (error) { return failure(res, error); }
  });
  app.post('/api/work-board', json, async (req, res) => {
    try {
      const body = z.object({ directory: z.string().trim().min(1) }).passthrough().parse(req.body);
      body.directory = await resolveDirectory(req, body.directory);
      return res.status(201).json({ card: await store.create(body) });
    } catch (error) { return failure(res, error); }
  });
  // Enforced server-side to prevent queued builds racing with a board update.
  app.post('/api/work-board/sessions/:sessionId/todo', json, async (req, res) => {
    try {
      if (!messageQueueRuntime?.parkSession) throw Object.assign(new Error('To-do parking is unavailable'), { status: 503 });
      const body = z.object({
        directory: z.string().trim().min(1),
        sessionDirectory: z.string().trim().min(1).optional(),
        text: z.string().default(''),
        attachments: z.array(z.unknown()).default([]),
      }).parse(req.body);
      const directory = await resolveDirectory(req, body.directory);
      const sessionDirectory = body.sessionDirectory ? await resolveDirectory(req, body.sessionDirectory) : directory;
      const sessionId = z.string().trim().min(1).parse(req.params.sessionId);
      const card = await messageQueueRuntime.parkSession(sessionId, sessionDirectory,
        () => store.parkSession({ directory, sessionId, text: body.text, attachments: body.attachments }));
      return res.json({ card });
    } catch (error) { return failure(res, error); }
  });

  app.post('/api/work-board/complete', json, async (req, res) => {
    try {
      const body = z.object({ directory: z.string().trim().min(1), targets: z.array(z.object({
        id: z.string().min(1), updatedAt: z.number().finite(), text: z.string(),
        sessionId: z.string().trim().min(1).optional(), sessionDirectory: z.string().trim().min(1).optional(),
      })).min(1).max(1000) }).parse(req.body);
      const directory = await resolveDirectory(req, body.directory);
      const completed = [];
      const failed = [];
      for (const target of body.targets) {
        try {
          const save = () => store.complete({ ...target, directory });
          if (target.sessionId) {
            if (!messageQueueRuntime?.parkSession) throw Object.assign(new Error('Session idle checks are unavailable'), { status: 503 });
            const sessionDirectory = target.sessionDirectory ? await resolveDirectory(req, target.sessionDirectory) : directory;
            await messageQueueRuntime.parkSession(target.sessionId, sessionDirectory, save);
          } else {
            await save();
          }
          completed.push(target.id);
        } catch (error) { failed.push({ id: target.id, error: error.message }); }
      }
      return res.json({ completed, failed });
    } catch (error) { return failure(res, error); }
  });

  app.patch('/api/work-board/:id', json, async (req, res) => {
    try { return res.json({ card: await store.update(req.params.id, req.body) }); }
    catch (error) { return failure(res, error); }
  });
  // Records that the user looked at a completed card, so every connected client
  // shares one acknowledgement. Scoped to a card id, which the board already has.
  app.post('/api/work-board/:id/viewed', json, async (req, res) => {
    try { return res.json({ card: await store.viewed(req.params.id) }); }
    catch (error) { return failure(res, error); }
  });
  app.delete('/api/work-board/:id', async (req, res) => {
    try {
      if (!(await store.delete(req.params.id))) return res.status(404).json({ error: 'Work board card not found' });
      return res.json({ ok: true });
    } catch (error) { return failure(res, error); }
  });
}
