import { describe, expect, test } from 'bun:test';
import { workBoardI18n } from './work-board.i18n';

const locales = ['en', 'de', 'fr', 'nl', 'es', 'ja', 'ko', 'pl', 'pt-BR', 'uk', 'zh-CN', 'zh-TW', 'tr', 'ar', 'he'] as const;

describe('work board translations', () => {
  test('translates creation and completion actions with matching count placeholders', () => {
    for (const locale of locales) {
      for (const key of ['workBoard.newPlan', 'workBoard.newBuild', 'workBoard.laneActions', 'workBoard.complete', 'workBoard.completeAll', 'workBoard.completeConfirm', 'workBoard.completeSkipped', 'workBoard.completeFailed'] as const) {
        expect(workBoardI18n[locale][key]).toBeTruthy();
        if (locale !== 'en') expect(workBoardI18n[locale][key]).not.toBe(workBoardI18n.en[key]);
        expect(workBoardI18n[locale][key].includes('{count}')).toBe(workBoardI18n.en[key].includes('{count}'));
      }
    }
  });
  test('provides translated project-tab labels in every supported locale', () => {
    for (const locale of locales) {
      const messages = workBoardI18n[locale];
      expect(messages['workBoard.projectTabs']).toBeTruthy();
      expect(messages['workBoard.addProjectTab']).toBeTruthy();
      expect(messages['workBoard.closeProjectTab']).toContain('{project}');
      if (locale !== 'en') {
        expect(messages['workBoard.projectTabs']).not.toBe(workBoardI18n.en['workBoard.projectTabs']);
        expect(messages['workBoard.addProjectTab']).not.toBe(workBoardI18n.en['workBoard.addProjectTab']);
        expect(messages['workBoard.closeProjectTab']).not.toBe(workBoardI18n.en['workBoard.closeProjectTab']);
      }
    }
  });
  test('translates the cancelled-build draft note in every supported locale', () => {
    for (const locale of locales) {
      const message = workBoardI18n[locale]['workBoard.cancelBuildKeptDraft'];
      expect(message).toBeTruthy();
      if (locale !== 'en') expect(message).not.toBe(workBoardI18n.en['workBoard.cancelBuildKeptDraft']);
    }
  });
});
