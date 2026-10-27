import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mock } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

// MainLayout pulls the whole app shell: the chat's markdown worker, the session
// list, dialogs. This test only asks where the way back to the board sits, so
// those subtrees are stubbed and the real layout, header and stores stay.
mock.module('@/components/chat/markdown/markdown-shiki.worker.ts?worker&url', () => ({ default: 'blob:test-shiki-worker' }));
mock.module('@pierre/diffs/worker/worker.js?worker&url', () => ({ default: 'blob:test-diff-worker' }));
mock.module('@/contexts/DiffWorkerProvider', () => ({ DiffWorkerProvider: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
for (const [name, exportName] of [
  ['@/components/views/ChatView', 'ChatView'],
  ['@/components/session/SessionSidebar', 'SessionSidebar'],
  ['@/components/session/SessionDialogs', 'SessionDialogs'],
  ['@/components/layout/ContextPanel', 'ContextPanel'],
  ['@/components/layout/ContextSurfacePanes', 'ContextSurfacePanes'],
  ['@/components/layout/ContextPanelRail', 'ContextPanelRail'],
  ['@/components/layout/Sidebar', 'Sidebar'],
  ['@/components/layout/ZoneFitArbiter', 'ZoneFitArbiter'],
  ['@/components/layout/ZoneDropOverlay', 'ZoneDropOverlay'],
  ['@/components/layout/GuestHosts', 'GuestHosts'],
  ['@/components/layout/ProjectActionsProvider', 'ProjectActionsProvider'],
] as const) {
  mock.module(name, () => ({ [exportName]: ({ children }: { children?: React.ReactNode }) => <>{children}</> }));
}
mock.module('@/components/layout/Header', () => ({ Header: () => null }));
mock.module('@/lib/multirun/autoFusion', () => ({ RunAutoFusion: () => null }));
mock.module('@/components/session/spaces/SpaceActions', () => ({ SpaceActionsSheet: () => null, SpaceDeleteDialog: () => null }));
mock.module('@/components/layout/useSidebarPeek', () => ({ useSidebarPeek: () => ({ state: false }) }));
mock.module('@/hooks/useGuestSurfaces', () => ({ useGuestPages: () => [], useGuestActions: () => [] }));
mock.module('@/components/layout/zoneSync', () => ({ followZonePlacementOfOtherWindows: () => () => {} }));
mock.module('@/hooks/useUpdatePolling', () => ({ useUpdatePolling: () => {} }));
mock.module('@/hooks/useTerminalSessionKeepalive', () => ({ useTerminalSessionKeepalive: () => {} }));
mock.module('@/components/session/sidebar/list/useSessionListSync', () => ({ useSessionListSync: () => {} }));

const { MainLayout } = await import('./MainLayout');
const { I18nProvider } = await import('@/lib/i18n');
const { TooltipProvider } = await import('@/components/ui/tooltip');
const { useUIStore } = await import('@/stores/useUIStore');
const { useProjectsStore } = await import('@/stores/useProjectsStore');

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser,
  document: browser.document,
  navigator: browser.navigator,
  localStorage: browser.localStorage,
  sessionStorage: browser.sessionStorage,
  Node: browser.Node,
  Element: browser.Element,
  HTMLElement: browser.HTMLElement,
  Event: browser.Event,
  MouseEvent: browser.MouseEvent,
  KeyboardEvent: browser.KeyboardEvent,
  MutationObserver: browser.MutationObserver,
  ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  customElements: browser.customElements,
  IS_REACT_ACT_ENVIRONMENT: true,
});

let root: Root;
let host: HTMLElement;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useProjectsStore.setState({
    projects: [{ id: 'proj_a', path: '/work/a', label: 'Alpha' }],
    activeProjectId: 'proj_a',
    hasServerSnapshot: true,
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const renderLayout = async () => {
  await act(async () => root.render(<I18nProvider><TooltipProvider><MainLayout /></TooltipProvider></I18nProvider>));
};

const chip = () => host.querySelector<HTMLButtonElement>('[data-work-board-return]');

describe('the way back to the board', () => {
  test('sits on the chat once a board has been visited, and opens that board', async () => {
    useUIStore.setState({ workBoardProjectId: 'proj_a', isWorkBoardOpen: false });
    await renderLayout();

    expect(chip()).not.toBeNull();
    await act(async () => chip()!.click());
    expect(useUIStore.getState().isWorkBoardOpen).toBe(true);
  });

  test('is not on the board itself, and not before any board was visited', async () => {
    useUIStore.setState({ workBoardProjectId: 'proj_a', isWorkBoardOpen: true });
    await renderLayout();
    expect(chip()).toBeNull();

    useUIStore.getState().setWorkBoardProjectId(null);
    useUIStore.getState().setWorkBoardOpen(false);
    await act(async () => {});
    expect(chip()).toBeNull();
  });
});
