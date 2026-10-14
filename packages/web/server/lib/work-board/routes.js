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
      const query = z.object({ directory: z.string().trim().min(1).optional() }).parse(req.query);
      const directory = query.directory ? await resolveDirectory(req, query.directory) : undefined;
      return res.json({ cards: await store.list(directory) });
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
        text: z.string().default(''),
        attachments: z.array(z.unknown()).default([]),
      }).parse(req.body);
      const directory = await resolveDirectory(req, body.directory);
      const sessionId = z.string().trim().min(1).parse(req.params.sessionId);
      const card = await messageQueueRuntime.parkSession(sessionId, directory, async pending => {
        const queuedFiles = pending.flatMap(item => {
          if (item.context?.length) throw Object.assign(new Error('Queued build has additional context; remove it manually before parking'), { status: 409 });
          return (item.attachments ?? []).map(file => {
            if (!file.dataUrl || !file.size) throw Object.assign(new Error('Queued build has an attachment that cannot be saved to To-do'), { status: 409 });
            return { id: file.id, filename: file.filename, mimeType: file.mimeType, size: file.size, dataUrl: file.dataUrl };
          });
        });
        const existing = (await store.list(directory)).find(entry => entry.sessionId === sessionId);
        const parts = [existing?.text, ...pending.map(item => item.text || item.content), body.text].filter(value => typeof value === 'string' && value.trim());
        const text = [...new Set(parts)].join('\n\n');
        const attachments = [...(existing?.attachments ?? []), ...queuedFiles, ...body.attachments];
        if (!text.trim() && !attachments.length) throw Object.assign(new Error('Add notes before parking this session'), { status: 400 });
        if (existing) return store.update(existing.id, { text, attachments, stage: 'todo' });
        const created = await store.create({ directory, text, attachments });
        return store.update(created.id, { sessionId, stage: 'todo' });
      });
      return res.json({ card });
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
