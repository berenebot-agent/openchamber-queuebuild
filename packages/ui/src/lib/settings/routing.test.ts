import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SETTINGS_PAGE_METADATA } from './metadata';

const readSource = (relative: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../..', relative), 'utf8');

describe('settings page routing', () => {
  // A page can be registered, titled, and still render nothing when its slug is
  // missing from SettingsView's render switch: that is how the Work board page
  // shipped empty. Every non-home page must be named in the switch.
  test('every registered page is named by the content renderer', () => {
    const source = readSource('components/views/SettingsView.tsx');
    const renderSwitch = source.slice(source.indexOf('const renderUnavailable'));
    const missing = SETTINGS_PAGE_METADATA
      .map((page) => page.slug)
      .filter((slug) => slug !== 'home')
      .filter((slug) => !renderSwitch.includes(`case '${slug}'`));
    expect(missing).toEqual([]);
  });

  // A nav item without an icon is silently skipped by the nav, so a page could
  // be registered and never reachable.
  test('every available page keeps a nav icon', async () => {
    const { getSettingsNavIcon } = await import('./metadata');
    const withoutIcon = SETTINGS_PAGE_METADATA
      .filter((page) => page.slug !== 'home' && page.slug !== 'mcp')
      .filter((page) => page.isAvailable?.({ isVSCode: false, isWeb: true, isDesktop: false, isMobile: false, routingAvailable: true, enterpriseMode: false, jevBlockedByEnterprise: false }) ?? true)
      .filter((page) => getSettingsNavIcon(page.slug) === null)
      .map((page) => page.slug);
    expect(withoutIcon).toEqual([]);
  });
});
