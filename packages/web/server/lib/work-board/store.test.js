import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createWorkBoardStore } from './store.js';

const setup = async () => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'work-board-'));
  let sequence = 0;
  const store = createWorkBoardStore({ dataDir, id: () => `card-${++sequence}`, now: () => sequence });
  return { dataDir, store };
};
const remove = (dataDir) => fs.rm(dataDir, { recursive: true, force: true });
const input = (directory = '/project') => ({ directory, text: 'Plan this' });

describe('work board persistence', () => {
  it('persists cards across store instances and lists without deleting other directories', async () => {
    const { dataDir, store } = await setup();
    try {
      const card = await store.create(input());
      await store.create({ ...input('/other'), text: 'Other' });
      expect((await createWorkBoardStore({ dataDir }).list('/project'))).toEqual([card]);
      expect(await store.list()).toHaveLength(2);
    } finally { await remove(dataDir); }
  });

  it('validates text and attachment data and retains a card on invalid updates', async () => {
    const { dataDir, store } = await setup();
    try {
      await expect(store.create({ directory: '/project', text: ' ', attachments: [] })).rejects.toMatchObject({ status: 400 });
      const card = await store.create({ directory: '/project', text: '', attachments: [{ filename: 'a.txt', mimeType: 'text/plain', size: 2, dataUrl: 'data:text/plain;base64,aGk=' }] });
      await expect(store.update(card.id, { attachments: [{ filename: 'bad', mimeType: 'text/plain', dataUrl: 'data:text/plain;base64,!' }] })).rejects.toMatchObject({ status: 400 });
      expect(await store.list('/project')).toEqual([card]);
    } finally { await remove(dataDir); }
  });

  it('serializes concurrent writes and enforces durable session linking and promotion order', async () => {
    const { dataDir, store } = await setup();
    try {
      const cards = await Promise.all(Array.from({ length: 12 }, (_, index) => store.create({ ...input(), text: `Card ${index}` })));
      expect(await store.list()).toHaveLength(12);
      const card = cards[0];
      await expect(store.update(card.id, { stage: 'plan' })).rejects.toMatchObject({ status: 409 });
      const linked = await store.update(card.id, { sessionId: 'session_123' });
      expect((await createWorkBoardStore({ dataDir }).list()).find(({ id }) => id === card.id).sessionId).toBe('session_123');
      await expect(store.update(card.id, { sessionId: 'session_456' })).rejects.toMatchObject({ status: 409 });
      expect((await store.update(card.id, { stage: 'plan' })).sessionId).toBe(linked.sessionId);
    } finally { await remove(dataDir); }
  });

  it('keeps the previous file when an atomic write fails', async () => {
    const { dataDir, store } = await setup();
    try {
      const card = await store.create(input());
      const failingFs = { ...fs, rename: async () => { throw new Error('disk failure'); } };
      const failing = createWorkBoardStore({ dataDir, fs: failingFs });
      await expect(failing.create({ ...input(), text: 'second' })).rejects.toThrow('disk failure');
      expect(await store.list()).toEqual([card]);
    } finally { await remove(dataDir); }
  });

  it('parks a session with one atomic write and retries without duplicating notes or attachments', async () => {
    const { dataDir } = await setup();
    try {
      let writes = 0;
      const store = createWorkBoardStore({ dataDir, fs: { ...fs, rename: async (...args) => {
        writes += 1;
        return fs.rename(...args);
      } } });
      const request = { ...input(), sessionId: 'session1', attachments: [
        { id: 'attachment1', filename: 'a.txt', mimeType: 'text/plain', size: 2, dataUrl: 'data:text/plain;base64,aGk=' },
      ] };
      const first = await store.parkSession(request);
      expect(writes).toBe(1);
      expect(first).toMatchObject({ sessionId: 'session1', stage: 'todo' });
      const note = { ...request, text: 'Extra note' };
      await store.parkSession(note);
      const retried = await store.parkSession(note);
      expect(retried.id).toBe(first.id);
      expect(retried.text).toBe('Plan this\n\nExtra note');
      expect(retried.attachments).toHaveLength(1);
      expect(await store.list()).toHaveLength(1);
    } finally { await remove(dataDir); }
  });

  it('leaves no orphan card on a failed park and preserves existing cards on a failed update', async () => {
    const { dataDir, store } = await setup();
    try {
      const original = await store.create(input('/other'));
      const failing = createWorkBoardStore({ dataDir, fs: { ...fs, rename: async () => { throw new Error('disk failure'); } } });
      const request = { ...input(), sessionId: 'session1' };
      await expect(failing.parkSession(request)).rejects.toThrow('disk failure');
      expect(await store.list()).toEqual([original]);
      const saved = await store.parkSession(request);
      await expect(failing.parkSession({ ...request, text: 'Extra note' })).rejects.toThrow('disk failure');
      expect(await store.list()).toEqual([original, saved]);
      await Promise.all([store.parkSession(request), store.parkSession(request)]);
      expect(await store.list()).toHaveLength(2);
    } finally { await remove(dataDir); }
  });
});
