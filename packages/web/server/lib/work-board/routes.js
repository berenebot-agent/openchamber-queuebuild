import express from 'express';
import { z } from 'zod';
import { MAX_PAYLOAD_BYTES } from './store.js';

export function registerWorkBoardRoutes(app, { store, resolveProjectDirectory, messageQueueRuntime, workBoardProjection }) {
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
  // The board as one server-owned projection: effective lanes, order, queue
  // status and live activity, derived once in the server process. A failure here
  // is a real failure, not an empty board: the client keeps what it had.
  app.get('/api/work-board/snapshot', async (req, res) => {
    try {
      const query = z.object({ directory: z.string().trim().min(1), includeOlder: z.enum(['true', 'false']).optional() }).parse(req.query);
      if (!workBoardProjection) throw Object.assign(new Error('Work board snapshot is unavailable'), { status: 503 });
      const directory = await resolveDirectory(req, query.directory);
      return res.json(await workBoardProjection.snapshot(directory, { includeOlder: query.includeOlder === 'true' }));
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

  // A drag on the board, from the card's menu or with the check. Placing a card
  // is the user's own categorisation: it writes the board and nothing else, so a
  // drag never starts a turn. Only a linked session marked done reaches the
  // session-work state, and that is a separate, best-effort write the client
  // reports on its own. `before` names the card the moved one now sits in front
  // of; null puts it at the end of the lane.
  app.post('/api/work-board/:id/placement', json, async (req, res) => {
    try {
      const body = z.object({ lane: z.enum(['todo', 'plan', 'build', 'done']),
        expectedUpdatedAt: z.number().finite().optional(),
        before: z.string().min(1).nullable().optional(), directory: z.string().trim().min(1).optional(),
        sessionId: z.string().trim().min(1).optional(), text: z.string().optional() }).parse(req.body);
      // A card the board derives from a session has no stored record yet; its
      // first placement creates one, so the request carries what it needs.
      const directory = body.directory ? await resolveDirectory(req, body.directory) : undefined;
      return res.json({ card: await store.placement(req.params.id, { ...body, directory }) });
    } catch (error) { return failure(res, error); }
  });

  // The bulk form of the same move. Placing every card of one lane together is
  // one user action, and each card is still checked and written on its own, so a
  // card another client changed is reported instead of overwritten while the
  // rest of the move lands.
  app.post('/api/work-board/placement', json, async (req, res) => {
    try {
      const body = z.object({ directory: z.string().trim().min(1), lane: z.enum(['todo', 'plan', 'build', 'done']),
        targets: z.array(z.object({
          id: z.string().min(1), updatedAt: z.number().finite(), text: z.string(),
          sessionId: z.string().trim().min(1).optional(),
        })).min(1).max(1000) }).parse(req.body);
      const directory = await resolveDirectory(req, body.directory);
      const stored = new Map((await store.list(directory)).map(card => [card.id, card]));
      const placed = [];
      const failed = [];
      for (const target of body.targets) {
        try {
          const current = stored.get(target.id);
          if (!current && !(target.id === `session:${target.sessionId}` && target.sessionId
            && ![...stored.values()].some(card => card.sessionId === target.sessionId))) {
            throw Object.assign(new Error('Card changed. Refresh the board before moving it.'), { status: 409 });
          }
          // The version check runs inside the store's serialized write against
          // the card's current version, so a change made between this read and
          // the write is a 409, not an overwrite.
          placed.push(await store.placement(target.id, { lane: body.lane, directory,
            sessionId: target.sessionId, text: target.text, expectedUpdatedAt: target.updatedAt }));
        } catch (error) { failed.push({ id: target.id, error: error.message }); }
      }
      return res.json({ placed, failed });
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
