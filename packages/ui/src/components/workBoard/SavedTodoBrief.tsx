import React from 'react';
import { useI18n } from '@/lib/i18n';
import type { WorkBoardCard } from '@/lib/workBoardApi';

/** The saved text is displayed verbatim, including line breaks and attachments. */
export function SavedTodoBrief({ card }: { card: WorkBoardCard }) {
  const { t } = useI18n();
  return <section aria-label={t('workBoard.saved')} className="min-w-0 space-y-3 rounded-lg border border-border bg-surface-elevated p-4">
    <h3 className="text-sm font-medium text-muted-foreground">{t('workBoard.saved')}</h3>
    {card.text && <div className="whitespace-pre-wrap break-words text-sm" dir="auto">{card.text}</div>}
    {card.attachments.length > 0 && <ul className="space-y-2">
      {card.attachments.map(file => <li key={file.id}>
        <a href={file.dataUrl} download={file.filename} className="break-all text-sm underline">{file.filename}</a>
      </li>)}
    </ul>}
  </section>;
}
