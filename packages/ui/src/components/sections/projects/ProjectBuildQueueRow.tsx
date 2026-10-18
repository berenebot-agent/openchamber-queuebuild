import React from 'react';
import { SettingsFieldRow, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { fetchQueueSettings, updateQueueSettings } from '@/lib/workBoardApi';
import { isVSCodeRuntime } from '@/lib/desktop';

/** Unset in the dropdown means the project follows the instance default. */
const FOLLOW_DEFAULT = '__default__';
type QueueChoice = typeof FOLLOW_DEFAULT | 'on' | 'off';

const choiceOf = (override: boolean | null): QueueChoice =>
  override === null ? FOLLOW_DEFAULT : override ? 'on' : 'off';

const overrideOf = (choice: QueueChoice): boolean | null =>
  choice === FOLLOW_DEFAULT ? null : choice === 'on';

/**
 * The project's build-queue choice. It follows the instance default until the
 * user picks On or Off here, and "Follow default" clears that choice again.
 * The write is immediate and settles on the server's answer, so the selector
 * never shows a value the server refused.
 */
export function ProjectBuildQueueRow({ directory }: { directory: string }) {
  const { t } = useI18n();
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const [choice, setChoice] = React.useState<QueueChoice>(FOLLOW_DEFAULT);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!directory || isVSCode) return;
    let cancelled = false;
    fetchQueueSettings(directory)
      .then(settings => { if (!cancelled) setChoice(choiceOf(settings.override)); })
      .catch(() => { /* The row keeps the last known value; a failed read must not look like "follow default". */ });
    return () => { cancelled = true; };
  }, [directory, isVSCode]);

  const save = (next: QueueChoice) => {
    const previous = choice;
    setChoice(next);
    setBusy(true);
    updateQueueSettings(directory, overrideOf(next))
      .then(() => fetchQueueSettings(directory))
      .then(settings => setChoice(choiceOf(settings.override)))
      .catch(cause => {
        setChoice(previous);
        toast.error(cause instanceof Error ? cause.message : t('workBoard.failed'));
      })
      .finally(() => setBusy(false));
  };

  if (isVSCode) return null;

  return (
    <SettingsFieldRow
      label={t('workBoard.queueEnabledLabel')}
      info={t('settings.projects.page.queue.followInfo')}
      settingsItem="projects.build-queue"
    >
      <Select value={choice} onValueChange={value => {
        if (value === FOLLOW_DEFAULT || value === 'on' || value === 'off') save(value);
      }}>
        <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('workBoard.queueEnabledLabel')} disabled={!directory || busy}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={FOLLOW_DEFAULT}>{t('settings.projects.page.queue.followDefault')}</SelectItem>
          <SelectItem value="on">{t('workBoard.queueOn')}</SelectItem>
          <SelectItem value="off">{t('workBoard.queueOff')}</SelectItem>
        </SelectContent>
      </Select>
    </SettingsFieldRow>
  );
}
