import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerWorkBoardRoutes } from './routes.js';
import { createWorkBoardStore } from './store.js';

describe('work board HTTP routes', () => {
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

  it('guards every linked completion and reports partial bulk results without touching another project', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-complete-'));
    try {
      const store = createWorkBoardStore({ dataDir });
      const todo = await store.create({ directory: '/repo', text: 'To-do' });
      const other = await store.create({ directory: '/other', text: 'Other project' });
      const checked = [];
      const app = express();
      registerWorkBoardRoutes(app, { store, resolveProjectDirectory: async req => ({ directory: req.query.directory }), messageQueueRuntime: {
        parkSession: async (id, directory, save) => {
          checked.push([id, directory]);
          if (id === 'busy' || id === 'unknown') throw Object.assign(new Error('Session is not known idle'), { status: 409 });
          return save([]);
        },
      } });
      const targets = ['idle', 'busy', 'unknown'].map(sessionId => ({ id: `session:${sessionId}`, sessionId, text: sessionId, updatedAt: 1, sessionDirectory: '/repo/worktree' }));
      const response = await request(app).post('/api/work-board/complete').send({ directory: '/repo', targets: [todo, ...targets, other] }).expect(200);
      expect(response.body.completed).toEqual([todo.id, 'session:idle']);
      expect(response.body.failed.map(entry => entry.id)).toEqual(['session:busy', 'session:unknown', other.id]);
      expect(checked).toEqual([['idle', '/repo/worktree'], ['busy', '/repo/worktree'], ['unknown', '/repo/worktree']]);
      expect(await store.list('/other')).toEqual([other]);
      expect((await store.list('/repo')).map(card => card.stage)).toEqual(['done', 'done']);
    } finally { await fs.rm(dataDir, { recursive: true, force: true }); }
  });

  it('refuses linked completion without idle checks and rejects invalid bulk requests', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-complete-unavailable-'));
    try {
      const store = createWorkBoardStore({ dataDir });
      const app = express();
      registerWorkBoardRoutes(app, { store, resolveProjectDirectory: async req => ({ directory: req.query.directory }) });
      const target = { id: 'session:session1', sessionId: 'session1', text: 'Plan', updatedAt: 1 };
      const response = await request(app).post('/api/work-board/complete').send({ directory: '/repo', targets: [target] }).expect(200);
      expect(response.body.completed).toEqual([]);
      expect(response.body.failed).toHaveLength(1);
      expect(await store.list()).toEqual([]);
      await request(app).post('/api/work-board/complete').send({ directory: '/repo', targets: [] }).expect(400);
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

});
