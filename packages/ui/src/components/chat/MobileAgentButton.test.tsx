import React, { act } from 'react';
import { Window } from 'happy-dom';
import { describe, expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';

import { ThemeSystemContext, type ThemeContextValue } from '@/contexts/theme-system-context';
import { I18nProvider } from '@/lib/i18n';
import type { Agent } from '@/lib/opencode/model';
import { getDefaultTheme } from '@/lib/theme/themes';
import { useConfigStore } from '@/stores/useConfigStore';

import { MobileAgentButton } from './MobileAgentButton';

/**
 * The mobile composer has no agent picker of its own: the button under the
 * draft is both the agent name and the To-do step of the cycle. Without the
 * To-do name the cycle looks like it stopped working.
 */

const buildAgent: Agent = {
    id: 'review',
    name: 'review',
    displayName: 'Review',
    mode: 'primary',
    hidden: false,
    request: { settings: {}, headers: {}, body: {} },
    permissions: [],
};

const theme = getDefaultTheme(true);

const themeContext: ThemeContextValue = {
    currentTheme: theme,
    availableThemes: [theme],
    customThemeIds: [],
    setTheme: () => undefined,
    customThemesLoading: false,
    reloadCustomThemes: async () => undefined,
    importTheme: async () => theme,
    deleteImportedTheme: async () => undefined,
    isSystemPreference: false,
    setSystemPreference: () => undefined,
    themeMode: 'dark',
    setThemeMode: () => undefined,
    lightThemeId: theme.metadata.id,
    setLightThemePreference: () => undefined,
    darkThemeId: theme.metadata.id,
    setDarkThemePreference: () => undefined,
};

const renderButton = async (todoMode: boolean) => {
    const win = new Window({ url: 'http://localhost' });
    const values = { window: win, document: win.document, navigator: win.navigator, localStorage: win.localStorage, IS_REACT_ACT_ENVIRONMENT: true };
    const previous = new Map(Object.keys(values).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
    for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
    useConfigStore.setState({ agents: [buildAgent], currentAgentName: 'review' });
    const container = document.createElement('div');
    const root = createRoot(container);
    try {
        await act(async () => root.render(
            <ThemeSystemContext.Provider value={themeContext}>
                <I18nProvider>
                    <MobileAgentButton
                        onCycleAgent={() => undefined}
                        onOpenAgentPanel={() => undefined}
                        todoMode={todoMode}
                    />
                </I18nProvider>
            </ThemeSystemContext.Provider>));
        return container.innerHTML;
    } finally {
        await act(async () => root.unmount());
        for (const [key, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, key, descriptor);
            else Reflect.deleteProperty(globalThis, key);
        }
        await win.happyDOM.close();
    }
};

describe('MobileAgentButton', () => {
    test('names the agent while the composer sends', async () => {
        const markup = await renderButton(false);

        expect(markup).toContain('Review');
        expect(markup).not.toContain('To-do');
    });

    test('names the To-do mode while the composer parks the draft', async () => {
        const markup = await renderButton(true);

        expect(markup).toContain('To-do');
        expect(markup).not.toContain('Review');
    });
});
