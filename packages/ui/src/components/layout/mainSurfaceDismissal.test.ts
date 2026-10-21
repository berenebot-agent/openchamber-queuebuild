import { describe, expect, test } from 'bun:test';
import { surfaceShouldDismiss } from './mainSurfaceDismissal';

const noDraft = { open: false } as const;

describe('full-page surface dismissal', () => {
  test('picking a session closes the surface over the chat', () => {
    expect(surfaceShouldDismiss(
      { currentSessionId: 'ses_a', newSessionDraft: noDraft },
      { currentSessionId: 'ses_b', newSessionDraft: noDraft },
    )).toBe(true);
  });

  test('a user-opened draft closes the surface over the chat', () => {
    expect(surfaceShouldDismiss(
      { currentSessionId: null, newSessionDraft: { open: true } },
      { currentSessionId: null, newSessionDraft: noDraft },
    )).toBe(true);
  });

  test('re-opening a draft while one is already open closes the surface', () => {
    expect(surfaceShouldDismiss(
      { currentSessionId: null, newSessionDraft: { open: true, automatic: undefined } },
      { currentSessionId: null, newSessionDraft: { open: true, automatic: true } },
    )).toBe(true);
  });

  test('the chat opening a draft by itself leaves the surface alone', () => {
    expect(surfaceShouldDismiss(
      { currentSessionId: null, newSessionDraft: { open: true, automatic: true } },
      { currentSessionId: 'ses_a', newSessionDraft: noDraft },
    )).toBe(false);
  });

  test('closing a draft leaves the surface alone', () => {
    expect(surfaceShouldDismiss(
      { currentSessionId: null, newSessionDraft: noDraft },
      { currentSessionId: null, newSessionDraft: { open: true, automatic: true } },
    )).toBe(false);
  });

  test('a session that stops being selected leaves the surface alone', () => {
    expect(surfaceShouldDismiss(
      { currentSessionId: null, newSessionDraft: noDraft },
      { currentSessionId: 'ses_a', newSessionDraft: noDraft },
    )).toBe(false);
  });

  test('the same session selected again leaves the surface alone', () => {
    expect(surfaceShouldDismiss(
      { currentSessionId: 'ses_a', newSessionDraft: noDraft },
      { currentSessionId: 'ses_a', newSessionDraft: noDraft },
    )).toBe(false);
  });
});
