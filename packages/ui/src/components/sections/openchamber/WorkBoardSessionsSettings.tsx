import { NumberInput } from '@/components/ui/number-input';
import {
    SettingsFieldRow,
    SettingsSection,
    SETTINGS_NUMBER_INPUT_CLASS,
    SETTINGS_NUMBER_STEPPER_ROW_CLASS,
    SETTINGS_NUMBER_UNIT_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

/** Upper bound for the window; `0` is the explicit "show all". */
const MAX_WINDOW_DAYS = 3650;

/**
 * How far back the board lists sessions: one window for the person, shared by
 * every client. Running, queued and saved cards always show regardless.
 */
export function WorkBoardSessionsSettings({ divider = true }: { divider?: boolean }) {
    const { t } = useI18n();
    const days = useUIStore(state => state.workBoardSessionDays);
    const setDays = useUIStore(state => state.setWorkBoardSessionDays);

    return (
        <SettingsSection title={t('settings.page.workBoard.sessionsTitle')} divider={divider}>
            <SettingsFieldRow
                label={t('settings.page.workBoard.sessionsLabel')}
                info={t('settings.page.workBoard.sessionWindowInfo')}
                settingsItem="work-board.session-window"
            >
                <div className={SETTINGS_NUMBER_STEPPER_ROW_CLASS}>
                    <NumberInput
                        value={days}
                        onValueChange={setDays}
                        min={0}
                        max={MAX_WINDOW_DAYS}
                        step={1}
                        aria-label={t('settings.page.workBoard.sessionsLabel')}
                        className={cn(SETTINGS_NUMBER_INPUT_CLASS, 'tabular-nums')}
                    />
                    <span className={SETTINGS_NUMBER_UNIT_CLASS}>{t('settings.openchamber.sessionRetention.field.days')}</span>
                </div>
            </SettingsFieldRow>
        </SettingsSection>
    );
}
