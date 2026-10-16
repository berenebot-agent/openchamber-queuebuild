import { describe, expect, test } from 'bun:test';

import { parseRoute } from './parseRoute';

describe('parseRoute session', () => {
  test('reads a session id including OpenCode underscores', () => {
    const route = parseRoute(new URLSearchParams('session=ses_abc123'));
    expect(route.sessionId).toBe('ses_abc123');
  });

  test('decodes a percent-encoded session id', () => {
    const route = parseRoute(new URLSearchParams('session=ses%5Fabc123'));
    expect(route.sessionId).toBe('ses_abc123');
  });

  test('ignores a blank session param', () => {
    const route = parseRoute(new URLSearchParams('session='));
    expect(route.sessionId).toBeNull();
  });
});

describe('parseRoute message', () => {
  test('reads a linked message next to its session', () => {
    const route = parseRoute(new URLSearchParams('session=ses_abc&message=msg_123'));
    expect(route.messageId).toBe('msg_123');
  });

  test('ignores a message without a session', () => {
    expect(parseRoute(new URLSearchParams('message=msg_123')).messageId).toBeNull();
  });

  test('rejects a message id outside the identifier alphabet', () => {
    expect(parseRoute(new URLSearchParams('session=ses_abc&message=msg"]')).messageId).toBeNull();
  });
});

describe('parseRoute board', () => {
  test('reads the board project', () => {
    expect(parseRoute(new URLSearchParams('board=proj_1')).boardProjectId).toBe('proj_1');
  });

  test('an empty board param still names the board page', () => {
    expect(parseRoute(new URLSearchParams('board=')).boardProjectId).toBe('');
  });

  test('a missing board param means no board is open', () => {
    expect(parseRoute(new URLSearchParams('session=ses_abc')).boardProjectId).toBeNull();
  });

  test('reads a board next to a session so a reload can prefer the board', () => {
    const route = parseRoute(new URLSearchParams('session=ses_abc&board=proj_1'));
    expect(route.boardProjectId).toBe('proj_1');
    expect(route.sessionId).toBe('ses_abc');
  });
});
