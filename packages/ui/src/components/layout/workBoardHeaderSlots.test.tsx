import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import {
  WorkBoardHeaderSlotsProvider,
  WorkBoardProjectTabsPortal,
  WorkBoardSessionTabsPortal,
} from './workBoardHeaderSlots';
import { useWorkBoardHeaderSlots } from './workBoardHeaderSlotsContext';

function SlotsHarness({ onMouseDown }: { onMouseDown: () => void }) {
  const { setProjectTabs, setSessionTabs } = useWorkBoardHeaderSlots();

  return <div onMouseDown={onMouseDown}>
    <div data-project-tabs-slot="" ref={setProjectTabs} />
    <div data-session-tabs-slot="" ref={setSessionTabs} />
    <WorkBoardProjectTabsPortal><span data-project-tabs-content="" /></WorkBoardProjectTabsPortal>
    <WorkBoardSessionTabsPortal><span data-session-tabs-content="" /></WorkBoardSessionTabsPortal>
  </div>;
}

let win: Window;
let root: Root;
let restoreGlobals: () => void;

beforeEach(() => {
  win = new Window({ url: 'http://localhost' });
  const values = {
    window: win, document: win.document, navigator: win.navigator,
    Node: win.Node, Element: win.Element, HTMLElement: win.HTMLElement,
    MouseEvent: win.MouseEvent,
    MutationObserver: win.MutationObserver, ResizeObserver: win.ResizeObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = Object.keys(values).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  restoreGlobals = () => {
    for (const [name, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  await win.happyDOM.close();
  restoreGlobals();
});

test('project tabs move to the app header and session tabs to the board header', async () => {
  let mouseDownBubbles = 0;
  await act(async () => root.render(
    <WorkBoardHeaderSlotsProvider><SlotsHarness onMouseDown={() => { mouseDownBubbles += 1; }} /></WorkBoardHeaderSlotsProvider>,
  ));

  const projectSlot = document.querySelector('[data-project-tabs-slot]');
  const sessionSlot = document.querySelector('[data-session-tabs-slot]');
  expect(document.querySelector('[data-project-tabs-content]')?.parentElement).toBe(projectSlot);
  expect(document.querySelector('[data-session-tabs-content]')?.parentElement?.parentElement).toBe(sessionSlot);
  document.querySelector('[data-session-tabs-content]')?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  expect(mouseDownBubbles).toBe(0);
});
