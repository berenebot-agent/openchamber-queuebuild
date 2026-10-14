import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { registerWorkBoardRoutes } from './routes.js';
import { createWorkBoardStore } from './store.js';

describe('work board HTTP routes', () => {
  it('parses writes without a global JSON parser and preserves linked card contents', async () => {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-http-'));
    try {
      const app = express();
      registerWorkBoardRoutes(app, { store: createWorkBoardStore({ dataDir }), resolveProjectDirectory: async directory => directory });
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
});
