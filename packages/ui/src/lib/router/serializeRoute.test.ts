import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { updateBrowserURL } from './serializeRoute';
import type { AppRouteState } from './serializeRoute';

const originalWindow = globalThis.window;

type HistoryStub = {
  state: unknown;
  lastURL: string | null;
  replaceState(state: unknown, _title: string, url?: string): void;
  pushState(state: unknown, _title: string, url?: string): void;
};

const installWindow = (href: string): HistoryStub => {
  const url = new URL(href);
  const history: HistoryStub = {
    state: null,
    lastURL: null,
    replaceState(state, _title, url) {
      this.state = state;
      this.lastURL = url ?? null;
    },
    pushState(state, _title, url) {
      this.state = state;
      this.lastURL = url ?? null;
    },
  };
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      location: {
        href: url.toString(),
        origin: url.origin,
        pathname: url.pathname,
        search: url.search,
      },
      history,
    },
  });
  return history;
};

const historyOf = (): HistoryStub =>
  (globalThis.window as unknown as { history: HistoryStub }).history;

beforeEach(() => {
  installWindow('http://127.0.0.1:5173/app');
});

afterEach(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

afterAll(() => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: originalWindow,
  });
});

const sessionState = (sessionId: string): AppRouteState => ({
  sessionId,
  isSettingsOpen: false,
  settingsPath: '',
  boardProjectId: null,
});

describe('updateBrowserURL', () => {
  test('rewrites the URL with the selected session', () => {
    installWindow('http://127.0.0.1:5173/app');

    updateBrowserURL(sessionState('ses_main'), { replace: true, force: true });

    const writtenURL = historyOf().lastURL ?? '';
    expect(writtenURL).toContain('session=ses_main');
  });

  test('writes the open board as its own page and drops the session', () => {
    installWindow('http://127.0.0.1:5173/app');

    updateBrowserURL({ ...sessionState('ses_main'), boardProjectId: 'proj_1' }, { replace: true, force: true });

    const writtenURL = historyOf().lastURL ?? '';
    expect(writtenURL).toContain('board=proj_1');
    // The board covers the chat, so a reload must not resurrect the session.
    expect(writtenURL).not.toContain('session=');
  });

  test('keeps the remembered board open with an empty project id', () => {
    installWindow('http://127.0.0.1:5173/app');

    updateBrowserURL({ ...sessionState('ses_main'), boardProjectId: '' }, { replace: true, force: true });

    const writtenURL = historyOf().lastURL ?? '';
    expect(writtenURL).toMatch(/(?:^|[?&])board=(?:&|$)/);
    expect(writtenURL).not.toContain('session=');
  });

  test('settings stays in front of the board', () => {
    installWindow('http://127.0.0.1:5173/app');

    updateBrowserURL(
      { ...sessionState('ses_main'), isSettingsOpen: true, settingsPath: 'providers', boardProjectId: 'proj_1' },
      { replace: true, force: true },
    );

    const writtenURL = historyOf().lastURL ?? '';
    expect(writtenURL).toContain('settings=providers');
    expect(writtenURL).not.toContain('board=');
  });

  test('a closed board leaves the session URL as before', () => {
    installWindow('http://127.0.0.1:5173/app');

    updateBrowserURL(sessionState('ses_main'), { replace: true, force: true });

    const writtenURL = historyOf().lastURL ?? '';
    expect(writtenURL).not.toContain('board=');
  });
});
