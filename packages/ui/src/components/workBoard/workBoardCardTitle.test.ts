import { describe, expect, test } from 'bun:test';
import { workBoardCardTitle } from './workBoardCardTitle';

describe('compact Work Board card titles', () => {
  test('shows only the first line, not the full brief', () => {
    expect(workBoardCardTitle('  Write the integration\nWith many implementation details', [])).toBe('Write the integration');
  });
  test('falls back to an attachment filename for attachment-only tasks', () => {
    expect(workBoardCardTitle('', [{ filename: 'specification.pdf' }])).toBe('specification.pdf');
  });
  test('handles Windows line endings and empty cards', () => {
    expect(workBoardCardTitle('Task\r\nMore', [])).toBe('Task');
    expect(workBoardCardTitle(' ', [])).toBe('Untitled');
  });
});
