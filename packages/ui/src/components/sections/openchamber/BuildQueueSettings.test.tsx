import React from 'react';
import { afterEach, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { BuildQueueSettings } from './BuildQueueSettings';

// Static rendering reads the store's server snapshot, which is its initial
// state, so the fixture is written onto that object rather than through
// setState (the same pattern the GitHub settings test uses).
const state = useUIStore.getInitialState();
const original = { buildQueueGitPolicy: state.buildQueueGitPolicy, buildQueueRequireCleanGit: state.buildQueueRequireCleanGit };
afterEach(() => {
    Object.assign(state, original);
});
const render = () => renderToStaticMarkup(<I18nProvider><BuildQueueSettings /></I18nProvider>);

test('queue policy is searchable and preserves the legacy clean Git fallback', () => {
    state.buildQueueGitPolicy = null;
    state.buildQueueRequireCleanGit = true;
    expect(render()).toContain('chat.build-queue-policy');
    expect(render()).toContain('Waits for a clean Git working tree');
    state.buildQueueRequireCleanGit = false;
    expect(render()).toContain('Starts builds without checking Git');
});

test('explicit commit policy keeps its staged-files warning visible', () => {
    state.buildQueueGitPolicy = 'commit';
    expect(render()).toContain('Commits only files you explicitly staged');
    expect(render()).toContain('No automatic staging or confirmation');
});
