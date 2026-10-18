import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectSettingsTabForSearchTarget } from './projectSettingsTabs';

const readSource = (relative: string) =>
  readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..', relative), 'utf8');

// The board's Settings button jumps to a project anchor by id. The reveal only
// works when that id is rendered by the page and names the tab it lives in, so
// a rename on either side has to fail here rather than strand the jump.
test('the work board section the board jumps to is rendered and names its tab', () => {
  const [, target] = readSource('components/workBoard/WorkBoardView.tsx')
    .match(/requestSettingsJump\(\s*'projects'\s*,\s*'([^']+)'\s*\)/) ?? [];
  expect(target).toBeTruthy();
  if (!target) return;
  expect(projectSettingsTabForSearchTarget(target)).toBe('general');
  expect(readSource('components/sections/projects/ProjectGeneralTab.tsx')).toContain(`settingsItem="${target}"`);
});
