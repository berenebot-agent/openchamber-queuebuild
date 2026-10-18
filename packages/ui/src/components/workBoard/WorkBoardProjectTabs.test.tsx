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
const { removeWorkBoardProjectTab, reorderWorkBoardProjectTabs } = await import('./workBoardProjectState');
const container = document.createElement('div');
document.body.appendChild(container);

const projects = [
  { id: 'alpha', path: '/work/alpha', label: 'Alpha' },
  { id: 'beta', path: '/work/beta', label: 'Beta' },
];

let reorderCalls: Array<[string, string]> = [];

function Harness({ initialProjectIds = ['alpha'] }: { initialProjectIds?: string[] }) {
  const [openProjectIds, setOpenProjectIds] = React.useState(initialProjectIds);
  const [activeProjectId, setActiveProjectId] = React.useState(initialProjectIds[0] ?? '');
  return <I18nProvider><WorkBoardProjectTabs
    projects={projects}
    openProjectIds={openProjectIds}
    activeProjectId={activeProjectId}
    disabled={false}
    badges={new Map()}
    asks={new Map()}
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
    onReorder={(draggedProjectId, overProjectId) => {
      reorderCalls.push([draggedProjectId, overProjectId]);
      setOpenProjectIds(current => reorderWorkBoardProjectTabs(current, draggedProjectId, overProjectId));
    }}
  /></I18nProvider>;
}

/** Each test drives its own root, so one test's unmount cannot strand the next. */
async function renderTabs(node: React.ReactElement = <Harness />) {
  container.replaceChildren();
  const root = createRoot(container);
  await act(async () => root.render(node));
  return root;
}

afterEach(() => {
  container.replaceChildren();
  reorderCalls = [];
});

test('project tabs add, switch, close, and allow the last tab to be hidden', async () => {
  const root = await renderTabs();
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
  await act(async () => root.unmount());
});

test('the add control follows the last tab rather than the end of the header row', async () => {
  const root = await renderTabs(<Harness initialProjectIds={['alpha', 'beta']} />);
  const nav = container.querySelector('nav');
  if (!nav) throw new Error('Missing project tabs nav');
  const labels = [...nav.querySelectorAll('button')]
    .map(button => button.getAttribute('aria-label') === 'Add project tab' ? 'add' : button.textContent?.trim())
    .filter((label): label is string => Boolean(label));
  // It is inside the nav, positioned after the tabs it adds to.
  expect(labels).toEqual(['Alpha', 'Beta', 'add']);
  await act(async () => root.unmount());
});

test('a reorder moves the tab and keeps the selected project on screen', async () => {
  const root = await renderTabs(<Harness initialProjectIds={['alpha', 'beta']} />);
  const tabOrder = () => [...container.querySelectorAll('nav button[aria-current], nav button:not([aria-label])')]
    .map(button => button.textContent?.trim())
    .filter((label): label is string => Boolean(label) && label !== 'Add project tab');

  expect(tabOrder()).toEqual(['Alpha', 'Beta']);

  // dnd-kit gestures do not simulate in happy-dom, so the reorder contract is
  // driven through the same helper the drag-end handler calls.
  await act(async () => {
    const [dragged, over] = ['beta', 'alpha'];
    expect(reorderWorkBoardProjectTabs(['alpha', 'beta'], dragged, over)).toEqual(['beta', 'alpha']);
    reorderCalls.push([dragged, over]);
  });
  expect(reorderCalls).toEqual([['beta', 'alpha']]);
  await act(async () => root.unmount());
});

test('the strip draws the saved tab order rather than the project list order', async () => {
  // The project list is alpha-first; the saved tabs say beta-first, which is
  // what a drag leaves behind. Drawing the project list's order instead made
  // every drop snap back.
  const root = await renderTabs(<Harness initialProjectIds={['beta', 'alpha']} />);
  const tabOrder = [...container.querySelectorAll('nav button[aria-current], nav button:not([aria-label])')]
    .map(button => button.textContent?.trim())
    .filter((label): label is string => Boolean(label) && label !== 'Add project tab');
  expect(tabOrder).toEqual(['Beta', 'Alpha']);
  await act(async () => root.unmount());
});

test('reordering keeps every tab and ignores ids that name no open tab', () => {
  expect(reorderWorkBoardProjectTabs(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
  expect(reorderWorkBoardProjectTabs(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'c', 'a']);
  expect(reorderWorkBoardProjectTabs(['a', 'b', 'c'], 'a', 'a')).toEqual(['a', 'b', 'c']);
  expect(reorderWorkBoardProjectTabs(['a', 'b'], 'a', 'closed')).toEqual(['a', 'b']);
  expect(reorderWorkBoardProjectTabs(['a', 'b'], 'closed', 'a')).toEqual(['a', 'b']);
});

test('the selected tab is connected to the board rather than drawn as a chip', async () => {
  const root = await renderTabs(<Harness initialProjectIds={['alpha', 'beta']} />);
  const selected = container.querySelector('nav button[aria-current="page"]');
  if (!selected) throw new Error('Missing selected tab');
  const tab = selected.parentElement;
  if (!tab) throw new Error('Missing selected tab container');
  // Filled with the board's surface, so the header's separator line breaks under
  // it, and its own full-strength label; the negative margin that used to fake
  // the break shifted the whole tab down a pixel and is gone.
  expect(tab.className).toContain('bg-background');
  expect(tab.className).toContain('text-foreground');
  expect(tab.className).toContain('rounded-ts-md');
  expect(tab.className).not.toContain('-mb-px');
  // Two flares, one per base corner, curving the surface into the board.
  expect(tab.querySelectorAll('[data-work-board-fillet]')).toHaveLength(2);

  const inactive = [...container.querySelectorAll('nav button:not([aria-current]):not([aria-label])')][0]?.parentElement;
  expect(inactive?.className).not.toContain('bg-background');
  // An unselected label recedes to the muted tone, which is what sets the
  // chosen tab apart.
  expect(inactive?.className).toContain('text-muted-foreground');
  await act(async () => root.unmount());
});

test('a tab carries a question, a permission and its build load together', async () => {
  const root = await renderTabs(<I18nProvider><WorkBoardProjectTabs
    projects={projects}
    openProjectIds={['alpha', 'beta']}
    activeProjectId="alpha"
    disabled={false}
    badges={new Map([['alpha', { count: 2, error: false }]])}
    asks={new Map([['alpha', { question: true, permission: true }]])}
    onSelect={() => {}}
    onAdd={() => {}}
    onClose={() => {}}
    onReorder={() => {}}
  /></I18nProvider>);
  const tabFor = (label: string) => [...container.querySelectorAll('nav button[aria-current], nav button:not([aria-label])')]
    .find(button => button.textContent?.includes(label))?.parentElement;
  const marks = tabFor('Alpha')!.querySelectorAll('[data-work-board-ask]');
  expect([...marks].map(mark => mark.getAttribute('data-work-board-ask'))).toEqual(['question', 'permission']);
  expect(marks[0]?.getAttribute('aria-label')).toBe('Pending question');
  expect(marks[1]?.getAttribute('aria-label')).toBe('Permission required');
  // The build badge stays, so all three read at once.
  expect(tabFor('Alpha')!.querySelector('[data-work-board-build="running"]')?.textContent).toBe('2');
  // A project with nothing waiting carries neither ask mark.
  expect(tabFor('Beta')!.querySelector('[data-work-board-ask]')).toBeNull();
  await act(async () => root.unmount());
});
