import { describe, expect, test } from 'bun:test';
import { queueRepositoryNote, queueRepositoryOptions } from './buildQueueRepositoryModel';

describe('build queue repository picker', () => {
  test('offers the project folder only when it is itself a checkout', () => {
    expect(queueRepositoryOptions('/repo', true, ['/repo/packages/app']))
      .toEqual(['/repo', '/repo/packages/app']);
    expect(queueRepositoryOptions('/repo', false, ['/repo/packages/app']))
      .toEqual(['/repo/packages/app']);
    // The folder is never listed twice, however it was spelled.
    expect(queueRepositoryOptions('/repo', true, ['/repo/', '/repo/app']))
      .toEqual(['/repo', '/repo/app']);
  });

  test('reports nothing to fix once a scan found repositories', () => {
    expect(queueRepositoryNote(null, ['/repo/app'], [])).toBeNull();
    expect(queueRepositoryNote('/repo/app', ['/repo/app'], [])).toBeNull();
  });

  test('separates a failed scan from an empty one, and never guesses', () => {
    // Not run yet, mid-scan, and a runtime without discovery.
    expect(queueRepositoryNote(null, [], undefined)).toBe('scanning');
    expect(queueRepositoryNote(null, [], 'unsupported')).toBe('scanFailed');
    // A failed scan must not read as "nothing there".
    expect(queueRepositoryNote(null, [], null)).toBe('scanFailed');
    expect(queueRepositoryNote(null, [], [])).toBe('none');
  });

  test('a stored repository discovery cannot find is the state to fix', () => {
    expect(queueRepositoryNote('/repo/gone', ['/repo/app'], [])).toBe('missing');
    // It outranks an empty scan: the user has a choice to correct.
    expect(queueRepositoryNote('/repo/gone', [], [])).toBe('missing');
    // A stale scan does not turn a missing choice into a clean one.
    expect(queueRepositoryNote('/repo/gone', [], 'unsupported')).toBe('missing');
    // A path spelled with the other separator still matches.
    expect(queueRepositoryNote('/repo/app', ['/repo/app/'], [])).toBeNull();
  });
});
