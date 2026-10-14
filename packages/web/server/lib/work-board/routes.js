import express from 'express';
import { z } from 'zod';
import { MAX_PAYLOAD_BYTES } from './store.js';

export function registerWorkBoardRoutes(app, { store, resolveProjectDirectory }) {
  const json = express.json({ limit: MAX_PAYLOAD_BYTES });
  const failure = (res, error) => res.status(error?.status || (error instanceof z.ZodError ? 400 : 500)).json({ error: error?.message || 'Work board request failed' });
  app.get('/api/work-board', async (req, res) => {
    try {
      const query = z.object({ directory: z.string().trim().min(1).optional() }).parse(req.query);
      const directory = query.directory ? await resolveProjectDirectory(query.directory) : undefined;
      return res.json({ cards: await store.list(directory) });
    } catch (error) { return failure(res, error); }
  });
  app.post('/api/work-board', json, async (req, res) => {
    try {
      const body = z.object({ directory: z.string().trim().min(1) }).passthrough().parse(req.body);
      body.directory = await resolveProjectDirectory(body.directory);
      return res.status(201).json({ card: await store.create(body) });
    } catch (error) { return failure(res, error); }
  });
  app.patch('/api/work-board/:id', json, async (req, res) => {
    try { return res.json({ card: await store.update(req.params.id, req.body) }); }
    catch (error) { return failure(res, error); }
  });
  app.delete('/api/work-board/:id', async (req, res) => {
    try {
      if (!(await store.delete(req.params.id))) return res.status(404).json({ error: 'Work board card not found' });
      return res.json({ ok: true });
    } catch (error) { return failure(res, error); }
  });
}
