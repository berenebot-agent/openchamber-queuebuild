import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useRouter } from './useRouter';

const RouterHarness = () => {
  useRouter();
  return null;
};

describe('useRouter board page', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let written: string[];
  const originalWindow = globalThis.window;

  beforeEach(() => {
    windowInstance = new Window({ url: 'http://localhost/' });
    written = [];
    const history = windowInstance.history;
    const record = (url: string | URL | null | undefined) => {
      if (url) written.push(String(url));
    };
    const replaceState = history.replaceState.bind(history);
    const pushState = history.pushState.bind(history);
    history.replaceState = (state, title, url) => {
      record(url);
      replaceState(state, title, url);
    };
    history.pushState = (state, title, url) => {
      record(url);
      pushState(state, title, url);
    };
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      Event: windowInstance.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    });

    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    useUIStore.setState({
      isWorkBoardOpen: false,
      isSettingsDialogOpen: false,
      workBoardProjectId: 'proj_remembered',
    });
    useSessionUIStore.setState({ currentSessionId: null, currentSessionDirectory: null });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
  });

  const renderWithURL = async (url: string) => {
    await act(async () => {
      windowInstance.history.replaceState({}, '', url);
      root.render(React.createElement(RouterHarness));
    });
  };

  test('a board URL opens the board on the project it names', async () => {
    await renderWithURL('/?board=proj_from_url');

    expect(useUIStore.getState().isWorkBoardOpen).toBe(true);
    expect(useUIStore.getState().workBoardProjectId).toBe('proj_from_url');
  });

  test('a board URL without a project opens the board on the remembered project', async () => {
    await renderWithURL('/?board=');

    expect(useUIStore.getState().isWorkBoardOpen).toBe(true);
    expect(useUIStore.getState().workBoardProjectId).toBe('proj_remembered');
  });

  test('a plain URL leaves the board closed', async () => {
    await renderWithURL('/?session=ses_abc');

    expect(useUIStore.getState().isWorkBoardOpen).toBe(false);
  });

  test('opening the board writes its own URL and drops the session', async () => {
    await renderWithURL('/?session=ses_abc');
    useSessionUIStore.setState({ currentSessionId: 'ses_abc', currentSessionDirectory: '/repo' });
    written.length = 0;

    await act(async () => {
      useUIStore.setState({ isWorkBoardOpen: true, workBoardProjectId: 'proj_1' });
    });

    const boardURL = written.at(-1) ?? '';
    expect(boardURL).toContain('board=proj_1');
    expect(boardURL).not.toContain('session=');
  });

  test('switching the active board tab rewrites the URL while the board is open', async () => {
    await renderWithURL('/?board=proj_1');
    written.length = 0;

    await act(async () => {
      useUIStore.setState({ workBoardProjectId: 'proj_2' });
    });

    expect(written.at(-1) ?? '').toContain('board=proj_2');
  });

  test('a project change while the board is closed does not rewrite the URL', async () => {
    await renderWithURL('/?session=ses_abc');
    useSessionUIStore.setState({ currentSessionId: 'ses_abc', currentSessionDirectory: '/repo' });
    written.length = 0;

    await act(async () => {
      useUIStore.setState({ workBoardProjectId: 'proj_other' });
    });

    expect(written).toEqual([]);
  });

  test('a board open with no project still writes a board URL', async () => {
    await renderWithURL('/?session=ses_abc');
    useSessionUIStore.setState({ currentSessionId: 'ses_abc', currentSessionDirectory: '/repo' });
    written.length = 0;

    await act(async () => {
      useUIStore.setState({ isWorkBoardOpen: true, workBoardProjectId: null });
    });

    const boardURL = written.at(-1) ?? '';
    // No project to name, but the board is still the page: the param must be
    // present and empty so a reload returns to the board, not to the chat.
    expect(boardURL).toMatch(/(?:^|[?&])board=(?:&|$)/);
    expect(boardURL).not.toContain('session=');
  });

  test('browser back to a board-less URL closes the board', async () => {
    await renderWithURL('/?board=proj_1');
    expect(useUIStore.getState().isWorkBoardOpen).toBe(true);

    await act(async () => {
      windowInstance.history.replaceState({}, '', '/');
      windowInstance.dispatchEvent(new windowInstance.Event('popstate'));
    });

    expect(useUIStore.getState().isWorkBoardOpen).toBe(false);
  });
});
