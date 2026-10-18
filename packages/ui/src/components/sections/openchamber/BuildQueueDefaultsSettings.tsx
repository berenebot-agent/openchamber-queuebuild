import { SettingsCheckboxRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

/**
 * The queue enablement a project follows until someone chooses for that
 * project. It is not a switch over every project: a project that stored its
 * own choice keeps it, and the Projects page shows which ones did.
 */
export function BuildQueueDefaultsSettings({ divider = true }: { divider?: boolean }) {
    const { t } = useI18n();
    const enabled = useUIStore(state => state.buildQueueDefaultEnabled);
    const setEnabled = useUIStore(state => state.setBuildQueueDefaultEnabled);

    return (
        <SettingsSection
            title={t('settings.openchamber.buildQueue.defaults.title')}
            info={t('settings.openchamber.buildQueue.defaults.info')}
            divider={divider}
        >
            <SettingsCheckboxRow
                checked={enabled}
                onChange={setEnabled}
                label={t('settings.openchamber.buildQueue.defaults.enabled')}
                ariaLabel={t('settings.openchamber.buildQueue.defaults.enabled')}
                settingsItem="work-board.default-enabled"
            />
        </SettingsSection>
    );
}
