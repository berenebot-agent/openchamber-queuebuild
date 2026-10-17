import { SettingsFieldRow, SettingsSection, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

export function BuildQueueSettings({ divider = true }: { divider?: boolean }) {
    const { t } = useI18n();
    const policy = useUIStore(state => state.buildQueueGitPolicy ?? (state.buildQueueRequireCleanGit ? 'pause' : 'continue'));
    const setPolicy = useUIStore(state => state.setBuildQueueGitPolicy);

    return (
        <SettingsSection title={t('settings.openchamber.buildQueue.title')} info={t('settings.openchamber.buildQueue.policy.scope')} divider={divider}>
            <SettingsFieldRow label={t('settings.openchamber.buildQueue.policy.title')} settingsItem="work-board.policy">
                <Select value={policy} onValueChange={value => {
                    if (value === 'continue' || value === 'commit' || value === 'pause') setPolicy(value);
                }}>
                    <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.openchamber.buildQueue.policy.title')}>
                        <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                        <SelectItem value="continue">{t('settings.openchamber.buildQueue.policy.continue')}</SelectItem>
                        <SelectItem value="commit">{t('settings.openchamber.buildQueue.policy.commit')}</SelectItem>
                        <SelectItem value="pause">{t('settings.openchamber.buildQueue.policy.pause')}</SelectItem>
                    </SelectContent>
                </Select>
            </SettingsFieldRow>
            <p className="text-sm text-muted-foreground">{t(policy === 'commit'
                ? 'settings.openchamber.buildQueue.policy.commitInfo'
                : policy === 'continue' ? 'settings.openchamber.buildQueue.policy.continueInfo'
                    : 'settings.openchamber.buildQueue.policy.pauseInfo')}</p>
        </SettingsSection>
    );
}
