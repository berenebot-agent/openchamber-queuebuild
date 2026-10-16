import { expect, test } from 'bun:test';
import { readWorkBoardMemory, rememberWorkBoard } from './workBoardMemory';

test('board memory isolates owners, replaces empty boards and bounds retained payloads', () => {
  const snapshot = { cards: [], activities: new Map(), versions: new Map(), placements: new Map() };
  rememberWorkBoard('runtime-a', '/project-a', snapshot);
  expect(readWorkBoardMemory('runtime-a', '/project-a')).toEqual(snapshot);
  expect(readWorkBoardMemory('runtime-b', '/project-a')).toBeUndefined();
  expect(readWorkBoardMemory('runtime-a', '/project-b')).toBeUndefined();

  const replacement = { cards: [], activities: new Map(), versions: new Map(), placements: new Map() };
  rememberWorkBoard('runtime-a', '/project-a', replacement);
  expect(readWorkBoardMemory('runtime-a', '/project-a')).toEqual(replacement);

  for (let index = 0; index < 9; index += 1) rememberWorkBoard('bounded', `/project-${index}`, snapshot);
  expect(readWorkBoardMemory('bounded', '/project-0')).toBeUndefined();
  expect(readWorkBoardMemory('bounded', '/project-8')).toEqual(snapshot);

  rememberWorkBoard('bounded', '/large', {
    cards: Array.from({ length: 5000 }, (_, index) => ({ id: `large-${index}`, directory: '/large', text: 'x'.repeat(512), attachments: [], stage: 'todo', createdAt: 1, updatedAt: 1 })),
    activities: new Map(), versions: new Map(), placements: new Map(),
  });
  expect(readWorkBoardMemory('bounded', '/large')).toBeUndefined();
});

test('large briefs and attachment payloads do not prevent retaining board previews', () => {
  rememberWorkBoard('preview', '/large', {
    cards: [{ id: 'large', directory: '/large', text: `Title\n${'x'.repeat(3 * 1024 * 1024)}`,
      attachments: [{ id: 'file', filename: 'notes.txt', mimeType: 'text/plain', size: 10000000, dataUrl: 'x'.repeat(10000000) }],
      stage: 'plan', sessionId: 'session', createdAt: 1, updatedAt: 1 }],
    activities: new Map([['large', { busy: false, messages: [
      { id: 'old', sessionID: 'session', role: 'user', time: { created: 1 } },
      { id: 'new', sessionID: 'session', role: 'user', time: { created: 2 } },
      { id: 'build', sessionID: 'session', role: 'assistant', agent: 'build', providerID: 'p', modelID: 'm', time: { created: 3 }, snapshot: { files: ['x'.repeat(1000000)] } },
      { id: 'idle', sessionID: 'session', role: 'idle', outcome: 'succeeded', time: { created: 4 } },
    ] }]]),
    versions: new Map([['large', 5]]),
    placements: new Map([['large', { lane: 'done', completedAt: 4, updatedAt: 1, sessionId: 'session' }]]),
  });
  const remembered = readWorkBoardMemory('preview', '/large');
  expect(remembered?.cards[0].text).toBe('Title');
  expect(remembered?.cards[0].attachments[0].filename).toBe('notes.txt');
  expect(remembered?.cards[0].attachments[0].dataUrl).toBe('');
  expect(remembered?.activities.get('large')?.messages.map(message => message.id)).toEqual(['new', 'build', 'idle']);
  expect(JSON.stringify(remembered?.activities.get('large'))).not.toContain('snapshot');
  expect(remembered?.versions.get('large')).toBe(5);
  expect(remembered?.placements.get('large')?.completedAt).toBe(4);
});
