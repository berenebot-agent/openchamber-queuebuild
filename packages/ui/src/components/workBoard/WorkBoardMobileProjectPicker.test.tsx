import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import type { ProjectEntry } from '@/lib/api/types';
import type { WorkBoardBuildBadge, WorkBoardTabAsks } from './workBoardWorkflow';

const projects: ProjectEntry[] = [
  { id: 'alpha', path: '/work/alpha', label: 'Alpha' },
  { id: 'beta', path: '/work/beta', label: 'Beta' },
  { id: 'gamma', path: '/work/gamma', label: 'Gamma' },
];

const domGlobals = (dom: Window) => ({
  window: dom, document: dom.document, navigator: dom.navigator,
  Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
  MutationObserver: dom.MutationObserver, KeyboardEvent: dom.KeyboardEvent,
  Event: dom.Event, MouseEvent: dom.MouseEvent, PointerEvent: dom.PointerEvent,
  getComputedStyle: dom.getComputedStyle.bind(dom),
  requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
  IS_REACT_ACT_ENVIRONMENT: true,
});

test('the picker names the open board and lists the device recent boards first, each with its marks', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = domGlobals(dom);
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const { WorkBoardMobileProjectPicker } = await import('./WorkBoardMobileProjectPicker');
  const { I18nProvider } = await import('@/lib/i18n');
  const display = useSessionDisplayStore.getState();
  useSessionDisplayStore.setState({ animatedActivityIndicators: false });

  const badges = new Map<string, WorkBoardBuildBadge>([['alpha', { count: 0, error: true }]]);
  const asks = new Map<string, WorkBoardTabAsks>([['gamma', { question: true, permission: false }]]);

  // A controlled wrapper: the shell's title badge drives `open` the same way.
  function Harness() {
    const [open, setOpen] = React.useState(false);
    return <WorkBoardMobileProjectPicker
      projects={projects}
      activeProjectId="beta"
      recentProjectIds={['gamma', 'beta']}
      badges={badges}
      asks={asks}
      open={open}
      onOpenChange={setOpen}
      onSelect={() => {}}
    />;
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const items = () => [...document.body.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]')];
  const itemFor = (label: string) => items().find(item => item.textContent?.includes(label));
  try {
    await act(async () => root.render(<I18nProvider><Harness /></I18nProvider>));

    // The trigger names the board on screen, so the picker reads as the tab strip does.
    const trigger = container.querySelector<HTMLButtonElement>('button');
    expect(trigger?.textContent).toBe('Beta');

    await act(async () => { trigger?.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    // Recent boards lead, the rest follow in their given order.
    expect(items().map(item => item.textContent)).toEqual(['Gamma', 'Beta', 'Alpha']);
    // The open board carries the check, in the row rather than the trigger.
    expect(itemFor('Beta')?.querySelector('use[href="#oc-check"]')).not.toBeNull();
    // Each row carries its own marks: the queue error, and the pending question.
    expect(itemFor('Alpha')?.querySelector('[data-work-board-build="error"]')).not.toBeNull();
    expect(itemFor('Gamma')?.querySelector('[data-work-board-ask="question"]')).not.toBeNull();
    // A clean board marks nothing.
    expect(itemFor('Beta')?.querySelector('[data-work-board-build], [data-work-board-ask]')).toBeNull();

    // Closing and reopening paints a fresh list, so it always starts at the top.
    await act(async () => { trigger?.click(); await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(items()).toHaveLength(0);
  } finally {
    await act(async () => root.unmount());
    useSessionDisplayStore.setState(display);
    await dom.happyDOM.close();
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
