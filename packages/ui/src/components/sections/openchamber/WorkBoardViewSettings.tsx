import { SettingsCheckboxRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useUIStore } from '@/stores/useUIStore';

/**
 * The board's own display choice, keyed the way the board reads it: per runtime
 * and per project directory. The page shows a project selector because this is
 * the one setting here that differs between projects.
 */
export function WorkBoardViewSettings() {
    const { t } = useI18n();
    const directory = useSettingsDirectory() ?? '';
    const key = JSON.stringify([getRuntimeKey(), directory]);
    const includeOlder = useUIStore(state => state.workBoardOlderSessions[key] ?? true);
    const setIncludeOlder = useUIStore(state => state.setWorkBoardOlderSessions);

    return (
        <SettingsSection title={t('workBoard.title')}>
            <div className="mb-4">
                <SettingsProjectSelector />
            </div>
            <SettingsCheckboxRow
                checked={includeOlder}
                disabled={!directory}
                onChange={checked => setIncludeOlder(getRuntimeKey(), directory, checked)}
                label={t('workBoard.includeOlderSessions')}
                ariaLabel={t('workBoard.includeOlderSessions')}
                info={t('settings.page.workBoard.includeOlderInfo')}
                settingsItem="work-board.include-older-sessions"
            />
        </SettingsSection>
    );
}
