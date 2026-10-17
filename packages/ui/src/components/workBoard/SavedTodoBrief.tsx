import React from 'react';
import { useI18n } from '@/lib/i18n';
import type { WorkBoardCard } from '@/lib/workBoardApi';
import { updateWorkBoardCard } from '@/lib/workBoardApi';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { SavedTodoComposerContext } from './useSavedTodoComposer';
import { completeTodoSave } from './workBoardSavedTodo';

/** The saved text is displayed verbatim, including line breaks and attachments. */
export function SavedTodoBrief({ card }: { card: WorkBoardCard }) {
  const { t } = useI18n();
  const composer = React.useContext(SavedTodoComposerContext);
  const isMobile = useUIStore(state => state.isMobile);
  const [confirm, setConfirm] = React.useState<string | null>(null);
  const [removing, setRemoving] = React.useState(false);
  const actions = composer && !isMobile && !isCapacitorApp() && !isVSCodeRuntime();
  const load = (mode: 'edit' | 'plan') => {
    if (composer?.current) composer.current(card, mode);
    else toast.error(t('workBoard.parkBlocked'));
  };
  const remove = async () => {
    if (removing || confirm !== getRuntimeKey()) return;
    setRemoving(true);
    try {
      const updated = await updateWorkBoardCard(card.id, { removeBrief: true, expectedUpdatedAt: card.updatedAt });
      completeTodoSave(updated);
      setConfirm(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('workBoard.failed'));
    } finally { setRemoving(false); }
  };
  return <section aria-label={t('workBoard.saved')} className="min-w-0 space-y-3 rounded-lg border border-border bg-surface-elevated p-4">
    <header className="flex flex-wrap items-center gap-2">
      <h3 className="me-auto text-sm font-medium text-muted-foreground">{t('workBoard.saved')}</h3>
      {actions && <>
        <Button size="sm" variant="ghost" disabled={removing} onClick={() => load('edit')}><Icon name="edit" className="size-4" />{t('workBoard.edit')}</Button>
        <Button size="sm" variant="ghost" disabled={removing} onClick={() => load('plan')}>{t('workBoard.plan')}<Icon name="arrow-right" className="size-4" /></Button>
        <Button size="sm" variant="ghost" disabled={removing} aria-label={t('workBoard.removeTodo')} title={t('workBoard.removeTodo')} onClick={() => setConfirm(getRuntimeKey())}><Icon name="close" className="size-4" /></Button>
      </>}
    </header>
    {card.text && <div className="whitespace-pre-wrap break-words text-sm" dir="auto">{card.text}</div>}
    {card.attachments.length > 0 && <ul className="space-y-2">
      {card.attachments.map(file => <li key={file.id}>
        <a href={file.dataUrl} download={file.filename} className="break-all text-sm underline">{file.filename}</a>
      </li>)}
    </ul>}
    {actions && <Dialog open={confirm !== null && confirm === getRuntimeKey()} onOpenChange={open => { if (!open && !removing) setConfirm(null); }}>
      <DialogContent>
        <DialogTitle>{t('workBoard.removeTodo')}</DialogTitle>
        <DialogDescription>{t('workBoard.removeTodoConfirm')}</DialogDescription>
        <DialogFooter>
          <Button variant="outline" disabled={removing} onClick={() => setConfirm(null)}>{t('workBoard.cancel')}</Button>
          <Button variant="destructive" disabled={removing} onClick={() => void remove()}>{t('workBoard.removeTodo')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>}
  </section>;
}
