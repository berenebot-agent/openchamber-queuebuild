import { expect, test } from 'bun:test';
import { readWorkBoardMemory, rememberWorkBoard } from './workBoardMemory';

test('board memory isolates owners, replaces empty boards and bounds retained payloads', () => {
  const snapshot = { cards: [], activities: new Map() };
  rememberWorkBoard('runtime-a', '/project-a', snapshot);
  expect(readWorkBoardMemory('runtime-a', '/project-a')).toBe(snapshot);
  expect(readWorkBoardMemory('runtime-b', '/project-a')).toBeUndefined();
  expect(readWorkBoardMemory('runtime-a', '/project-b')).toBeUndefined();

  const replacement = { cards: [], activities: new Map() };
  rememberWorkBoard('runtime-a', '/project-a', replacement);
  expect(readWorkBoardMemory('runtime-a', '/project-a')).toBe(replacement);

  for (let index = 0; index < 9; index += 1) rememberWorkBoard('bounded', `/project-${index}`, snapshot);
  expect(readWorkBoardMemory('bounded', '/project-0')).toBeUndefined();
  expect(readWorkBoardMemory('bounded', '/project-8')).toBe(snapshot);

  rememberWorkBoard('bounded', '/large', {
    cards: [{ id: 'large', directory: '/large', text: 'x'.repeat(3 * 1024 * 1024), attachments: [], stage: 'todo', createdAt: 1, updatedAt: 1 }],
    activities: new Map(),
  });
  expect(readWorkBoardMemory('bounded', '/large')).toBeUndefined();
});
