import React from 'react';
import { afterEach, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nProvider } from '@/lib/i18n';
import { ThemeSystemProvider } from '@/contexts/ThemeSystemContext';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { WorkBoardViewSettings } from './WorkBoardViewSettings';

// Static rendering reads the store's server snapshot, which is its initial
// state, so fixtures are written onto that object rather than through setState.
const ui = useUIStore.getInitialState();
const projectsStore = useProjectsStore.getInitialState();
const original = {
    workBoardOlderSessions: ui.workBoardOlderSessions,
    settingsProjectPath: ui.settingsProjectPath,
    projects: projectsStore.projects,
    activeProjectId: projectsStore.activeProjectId,
};
afterEach(() => {
    Object.assign(ui, original);
    Object.assign(projectsStore, { projects: original.projects, activeProjectId: original.activeProjectId });
});

const setDirectory = (path: string | null) => {
    projectsStore.projects = [{ id: 'project-1', path: '/repo', label: 'repo' }];
    projectsStore.activeProjectId = 'project-1';
    ui.settingsProjectPath = path;
};

const render = () => renderToStaticMarkup(<ThemeSystemProvider><I18nProvider><WorkBoardViewSettings /></I18nProvider></ThemeSystemProvider>);

test('an untouched board includes older sessions, matching the board default', () => {
    setDirectory(null);
    ui.workBoardOlderSessions = {};
    const key = JSON.stringify([getRuntimeKey(), '/repo']);
    expect(ui.workBoardOlderSessions[key]).toBeUndefined();
    // Default on is the board's own read (`?? true`), so the row must not render
    // as checked={false} on a project nobody has toggled.
    expect(render()).toContain('aria-pressed="true"');
});

test('a stored choice is honoured even when it turns older sessions off', () => {
    setDirectory(null);
    const key = JSON.stringify([getRuntimeKey(), '/repo']);
    ui.workBoardOlderSessions = { [key]: false };
    expect(render()).toContain('aria-pressed="false"');
});

test('the row keys the choice by runtime and Settings project directory', () => {
    projectsStore.projects = [
        { id: 'project-1', path: '/repo', label: 'repo' },
        { id: 'project-2', path: '/other', label: 'other' },
    ];
    projectsStore.activeProjectId = 'project-1';
    ui.settingsProjectPath = '/other';
    ui.workBoardOlderSessions = {
        [JSON.stringify([getRuntimeKey(), '/repo'])]: false,
        [JSON.stringify([getRuntimeKey(), '/other'])]: true,
    };
    // The Settings project selector wins over the active project, so the row
    // reports /other's value rather than the board's active project.
    expect(render()).toContain('aria-pressed="true"');
});
