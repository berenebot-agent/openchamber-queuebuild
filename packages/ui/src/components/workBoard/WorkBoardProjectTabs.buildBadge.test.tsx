import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import type { ProjectEntry } from '@/lib/api/types';
import type { WorkBoardBuildBadge } from './workBoardWorkflow';

const projects: ProjectEntry[] = [
  { id: 'alpha', path: '/work/alpha', label: 'Alpha' },
  { id: 'beta', path: '/work/beta', label: 'Beta' },
  { id: 'gamma', path: '/work/gamma', label: 'Gamma' },
];

test('a project tab carries its own build count, or an error mark, and nothing when idle', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    MutationObserver: dom.MutationObserver, KeyboardEvent: dom.KeyboardEvent,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const { WorkBoardProjectTabs } = await import('./WorkBoardProjectTabs');
  const { I18nProvider } = await import('@/lib/i18n');
  const display = useSessionDisplayStore.getState();
  useSessionDisplayStore.setState({ animatedActivityIndicators: false });
  const badges = new Map<string, WorkBoardBuildBadge>([
    ['alpha', { count: 3, error: false }],
    ['beta', { count: 0, error: true }],
  ]);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const tabFor = (label: string) => [...container.querySelectorAll('nav button[aria-current], nav button:not([aria-label])')].find(tab => tab.textContent?.includes(label))?.parentElement ?? undefined;
  try {
    await act(async () => root.render(<I18nProvider><WorkBoardProjectTabs
      projects={projects}
      openProjectIds={['alpha', 'beta', 'gamma']}
      activeProjectId="alpha"
      disabled
      badges={badges}
      onSelect={() => {}}
      onAdd={() => {}}
      onClose={() => {}}
      onReorder={() => {}}
    /></I18nProvider>));
    // One running plus two waiting reads as three, on Alpha's own tab.
    const running = tabFor('Alpha')!.querySelector<HTMLElement>('[data-work-board-build="running"]');
    expect(running?.textContent).toBe('3');
    expect(running?.querySelector('svg')).not.toBeNull();
    // Animation is off, so the spinner is a static icon, not the stepped one.
    expect(running?.querySelector('.activity-spinner')).toBeNull();
    // A queue that could not be read is an amber mark, not a silent idle tab.
    const error = tabFor('Beta')!.querySelector<HTMLElement>('[data-work-board-build="error"]');
    expect(error?.querySelector('svg')).not.toBeNull();
    expect(error?.textContent).toBe('');
    // A project with nothing building carries no badge at all.
    expect(tabFor('Gamma')!.querySelector('[data-work-board-build]')).toBeNull();
    // The badges survive a disabled tab, so a board write never hides them.
    expect([...container.querySelectorAll('nav button')].every(button => button.hasAttribute('disabled'))).toBe(true);
    expect(running?.isConnected).toBe(true);
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

test('the spinner steps only when the appearance setting asks for animation', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    MutationObserver: dom.MutationObserver, KeyboardEvent: dom.KeyboardEvent,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const { WorkBoardProjectTabs } = await import('./WorkBoardProjectTabs');
  const { I18nProvider } = await import('@/lib/i18n');
  const display = useSessionDisplayStore.getState();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const render = () => root.render(<I18nProvider><WorkBoardProjectTabs
    projects={projects}
    openProjectIds={['alpha']}
    activeProjectId="alpha"
    disabled={false}
    badges={new Map([['alpha', { count: 1, error: false }]])}
    onSelect={() => {}}
    onAdd={() => {}}
    onClose={() => {}}
    onReorder={() => {}}
  /></I18nProvider>);
  try {
    useSessionDisplayStore.setState({ animatedActivityIndicators: true });
    await act(async () => render());
    expect(container.querySelector('.activity-spinner')).not.toBeNull();
    await act(async () => useSessionDisplayStore.getState().setAnimatedActivityIndicators(false));
    expect(container.querySelector('.activity-spinner')).toBeNull();
    expect(container.querySelector('[data-work-board-build="running"] svg')).not.toBeNull();
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

test('the accessible label names the project and its count', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const globals = {
    window: dom, document: dom.document, navigator: dom.navigator,
    Node: dom.Node, Element: dom.Element, HTMLElement: dom.HTMLElement,
    MutationObserver: dom.MutationObserver, KeyboardEvent: dom.KeyboardEvent,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom), cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(globals).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const { WorkBoardProjectTabs } = await import('./WorkBoardProjectTabs');
  const { I18nProvider } = await import('@/lib/i18n');
  const display = useSessionDisplayStore.getState();
  useSessionDisplayStore.setState({ animatedActivityIndicators: false });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<I18nProvider><WorkBoardProjectTabs
      projects={projects}
      openProjectIds={['alpha', 'beta']}
      activeProjectId="alpha"
      disabled={false}
      badges={new Map([['alpha', { count: 1, error: false }], ['beta', { count: 0, error: true }]])}
      onSelect={() => {}}
      onAdd={() => {}}
      onClose={() => {}}
      onReorder={() => {}}
    /></I18nProvider>));
    expect(container.querySelector('[data-work-board-build="running"]')?.getAttribute('aria-label'))
      .toBe('Alpha: 1 builds in the queue');
    expect(container.querySelector('[data-work-board-build="error"]')?.getAttribute('aria-label'))
      .toBe('Beta: build queue status unavailable');
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
