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
  for (const stage of ['todo', 'plan', 'done']) {
    it(`removes a saved brief while preserving the ${stage} session placement and completion`, async () => {
      const { dataDir, store } = await setup();
      try {
        const saved = await store.parkSession({ ...input(), sessionId: 'session1', attachments: [
          { id: 'file1', filename: 'a.txt', mimeType: 'text/plain', size: 2, dataUrl: 'data:text/plain;base64,aGk=' },
        ] });
        const card = stage === 'done' ? await store.complete(saved)
          : stage === 'plan' ? await store.update(saved.id, { stage }) : saved;
        const removed = await store.update(card.id, { removeBrief: true, expectedUpdatedAt: card.updatedAt });
        expect(removed).toEqual({ ...card, text: '', attachments: [], briefRemoved: true });
        expect(await createWorkBoardStore({ dataDir }).list()).toEqual([removed]);
        expect(await fs.readFile(path.join(dataDir, 'work-board.json'), 'utf8')).not.toContain('aGk=');
        await expect(store.update(card.id, { text: 'Stale edit', expectedUpdatedAt: card.updatedAt })).rejects.toMatchObject({ status: 409 });
        const completed = await store.complete(removed);
        expect(completed.stage).toBe('done');
        const parked = await store.parkSession({ directory: '/project', sessionId: 'session1', text: '', attachments: [] });
        expect(parked).toMatchObject({ id: card.id, stage: 'todo', text: '', briefRemoved: true });
        const replacement = await store.parkSession({ directory: '/project', sessionId: 'session1', text: 'New brief', attachments: [] });
        expect(replacement.text).toBe('New brief');
        expect(replacement.briefRemoved).toBeUndefined();
      } finally { await remove(dataDir); }
    });
  }

  it('rejects stale or unlinked removals and preserves content after a failed removal write', async () => {
    const { dataDir, store } = await setup();
    try {
      const unlinked = await store.create(input());
      await expect(store.update(unlinked.id, { removeBrief: true })).rejects.toMatchObject({ status: 400 });
      const linked = await store.update(unlinked.id, { sessionId: 'session1' });
      await expect(store.update(linked.id, { removeBrief: true, expectedUpdatedAt: unlinked.updatedAt })).rejects.toMatchObject({ status: 409 });
      await expect(store.update(linked.id, { removeBrief: true, text: 'Mixed mutation' })).rejects.toMatchObject({ status: 400 });
      const failing = createWorkBoardStore({ dataDir, fs: { ...fs, rename: async () => { throw new Error('disk failure'); } } });
      await expect(failing.update(linked.id, { removeBrief: true })).rejects.toThrow('disk failure');
      expect(await failing.list()).toEqual([linked]);
      expect(await createWorkBoardStore({ dataDir }).list()).toEqual([linked]);
    } finally { await remove(dataDir); }
  });

  it('round-trips completion for legacy To-do cards and stores an inherited session brief-less', async () => {
    const { dataDir, store } = await setup();
    try {
      const original = await store.create(input());
      const completed = await store.complete(original);
      // Bun's toMatchObject corrupts any field asserted via expect.any, and the
      // corrupted card would then fail this file's own persisted read-back.
      expect(completed).toMatchObject({ id: original.id, stage: 'done', text: original.text });
      expect(completed.completedAt).toEqual(expect.any(Number));
      // The inherited card's text is the session's title, a label, not a brief.
      const inherited = await store.complete({ id: 'session:session1', sessionId: 'session1', directory: '/project', text: 'Inherited plan', updatedAt: 123 });
      expect(inherited).toMatchObject({ stage: 'done', sessionId: 'session1', text: '', briefRemoved: true });
      expect(await createWorkBoardStore({ dataDir }).list('/project')).toEqual([completed, inherited]);
      const completedAgain = await store.complete(completed);
      expect(completedAgain.completedAt).toBeGreaterThan(completed.completedAt);
      await expect(store.complete({ id: 'session:session1', sessionId: 'session1', directory: '/project', text: 'Duplicate', updatedAt: 123 })).rejects.toMatchObject({ status: 409 });
      const parked = await store.parkSession({ directory: '/project', sessionId: 'session1', text: '', attachments: [] });
      expect(parked).toMatchObject({ id: inherited.id, stage: 'todo', text: '', briefRemoved: true });
      expect(parked.completedAt).toBeUndefined();
    } finally { await remove(dataDir); }
  });

  it('rejects stale, cross-project, deleted and relinked targets and rolls back failed completion writes', async () => {
    const { dataDir, store } = await setup();
    try {
      const card = await store.create(input());
      await expect(store.complete({ ...card, directory: '/other' })).rejects.toMatchObject({ status: 409 });
      await expect(store.complete({ ...card, updatedAt: -1 })).rejects.toMatchObject({ status: 409 });
      await expect(store.complete({ ...card, sessionId: 'session1' })).rejects.toMatchObject({ status: 409 });
      const failing = createWorkBoardStore({ dataDir, fs: { ...fs, rename: async () => { throw new Error('disk failure'); } } });
      await expect(failing.complete(card)).rejects.toThrow('disk failure');
      expect(await store.list()).toEqual([card]);
      await store.delete(card.id);
      await expect(store.complete(card)).rejects.toMatchObject({ status: 409 });
      expect(await store.list()).toEqual([]);
    } finally { await remove(dataDir); }
  });
  it('persists cards across store instances and lists without deleting other directories', async () => {
    const { dataDir, store } = await setup();
    try {
      const card = await store.create(input());
      await store.create({ ...input('/other'), text: 'Other' });
      expect((await createWorkBoardStore({ dataDir }).list('/project'))).toEqual([card]);
      expect(await store.list()).toHaveLength(2);
    } finally { await remove(dataDir); }
  });

  it('prunes only the proven-gone sessions of the directory that proved them', async () => {
    const { dataDir, store } = await setup();
    try {
      const live = await store.parkSession({ ...input(), sessionId: 'session-live' });
      await store.parkSession({ ...input(), sessionId: 'session-gone' });
      const goneElsewhere = await store.parkSession({ ...input('/other'), sessionId: 'session-gone' });
      const unlinked = await store.create({ ...input(), text: 'Still a brief' });
      // An empty set is a no-op, not a wipe, and an id no card carries removes nothing.
      expect(await store.pruneMissing('/project', [])).toEqual([]);
      expect(await store.pruneMissing('/project', ['session-unheard-of'])).toEqual([]);
      expect(await store.list()).toHaveLength(4);
      expect(await store.pruneMissing('/project', ['session-gone'])).toEqual(['session-gone']);
      // Only this directory's card with that session, and nothing unlinked: the
      // live card, another directory's link, and a brief with no session stand.
      expect(await createWorkBoardStore({ dataDir }).list()).toEqual([live, goneElsewhere, unlinked]);
      // The prune is durable, so repeating it finds nothing left to remove.
      expect(await store.pruneMissing('/project', ['session-gone'])).toEqual([]);
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

  it('rejects stale edits and accepts an explicit overwrite against the latest version', async () => {
    const { dataDir } = await setup();
    try {
      const store = createWorkBoardStore({ dataDir, now: () => 10 });
      const original = await store.create(input());
      const savedElsewhere = await store.update(original.id, {
        text: 'Saved in another window', expectedUpdatedAt: original.updatedAt,
      });
      expect(savedElsewhere.updatedAt).toBeGreaterThan(original.updatedAt);
      await expect(store.update(original.id, {
        text: 'My unsaved version', expectedUpdatedAt: original.updatedAt,
      })).rejects.toMatchObject({ status: 409 });

      const overwritten = await store.update(original.id, {
        text: 'My unsaved version', expectedUpdatedAt: savedElsewhere.updatedAt,
      });
      expect(overwritten.text).toBe('My unsaved version');
      expect(overwritten.updatedAt).toBeGreaterThan(savedElsewhere.updatedAt);
    } finally { await remove(dataDir); }
  });

  it('places with the server clock and refuses a placement of a version another client changed', async () => {
    const { dataDir } = await setup();
    try {
      let clock = 1000;
      const store = createWorkBoardStore({ dataDir, now: () => clock });
      const card = await store.create(input());
      // The stamp comes from the store, never from the request: a device with a
      // wrong clock cannot pin a card against later activity.
      const placed = await store.placement(card.id, { lane: 'done', expectedUpdatedAt: card.updatedAt });
      expect(placed.placementAt).toBe(1000);
      expect(placed.completedAt).toBe(1000);

      clock = 2000;
      const changed = await store.update(card.id, { text: 'Changed elsewhere', expectedUpdatedAt: placed.updatedAt });
      await expect(store.placement(card.id, { lane: 'todo', expectedUpdatedAt: placed.updatedAt }))
        .rejects.toMatchObject({ status: 409 });
      expect((await store.list('/project'))[0]).toMatchObject({ id: card.id, stage: 'done', text: 'Changed elsewhere' });
      const retried = await store.placement(card.id, { lane: 'todo', expectedUpdatedAt: changed.updatedAt });
      expect(retried.stage).toBe('todo');
      expect(retried.placementAt).toBe(2000);
    } finally { await remove(dataDir); }
  });

  it('creates an inherited card brief-less on its first placement', async () => {
    const { dataDir, store } = await setup();
    try {
      // An inherited card's text is the session's title, a label the projection
      // adds; the placement that creates its record must not store it as a brief.
      const placed = await store.placement('session:session1', { lane: 'todo', directory: '/project', sessionId: 'session1', text: 'Session one' });
      expect(placed).toMatchObject({ directory: '/project', sessionId: 'session1', stage: 'todo', text: '', briefRemoved: true });
      // The stored card now owns that session, so the derived id is no duplicate.
      await expect(store.placement('session:session1', { lane: 'done', directory: '/project', sessionId: 'session1', text: 'Again' }))
        .rejects.toMatchObject({ status: 404 });
      expect(await store.list('/project')).toEqual([placed]);
    } finally { await remove(dataDir); }
  });

  it('refuses a stale editor overwriting a brief another client removed', async () => {
    const { dataDir } = await setup();
    try {
      const store = createWorkBoardStore({ dataDir });
      const parked = await store.parkSession({ directory: '/project', sessionId: 'session1', text: 'Original brief', attachments: [] });
      const openedAt = (await store.list('/project')).find(card => card.id === parked.id).updatedAt;
      const removed = await store.update(parked.id, { removeBrief: true, expectedUpdatedAt: openedAt });
      expect(removed.briefRemoved).toBe(true);
      await expect(store.update(parked.id, {
        text: 'Stale editor text', expectedUpdatedAt: removed.updatedAt,
      })).rejects.toMatchObject({ status: 409 });
      expect((await store.list('/project')).find(card => card.id === parked.id)).toMatchObject({ briefRemoved: true, text: '' });
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

  it('reads the file once and serves later reads from the committed list', async () => {
    const { dataDir } = await setup();
    try {
      let reads = 0;
      const store = createWorkBoardStore({ dataDir, fs: { ...fs, readFile: async (...args) => {
        reads += 1;
        return fs.readFile(...args);
      } } });
      const card = await store.create(input());
      expect(reads).toBe(1);
      expect(await store.list('/project')).toEqual([card]);
      expect(await store.list()).toEqual([card]);
      expect(reads).toBe(1);
      // A write commits a new list, and later reads see it without re-reading.
      const updated = await store.update(card.id, { text: 'Edited' });
      expect(reads).toBe(1);
      expect(await store.list('/project')).toEqual([updated]);
      expect(reads).toBe(1);
    } finally { await remove(dataDir); }
  });

  it('does not cache a failed write and keeps serving the committed board', async () => {
    const { dataDir } = await setup();
    try {
      const store = createWorkBoardStore({ dataDir });
      const card = await store.create(input());
      const failing = createWorkBoardStore({ dataDir, fs: { ...fs, rename: async () => { throw new Error('disk failure'); } } });
      await expect(failing.create({ ...input(), text: 'second' })).rejects.toThrow('disk failure');
      // The failed writer's own cache must still describe the durable file.
      expect(await failing.list()).toEqual([card]);
    } finally { await remove(dataDir); }
  });

  it('treats malformed data as a read failure and does not cache a guessed board', async () => {
    const { dataDir } = await setup();
    try {
      await fs.writeFile(path.join(dataDir, 'work-board.json'), '{ not json', 'utf8');
      const store = createWorkBoardStore({ dataDir });
      await expect(store.list()).rejects.toThrow();
      // A retry must re-read rather than serve an empty list built from the failure.
      await expect(store.list()).rejects.toThrow();
      // Repairing the file recovers, so the failure left no poisoned cache.
      await fs.writeFile(path.join(dataDir, 'work-board.json'), JSON.stringify({ version: 1, cards: [] }), 'utf8');
      const card = await store.create(input());
      expect(await store.list()).toEqual([card]);
    } finally { await remove(dataDir); }
  });

  it('acknowledges one completion at a time, durably and without disturbing the card', async () => {
    const { dataDir, store } = await setup();
    try {
      const original = await store.create(input());
      // An unknown card is a 404. A card that exists but is not completed has
      // nothing to acknowledge, so it is returned untouched rather than failing.
      await expect(store.viewed('missing')).rejects.toMatchObject({ status: 404 });
      expect(await store.viewed(original.id)).toEqual(original);
      expect((await store.list('/project'))).toEqual([original]);
      const completed = await store.complete(original);
      expect(completed.viewedAt).toBeUndefined();
      const viewed = await store.viewed(original.id);
      expect(viewed).toMatchObject({ id: original.id, stage: 'done', completedAt: completed.completedAt, viewedAt: completed.completedAt });
      // Acknowledging is not a content change, so the board's stale-completion
      // check still compares against the completion's own `updatedAt`.
      expect(viewed.updatedAt).toBe(completed.updatedAt);
      expect(viewed.text).toBe(completed.text);
      // Re-acknowledging is a no-op rather than a rewrite.
      expect(await store.viewed(original.id)).toEqual(viewed);
      expect((await createWorkBoardStore({ dataDir }).list('/project'))).toEqual([viewed]);
      // Completing again is a new completion, so the mark returns by timestamp.
      const again = await store.complete(viewed);
      expect(again.completedAt).toBeGreaterThan(viewed.completedAt);
      expect(again.viewedAt).toBeLessThan(again.completedAt);
      // Returning to To-do drops the acknowledged completion entirely.
      const parked = await store.parkSession({ directory: '/project', sessionId: 'session1', text: 'Back', attachments: [] });
      expect(parked.completedAt).toBeUndefined();
      expect(parked.viewedAt).toBeUndefined();
    } finally { await remove(dataDir); }
  });

  it('keeps the acknowledged mark when a viewed write fails', async () => {
    const { dataDir, store } = await setup();
    try {
      const completed = await store.complete(await store.create(input()));
      const failing = createWorkBoardStore({ dataDir, fs: { ...fs, rename: async () => { throw new Error('disk failure'); } } });
      await expect(failing.viewed(completed.id)).rejects.toThrow('disk failure');
      // The durable board is untouched: the card is still unacknowledged.
      expect(await store.list()).toEqual([completed]);
    } finally { await remove(dataDir); }
  });
});
