import { expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { workBoardSessions } from './workBoardSessions';

const now = Date.UTC(2026, 9, 16);
const cutoff = now - 30 * 24 * 60 * 60 * 1000;
const session = (id: string, updated: number, parentID?: string): Session => ({
  id, parentID, directory: '/repo', projectID: 'project', title: id,
  cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 1, updated },
});

test('the 30-day window includes its boundary and active roots, without inheriting children or other projects', () => {
  const sessions = [session('recent', now), session('boundary', cutoff), session('old', cutoff - 1),
    session('running', 1), session('queued', 1), session('parent', 1), session('child', now, 'parent'),
    { ...session('elsewhere', now), directory: '/other' }];
  const active = new Set(['running', 'queued', 'child']);
  expect(workBoardSessions(sessions, '/repo', false, active, now).map(item => item.id))
    .toEqual(['recent', 'boundary', 'running', 'queued', 'parent']);
  expect(workBoardSessions(sessions, '/repo', true, active, now).map(item => item.id))
    .toEqual(['recent', 'boundary', 'old', 'running', 'queued', 'parent']);
});

test('a large historical board only admits recent or active sessions to history loading', () => {
  const sessions = Array.from({ length: 1000 }, (_, index) => session(`old-${index}`, 1));
  sessions.push(session('recent', now));
  expect(workBoardSessions(sessions, '/repo', false, new Set(), now)).toHaveLength(1);
  expect(workBoardSessions(sessions, '/repo', true, new Set(), now)).toHaveLength(1001);
});
