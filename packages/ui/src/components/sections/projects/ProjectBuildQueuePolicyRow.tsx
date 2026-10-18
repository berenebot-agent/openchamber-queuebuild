import React from 'react';
import { SettingsFieldRow, SETTINGS_SELECT_ROW_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { updateQueuePolicy, type QueueGitPolicy } from '@/lib/workBoardApi';
import { isVSCodeRuntime } from '@/lib/desktop';

/** Unset in the dropdown means the project follows the instance default. */
const FOLLOW_DEFAULT = '__default__';
type PolicyChoice = typeof FOLLOW_DEFAULT | QueueGitPolicy;

const choiceOf = (override: QueueGitPolicy | null): PolicyChoice => override ?? FOLLOW_DEFAULT;
const overrideOf = (choice: PolicyChoice): QueueGitPolicy | null => (choice === FOLLOW_DEFAULT ? null : choice);

/**
 * The queue behavior this project runs with. It follows the instance default
 * until the user picks one here, and "Follow default" clears that choice again.
 * The write settles on the server's answer, so the selector never shows a value
 * the server refused.
 */
export function ProjectBuildQueuePolicyRow({ directory, override, onSaved }: {
  directory: string;
  override: QueueGitPolicy | null;
  onSaved: () => Promise<void> | void;
}) {
  const { t } = useI18n();
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const [choice, setChoice] = React.useState<PolicyChoice>(choiceOf(override));
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => setChoice(choiceOf(override)), [override]);

  const save = (next: PolicyChoice) => {
    const previous = choice;
    setChoice(next);
    setBusy(true);
    updateQueuePolicy(directory, overrideOf(next))
      .then(result => setChoice(choiceOf(result.policyOverride)))
      .then(onSaved)
      .catch(cause => {
        setChoice(previous);
        toast.error(cause instanceof Error ? cause.message : t('workBoard.failed'));
      })
      .finally(() => setBusy(false));
  };

  if (isVSCode) return null;

  return (
    <SettingsFieldRow
      label={t('settings.openchamber.buildQueue.policy.title')}
      info={t('settings.projects.page.queue.policyInfo')}
      settingsItem="projects.build-queue-policy"
    >
      <Select value={choice} onValueChange={value => {
        if (value === FOLLOW_DEFAULT || value === 'continue' || value === 'commit' || value === 'pause') save(value);
      }}>
        <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('settings.openchamber.buildQueue.policy.title')} disabled={!directory || busy}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={FOLLOW_DEFAULT}>{t('settings.projects.page.queue.followDefault')}</SelectItem>
          <SelectItem value="continue">{t('settings.openchamber.buildQueue.policy.continue')}</SelectItem>
          <SelectItem value="commit">{t('settings.openchamber.buildQueue.policy.commit')}</SelectItem>
          <SelectItem value="pause">{t('settings.openchamber.buildQueue.policy.pause')}</SelectItem>
        </SelectContent>
      </Select>
    </SettingsFieldRow>
  );
}
