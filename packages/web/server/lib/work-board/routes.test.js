import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerWorkBoardRoutes } from './routes.js';
import { createWorkBoardStore } from './store.js';

describe('work board HTTP routes', () => {
  it('updates and removes a linked brief over HTTP while retaining its session and lane after restart', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-remove-brief-'));
    try {
      const store = createWorkBoardStore({ dataDir });
      const original = await store.parkSession({ directory: '/repo', sessionId: 'session1', text: 'Original brief', attachments: [] });
      const app = express();
      registerWorkBoardRoutes(app, { store, resolveProjectDirectory: async req => ({ directory: req.query.directory }) });
      const edited = await request(app).patch(`/api/work-board/${original.id}`)
        .send({ text: 'Updated brief', expectedUpdatedAt: original.updatedAt }).expect(200);
      await request(app).patch(`/api/work-board/${original.id}`)
        .send({ removeBrief: true, expectedUpdatedAt: original.updatedAt }).expect(409);
      const removed = await request(app).patch(`/api/work-board/${original.id}`)
        .send({ removeBrief: true, expectedUpdatedAt: edited.body.card.updatedAt }).expect(200);
      expect(removed.body.card).toEqual({ ...edited.body.card, text: '', attachments: [], briefRemoved: true });
      const session = await request(app).get('/api/work-board').query({ sessionId: 'session1' }).expect(200);
      const board = await request(app).get('/api/work-board').query({ directory: '/repo' }).expect(200);
      expect(session.body.cards).toEqual([removed.body.card]);
      expect(board.body.cards).toEqual([removed.body.card]);
      expect(await createWorkBoardStore({ dataDir }).list()).toEqual([removed.body.card]);
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });

  it('restores saved session briefs after restart, scoped by session across board and worktree directories', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-session-'));
    try {
      const store = createWorkBoardStore({ dataDir });
      const attachment = { id: 'file1', filename: 'notes.txt', mimeType: 'text/plain', size: 2, dataUrl: 'data:text/plain;base64,aGk=' };
      const first = await store.parkSession({ directory: '/repo', sessionId: 'plan1', text: 'First line\nFull saved text', attachments: [attachment] });
      await store.parkSession({ directory: '/repo', sessionId: 'build1', text: 'Build follow-up', attachments: [] });
      await store.create({ directory: '/repo', text: 'Unlinked card' });
      const app = express();
      registerWorkBoardRoutes(app, { store: createWorkBoardStore({ dataDir }), resolveProjectDirectory: async req => ({ directory: req.query.directory }) });
      const restored = await request(app).get('/api/work-board').query({ sessionId: 'plan1' }).expect(200);
      expect(restored.body.cards).toEqual([first]);
      const build = await request(app).get('/api/work-board').query({ sessionId: 'build1' }).expect(200);
      expect(build.body.cards.map(card => card.text)).toEqual(['Build follow-up']);
      const missing = await request(app).get('/api/work-board').query({ sessionId: 'missing' }).expect(200);
      expect(missing.body.cards).toEqual([]);
      const other = await request(app).get('/api/work-board').query({ directory: '/other', sessionId: 'plan1' }).expect(200);
      expect(other.body.cards).toEqual([]);
      await request(app).get('/api/work-board').query({ sessionId: '' }).expect(400);
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });

  it('creates an inherited card on its first placement and refuses a duplicate', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-place-inherited-'));
    try {
      const store = createWorkBoardStore({ dataDir });
      const app = express();
      registerWorkBoardRoutes(app, { store, resolveProjectDirectory: async req => ({ directory: req.query.directory }) });
      // A card the board derived from a session has no stored record yet. Its
      // text is only the session's title, so the card it creates has no brief.
      const created = await request(app).post('/api/work-board/session:session1/placement')
        .send({ lane: 'done', before: null, directory: '/repo', sessionId: 'session1', text: 'Inherited plan' })
        .expect(200);
      expect(created.body.card).toMatchObject({ directory: '/repo', sessionId: 'session1', text: '', briefRemoved: true, stage: 'done' });
      // The stored card now owns that session, so a second inherited id for the
      // same session is refused rather than duplicated.
      await request(app).post('/api/work-board/session:session1/placement')
        .send({ lane: 'todo', directory: '/repo', sessionId: 'session1', text: 'Duplicate' })
        .expect(404);
      expect(await createWorkBoardStore({ dataDir }).list('/repo')).toHaveLength(1);
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });

  it('places a bulk move per card and leaves another project untouched', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-complete-'));
    try {
      const store = createWorkBoardStore({ dataDir });
      const todo = await store.create({ directory: '/repo', text: 'To-do' });
      const linked = await store.update((await store.create({ directory: '/repo', text: 'Linked' })).id, { sessionId: 'session1' });
      const other = await store.create({ directory: '/other', text: 'Other project' });
      const app = express();
      registerWorkBoardRoutes(app, { store, resolveProjectDirectory: async req => ({ directory: req.query.directory }) });
      const response = await request(app).post('/api/work-board/placement').send({
        directory: '/repo', lane: 'done',
        // `other` is a real card in another project, so its conflict is the
        // card-level 409 the route reports rather than a project-wide failure.
        targets: [todo, linked, other].map(card => ({ id: card.id, updatedAt: card.updatedAt, text: card.text })),
      }).expect(200);
      expect(response.body.placed.map(card => card.id)).toEqual([todo.id, linked.id]);
      expect(response.body.failed.map(entry => entry.id)).toEqual([other.id]);
      expect(await store.list('/other')).toEqual([other]);
      // Every staged card keeps its session link and its own completion stamp.
      const settled = await store.list('/repo');
      expect(settled.map(card => card.stage)).toEqual(['done', 'done']);
      // One server clock orders the pair: each carries a store-generated stamp
      // close to the other, never a client's own clock.
      expect(Math.abs(settled[0].completedAt - settled[1].completedAt)).toBeLessThan(1000);
      expect(settled[0].placementAt).toBe(settled[0].completedAt);
      await request(app).post('/api/work-board/placement').send({ directory: '/repo', lane: 'done', targets: [] }).expect(400);
      await request(app).post('/api/work-board/placement').send({ directory: '/repo', lane: 'queue', targets: [] }).expect(400);
      await request(app).patch('/api/work-board/arbitrary').send({ stage: 'done' }).expect(400);
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });

  it('parses writes without a global JSON parser and preserves linked card contents', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-http-'));
    try {
      const app = express();
      registerWorkBoardRoutes(app, { store: createWorkBoardStore({ dataDir }), resolveProjectDirectory: async req => ({ directory: req.query.directory, error: null }) });
      const attachment = { id: 'file1', filename: 'notes.txt', mimeType: 'text/plain', size: 2, dataUrl: 'data:text/plain;base64,aGk=' };
      const saved = await request(app).post('/api/work-board').send({ directory: '/repo', text: 'Brief', attachments: [attachment] }).expect(201);
      const { id } = saved.body.card;
      await request(app).patch(`/api/work-board/${id}`).send({ stage: 'plan' }).expect(409);
      await request(app).patch(`/api/work-board/${id}`).send({ sessionId: 'session1' }).expect(200);
      await request(app).patch(`/api/work-board/${id}`).send({ sessionId: 'session2' }).expect(409);
      await request(app).patch(`/api/work-board/${id}`).send({ stage: 'plan' }).expect(200);
      const list = await request(app).get('/api/work-board').query({ directory: '/repo' }).expect(200);
      expect(list.body.cards[0]).toMatchObject({ id, text: 'Brief', attachments: [attachment], sessionId: 'session1', stage: 'plan' });
      await request(app).delete(`/api/work-board/${id}`).expect(200);
      await request(app).delete(`/api/work-board/${id}`).expect(404);
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });

  it('reports stale edits and accepts an explicit overwrite against the latest card version', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-edit-conflict-'));
    try {
      const app = express();
      registerWorkBoardRoutes(app, { store: createWorkBoardStore({ dataDir }), resolveProjectDirectory: async req => ({ directory: req.query.directory, error: null }) });
      const created = await request(app).post('/api/work-board').send({ directory: '/repo', text: 'Original' }).expect(201);
      const initial = created.body.card;
      const savedElsewhere = await request(app).patch(`/api/work-board/${initial.id}`)
        .send({ text: 'Other version', expectedUpdatedAt: initial.updatedAt }).expect(200);
      await request(app).patch(`/api/work-board/${initial.id}`)
        .send({ text: 'Stale version', expectedUpdatedAt: initial.updatedAt }).expect(409);
      const overwritten = await request(app).patch(`/api/work-board/${initial.id}`)
        .send({ text: 'Chosen version', expectedUpdatedAt: savedElsewhere.body.card.updatedAt }).expect(200);
      expect(overwritten.body.card.text).toBe('Chosen version');
      expect(overwritten.body.card.updatedAt).toBeGreaterThan(savedElsewhere.body.card.updatedAt);
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });

  it('rejects corrupt persisted cards and never overwrites them on a later save', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-corrupt-'));
    try {
      const file = path.join(dataDir, 'work-board.json');
      const broken = JSON.stringify({ version: 1, cards: [{ id: 'broken' }] });
      await fs.writeFile(file, broken);
      const store = createWorkBoardStore({ dataDir });
      await expect(store.list()).rejects.toThrow();
      await expect(store.create({ directory: '/repo', text: 'Brief' })).rejects.toThrow();
      expect(await fs.readFile(file, 'utf8')).toBe(broken);
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });

  it('parks an already linked session without duplicating its card', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-park-'));
    try {
      const store = createWorkBoardStore({ dataDir });
      const original = await store.create({ directory: '/repo', text: 'Original brief', attachments: [] });
      await store.update(original.id, { sessionId: 'session1', stage: 'plan' });
      const messageQueueRuntime = {
        parkSession: async (id, directory, save) => {
          expect([id, directory]).toEqual(['session1', '/repo']);
          return save([]);
        },
      };
      const app = express();
      registerWorkBoardRoutes(app, { store, messageQueueRuntime, resolveProjectDirectory: async req => ({ directory: req.query.directory }) });
      const response = await request(app).post('/api/work-board/sessions/session1/todo')
        .send({ directory: '/repo', text: 'Additional note', attachments: [] }).expect(200);
      expect(response.body.card).toMatchObject({ id: original.id, sessionId: 'session1', stage: 'todo' });
      expect(response.body.card.text).toContain('Additional note');
      expect(await store.list('/repo')).toHaveLength(1);
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });

  it('shares one completion acknowledgement across clients and rejects unknown cards', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-viewed-'));
    try {
      const store = createWorkBoardStore({ dataDir });
      const completed = await store.complete(await store.create({ directory: '/repo', text: 'Finished brief', attachments: [] }));
      const app = express();
      registerWorkBoardRoutes(app, { store, resolveProjectDirectory: async req => ({ directory: req.query.directory }) });
      await request(app).post('/api/work-board/missing/viewed').expect(404);
      const acknowledged = await request(app).post(`/api/work-board/${encodeURIComponent(completed.id)}/viewed`).expect(200);
      expect(acknowledged.body.card).toMatchObject({ id: completed.id, viewedAt: completed.completedAt });
      // A second client sees the acknowledgement through a plain read.
      const listed = await request(app).get('/api/work-board').query({ directory: '/repo' }).expect(200);
      expect(listed.body.cards[0].viewedAt).toBe(completed.completedAt);
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });

});

describe('work board placement routes', () => {
  it('places one card, orders its lane, and leaves the queue alone', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-place-'));
    try {
      const store = createWorkBoardStore({ dataDir });
      const app = express();
      registerWorkBoardRoutes(app, { store, resolveProjectDirectory: async req => ({ directory: req.query.directory }) });
      const first = await store.create({ directory: '/repo', text: 'First' });
      const second = await store.create({ directory: '/repo', text: 'Second' });
      // A move without `before` writes the lane and the completion but leaves
      // any stored arrangement alone. The completion and placement stamps come
      // from the server's clock.
      const moved = await request(app).post(`/api/work-board/${first.id}/placement`)
        .send({ lane: 'done' }).expect(200);
      expect(moved.body.card).toMatchObject({ stage: 'done' });
      expect(moved.body.card.completedAt).toBe(moved.body.card.placementAt);
      // `before` names the card it now sits in front of, and `null` puts it at
      // the end of the lane. The card that was dropped carries the place; the
      // rest of the lane keeps the order the file already had.
      const second2 = await store.placement(second.id, { lane: 'todo', before: null });
      const firstBack = await request(app).post(`/api/work-board/${first.id}/placement`)
        .send({ lane: 'todo', before: null }).expect(200);
      expect(firstBack.body.card).toMatchObject({ stage: 'todo', placementBefore: null });
      expect(second2.placementBefore).toBe(null);
      const board = await request(app).get('/api/work-board').query({ directory: '/repo' }).expect(200);
      expect(board.body.cards.map(card => [card.id, card.placementBefore]))
        .toEqual([[first.id, null], [second.id, null]]);
      // A move that names no place clears the drop: the card goes back to the
      // lane's own order instead of keeping a stale anchor.
      const cleared = await store.placement(first.id, { lane: 'todo' });
      expect(cleared.placementBefore).toBeUndefined();
      // A placement is the board's own write: it never reaches the queue.
      await request(app).post(`/api/work-board/${first.id}/placement`).send({ lane: 'queue' }).expect(400);
      await request(app).post(`/api/work-board/missing/placement`).send({ lane: 'done' }).expect(404);
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });

  it('places a bulk move independently and reports a stale card instead of overwriting it', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-place-bulk-'));
    try {
      const store = createWorkBoardStore({ dataDir });
      const app = express();
      registerWorkBoardRoutes(app, { store, resolveProjectDirectory: async req => ({ directory: req.query.directory }) });
      const one = await store.create({ directory: '/repo', text: 'One' });
      const two = await store.create({ directory: '/repo', text: 'Two' });
      await store.update(two.id, { text: 'Two changed elsewhere' });
      const response = await request(app).post('/api/work-board/placement').send({
        directory: '/repo', lane: 'done',
        targets: [
          { id: one.id, updatedAt: one.updatedAt, text: one.text },
          { id: two.id, updatedAt: two.updatedAt, text: two.text },
        ],
      }).expect(200);
      expect(response.body.placed.map(card => card.id)).toEqual([one.id]);
      expect(response.body.failed).toHaveLength(1);
      expect(response.body.failed[0].id).toBe(two.id);
      expect(await createWorkBoardStore({ dataDir }).list('/repo'))
        .toEqual([expect.objectContaining({ id: one.id, stage: 'done' }), expect.objectContaining({ id: two.id, stage: 'todo' })]);
      await request(app).post('/api/work-board/placement').send({ directory: '/repo', lane: 'done', targets: [] }).expect(400);
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });

  it('serves the board projection and reports a missing projection as unavailable', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-snapshot-'));
    try {
      const store = createWorkBoardStore({ dataDir });
      const app = express();
      // No projection wired: the route is a stable 503, not an empty board.
      registerWorkBoardRoutes(app, { store, resolveProjectDirectory: async req => ({ directory: req.query.directory }) });
      await request(app).get('/api/work-board/snapshot').query({ directory: '/repo' }).expect(503);
      await request(app).get('/api/work-board/snapshot').query({}).expect(400);
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });

  it('returns the projection with the session window passed through to the session reader', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-snapshot-live-'));
    try {
      const store = createWorkBoardStore({ dataDir });
      await store.create({ directory: '/repo', text: 'Brief' });
      const app = express();
      const calls = [];
      const projection = {
        snapshot: async (directory, options) => { calls.push({ directory, options }); return { directory, cards: [], queue: { known: true } }; },
      };
      registerWorkBoardRoutes(app, { store, resolveProjectDirectory: async req => ({ directory: req.query.directory }), workBoardProjection: projection });
      const plain = await request(app).get('/api/work-board/snapshot').query({ directory: '/repo' }).expect(200);
      expect(plain.body.directory).toBe('/repo');
      const all = await request(app).get('/api/work-board/snapshot').query({ directory: '/repo', days: '0' }).expect(200);
      expect(all.body.directory).toBe('/repo');
      const week = await request(app).get('/api/work-board/snapshot').query({ directory: '/repo', days: '7' }).expect(200);
      expect(week.body.directory).toBe('/repo');
      expect(calls).toEqual([
        // No window named: the server's own default stands (the projection applies it).
        { directory: '/repo', options: {} },
        { directory: '/repo', options: { windowDays: 0 } },
        { directory: '/repo', options: { windowDays: 7 } },
      ]);
      // A window outside the sensible range is a bad request, not a silent clamp.
      await request(app).get('/api/work-board/snapshot').query({ directory: '/repo', days: '-1' }).expect(400);
      // The plain card list stays available for other consumers.
      await request(app).get('/api/work-board').query({ directory: '/repo' }).expect(200);
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });
});
