import React from 'react';
import { afterEach, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { BuildQueueDefaultsSettings } from './BuildQueueDefaultsSettings';

const state = useUIStore.getInitialState();
const original = state.buildQueueDefaultEnabled;
afterEach(() => {
    state.buildQueueDefaultEnabled = original;
});
const render = () => renderToStaticMarkup(<I18nProvider><BuildQueueDefaultsSettings /></I18nProvider>);

test('the instance default is on until someone turns it off', () => {
    expect(original).toBe(true);
    state.buildQueueDefaultEnabled = true;
    expect(render()).toContain('aria-pressed="true"');
    expect(render()).toContain('work-board.default-enabled');
});

test('the row reports the stored default rather than always on', () => {
    state.buildQueueDefaultEnabled = false;
    expect(render()).toContain('aria-pressed="false"');
});
