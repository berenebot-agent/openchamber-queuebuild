import { describe, expect, test } from 'bun:test';
import { captureWorkBoardAttachments, startWorkBoardPlan, workBoardLane } from './workBoardWorkflow';
import type { WorkBoardCard } from '@/lib/workBoardApi';
import type { Message } from '@/lib/opencode/model';

const card: WorkBoardCard = { id: 'card1', directory: '/repo', text: 'Build a board', attachments: [], createdAt: 1, updatedAt: 1, stage: 'todo' };
const selection = { providerID: 'provider', modelID: 'model' };
const user = (at: number): Message => ({ id: `user${at}`, sessionID: 'session1', role: 'user', time: { created: at } });
const assistant = (agent: string, at: number): Message => ({ id: `assistant${at}`, sessionID: 'session1', role: 'assistant', agent, providerID: 'provider', modelID: 'model', time: { created: at, completed: at + 1 } });
const idle: Message = { id: 'idle', sessionID: 'session1', role: 'idle', outcome: 'succeeded', time: { created: 5 } };

describe('work board lanes', () => {
  test('new cards stay To-do and queue leases take precedence', () => {
    expect(workBoardLane(card, undefined, undefined)).toBe('todo');
    expect(workBoardLane(card, undefined, 'queued')).toBe('queued');
    expect(workBoardLane(card, undefined, 'building')).toBe('building');
  });
  test('only a settled successful Build turn is Done', () => {
    const linked = { ...card, stage: 'plan' as const, sessionId: 'session1' };
    const messages = [user(2), assistant('build', 3), idle];
    expect(workBoardLane(linked, { messages, busy: false }, undefined)).toBe('done');
    expect(workBoardLane(linked, { messages, busy: true }, undefined)).toBe('building');
    expect(workBoardLane(linked, { messages: messages.slice(0, -1), busy: false }, undefined)).toBe('building');
    expect(workBoardLane(linked, { messages: [user(2), assistant('plan', 3), idle], busy: false }, undefined)).toBe('plan');
  });
  test('parking preserves old history; a new send reopens the card', () => {
    const parked = { ...card, sessionId: 'session1', updatedAt: 6 };
    expect(workBoardLane(parked, { messages: [user(2), assistant('build', 3), idle], busy: false }, undefined)).toBe('todo');
    expect(workBoardLane(parked, { messages: [user(2), assistant('plan', 3)], busy: true }, undefined)).toBe('plan');
    expect(workBoardLane(parked, { messages: [user(2), assistant('build', 3), idle, user(7), assistant('plan', 8)], busy: true }, undefined)).toBe('plan');
    expect(workBoardLane(parked, { messages: [user(2), assistant('build', 3), idle, user(7)], busy: false }, undefined)).toBe('plan');
  });
});

describe('Plan promotion', () => {
  test('links the session durably before sending and changes stage only after acceptance', async () => {
    const events: string[] = [];
    const id = await startWorkBoardPlan(card, selection, {
      create: async () => { events.push('create'); return { id: 'session1' }; },
      link: async () => { events.push('link'); },
      send: async (_id, directory, text, attachments) => { expect(directory).toBe('/repo'); expect(text).toBe(card.text); expect(attachments).toEqual([]); events.push('send'); },
      accept: async () => { events.push('accept'); },
    });
    expect(id).toBe('session1');
    expect(events).toEqual(['create', 'link', 'send', 'accept']);
  });
  test('failed linking never sends; failed sending retains a link and does not promote', async () => {
    for (const fail of ['link', 'send']) {
      const events: string[] = [];
      await expect(startWorkBoardPlan(card, selection, {
        create: async () => ({ id: 'session1' }),
        link: async () => { events.push('link'); if (fail === 'link') throw new Error('disk failure'); },
        send: async () => { events.push('send'); throw new Error('lost response'); },
        accept: async () => { events.push('accept'); },
      })).rejects.toThrow();
      expect(events).toEqual(fail === 'link' ? ['link'] : ['link', 'send']);
    }
  });
  test('an existing session link prevents duplicate creation and submission', async () => {
    const never = async (): Promise<never> => { throw new Error('must not run'); };
    expect(await startWorkBoardPlan({ ...card, sessionId: 'session1' }, selection, { create: never, link: never, send: never, accept: never })).toBe('session1');
  });
  test('captures text-file payloads without mutable browser file objects', () => {
    const file = { id: 'file1', filename: 'notes.txt', mimeType: 'text/plain', size: 2, dataUrl: 'data:text/plain;base64,aGk=' };
    const captured = captureWorkBoardAttachments([file]);
    file.filename = 'changed.txt';
    expect(captured[0].filename).toBe('notes.txt');
  });
});
