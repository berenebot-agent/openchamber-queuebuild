import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { toast } from 'sonner';

import { Toaster } from './sonner';

describe('Toaster', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  const settle = async () => {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  };

  // A fixed sleep races the machine: under a loaded parallel run Sonner's
  // elevation effect had not run when the timer expired, so the assertion below
  // read an empty priority. Poll for the pinned state instead; the assertions
  // themselves are unchanged and still require 'important'.
  const settleUntil = async (condition: () => boolean) => {
    const deadline = Date.now() + 2_000;
    while (Date.now() < deadline) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      if (condition()) return;
    }
  };

  beforeEach(() => {
    windowInstance = new Window();
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      MutationObserver: windowInstance.MutationObserver,
      getComputedStyle: windowInstance.getComputedStyle.bind(windowInstance),
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    toast.dismiss();
    windowInstance.close();
  });

  test('pins toast elevation without querying the document on unrelated DOM changes', async () => {
    await act(async () => root.render(<Toaster />));

    const documentQueries = spyOn(document, 'querySelectorAll');

    await act(async () => {
      toast('Saved');
    });
    await settleUntil(() => {
      const element = document.querySelector<HTMLElement>('[data-sonner-toast]');
      return element !== null && element.style.getPropertyPriority('box-shadow') === 'important';
    });

    const toastElement = document.querySelector<HTMLElement>('[data-sonner-toast]');
    expect(toastElement).not.toBeNull();
    expect(toastElement?.style.getPropertyPriority('box-shadow')).toBe('important');
    expect(toastElement?.style.getPropertyPriority('outline')).toBe('important');
    expect(toastElement?.getAttribute('tabindex')).toBe('-1');

    // What streaming does to the rest of the app: DOM writes outside the toaster.
    // Sonner itself may query while it shows a toast; only what follows counts.
    const queriesBefore = documentQueries.mock.calls.length;
    const transcript = document.createElement('div');
    document.body.append(transcript);
    for (let index = 0; index < 20; index += 1) {
      const token = document.createElement('span');
      token.textContent = `token ${index}`;
      transcript.append(token);
      transcript.setAttribute('style', `height: ${index}px`);
    }
    await settle();

    expect(documentQueries.mock.calls.length).toBe(queriesBefore);
  });
});
