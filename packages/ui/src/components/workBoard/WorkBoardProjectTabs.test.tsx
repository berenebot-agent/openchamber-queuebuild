import { afterEach, expect, test } from 'bun:test';
import React from 'react';
import { Window } from 'happy-dom';

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
  IS_REACT_ACT_ENVIRONMENT: true,
});

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { WorkBoardProjectTabs } = await import('./WorkBoardProjectTabs');
const { removeWorkBoardProjectTab } = await import('./workBoardProjectState');
const container = document.createElement('div');
document.body.appendChild(container);
const root = createRoot(container);

const projects = [
  { id: 'alpha', path: '/work/alpha', label: 'Alpha' },
  { id: 'beta', path: '/work/beta', label: 'Beta' },
];

function Harness() {
  const [openProjectIds, setOpenProjectIds] = React.useState(['alpha']);
  const [activeProjectId, setActiveProjectId] = React.useState('alpha');
  return <I18nProvider><WorkBoardProjectTabs
    projects={projects}
    openProjectIds={openProjectIds}
    activeProjectId={activeProjectId}
    disabled={false}
    onSelect={setActiveProjectId}
    onAdd={projectId => {
      setOpenProjectIds(current => [...current, projectId]);
      setActiveProjectId(projectId);
    }}
    onClose={projectId => {
      const next = removeWorkBoardProjectTab(openProjectIds, activeProjectId, projectId);
      setOpenProjectIds(next.projectIds);
      setActiveProjectId(next.activeProjectId ?? '');
    }}
  /></I18nProvider>;
}

afterEach(async () => {
  await act(async () => root.unmount());
  container.replaceChildren();
  browser.close();
});

test('project tabs add, switch, close, and allow the last tab to be hidden', async () => {
  await act(async () => root.render(<Harness />));
  const addButton = container.querySelector<HTMLButtonElement>('button[aria-label="Add project tab"]');
  if (!addButton) throw new Error('Missing add project tab button');

  await act(async () => { addButton.click(); });
  const betaOption = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(item => item.textContent?.trim() === 'Beta');
  if (!betaOption) throw new Error('Missing project picker item');
  await act(async () => { betaOption.click(); });

  expect(container.querySelector('button[aria-current="page"]')?.textContent).toBe('Beta');
  const alphaTab = [...container.querySelectorAll<HTMLButtonElement>('nav button')]
    .find(button => button.textContent?.trim() === 'Alpha');
  if (!alphaTab) throw new Error('Missing Alpha tab');
  await act(async () => { alphaTab.click(); });
  expect(container.querySelector('button[aria-current="page"]')?.textContent).toBe('Alpha');

  const closeAlpha = container.querySelector<HTMLButtonElement>('button[aria-label="Close Alpha tab"]');
  if (!closeAlpha) throw new Error('Missing Alpha tab close button');
  await act(async () => { closeAlpha.click(); });
  expect(container.querySelector('button[aria-current="page"]')?.textContent).toBe('Beta');

  const closeBeta = container.querySelector<HTMLButtonElement>('button[aria-label="Close Beta tab"]');
  if (!closeBeta) throw new Error('Missing Beta tab close button');
  await act(async () => { closeBeta.click(); });
  expect(container.querySelectorAll('nav button[aria-current="page"]')).toHaveLength(0);
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Add project tab"]')?.disabled).toBe(false);
});
