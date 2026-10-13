import React from 'react';

import { SettingsCheckboxRow, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Settings → Chat → Build queue. One switch for the project build queue's Git
 * gate: on, a queued build starts only from a clean working tree, which is what
 * makes a directory that is not a Git repository unqueueable. Off skips the
 * check. The server reads the value off disk at dispatch, so a change applies to
 * the next build without a restart. Not offered in VS Code, which has no
 * OpenChamber server to run the queue.
 */
export const BuildQueueSettings: React.FC = () => {
  const { t } = useI18n();
  const requireCleanGit = useUIStore((state) => state.buildQueueRequireCleanGit);
  const setRequireCleanGit = useUIStore((state) => state.setBuildQueueRequireCleanGit);

  return (
    <SettingsSection title={t('settings.openchamber.buildQueue.title')}>
      <SettingsCheckboxRow
        settingsItem="chat.build-queue-clean-git"
        checked={requireCleanGit}
        onChange={setRequireCleanGit}
        label={t('settings.openchamber.buildQueue.cleanGit.field')}
        ariaLabel={t('settings.openchamber.buildQueue.cleanGit.field')}
        info={t('settings.openchamber.buildQueue.cleanGit.info')}
      />
    </SettingsSection>
  );
};
