import React from 'react';
import { useFontPreferences } from '@/hooks/useFontPreferences';
import { CODE_FONT_OPTION_MAP, CUSTOM_FONT_ID, DEFAULT_MONO_FONT, DEFAULT_UI_FONT, UI_FONT_OPTION_MAP, customFontStack } from '@/lib/fontOptions';
import { loadMonoFont, loadUiFont } from '@/lib/fontLoader';
import { useOptionalThemeSystem } from '@/contexts/useThemeSystem';
import { getBundledThemeFontStack, loadBundledThemeFont } from '@/lib/theme/themeFonts';

export function useAppFontEffects() {
  const { uiFont, monoFont, customUiFont, customMonoFont } = useFontPreferences();
  const themeId = useOptionalThemeSystem()?.currentTheme.metadata.id ?? '';

  React.useEffect(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const root = document.documentElement;
    const defaultUiStack = UI_FONT_OPTION_MAP[DEFAULT_UI_FONT].stack;
    const defaultMonoStack = CODE_FONT_OPTION_MAP[DEFAULT_MONO_FONT].stack;
    // A theme with its own font supplies the UI font until the user picks one.
    const themeFontStack = uiFont === DEFAULT_UI_FONT ? getBundledThemeFontStack(themeId) : undefined;
    if (themeFontStack) {
      loadBundledThemeFont(themeId);
    }
    const uiStack = themeFontStack ?? (uiFont === CUSTOM_FONT_ID
      ? customFontStack(customUiFont, defaultUiStack)
      : UI_FONT_OPTION_MAP[uiFont]?.stack ?? defaultUiStack);
    const monoStack = monoFont === CUSTOM_FONT_ID
      ? customFontStack(customMonoFont, defaultMonoStack)
      : CODE_FONT_OPTION_MAP[monoFont]?.stack ?? defaultMonoStack;
    void loadUiFont(uiFont);
    void loadMonoFont(monoFont);

    root.style.setProperty('--font-sans', uiStack);
    root.style.setProperty('--font-heading', uiStack);
    root.style.setProperty('--font-family-sans', uiStack);
    root.style.setProperty('--font-mono', monoStack);
    root.style.setProperty('--font-family-mono', monoStack);
    root.style.setProperty('--ui-regular-font-weight', '400');

    if (document.body) {
      document.body.style.fontFamily = uiStack;
    }
  }, [uiFont, monoFont, customUiFont, customMonoFont, themeId]);
}
