import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { SessionAiRenameMenuItem } from '@/components/session/SessionAiRenameMenuItem';
import { handleSessionRenameKeyDown } from '@/components/session/sessionRenameKeyboard';
import { describeSessionActionError } from '@/components/session/sidebar/sessions/sessionActionError';
import { collectSessionSubtreeIds, runSessionSubtreeAction } from '@/components/session/sidebar/sessions/sessionSubtreeActions';
import { copyTextToClipboard } from '@/lib/clipboard';
import { buildExportFilename, downloadAsMarkdown, formatSessionAsMarkdown, saveAsMarkdownDesktop } from '@/lib/exportSession';
import { useI18n } from '@/lib/i18n';
import type { Session } from '@/lib/opencode/model';
import { sessionEvents } from '@/lib/sessionEvents';
import { isSessionInWork } from '@/lib/sessionWorkMetadata';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { setSessionWorkState, updateSessionTitle } from '@/sync/session-actions';
import { useSessionMessageRecordsForExport } from '@/sync/use-sync';

type Translate = ReturnType<typeof useI18n>['t'];

const copySessionId = (sessionId: string, t: Translate) => {
  void copyTextToClipboard(sessionId)
    .then((result) => {
      toast[result.ok ? 'success' : 'error'](t(result.ok
        ? 'sessions.sidebar.session.copyId.success'
        : 'sessions.sidebar.session.copyId.error'));
    })
    .catch(() => toast.error(t('sessions.sidebar.session.copyId.error')));
};

type WorkBoardCardMenuProps = {
  /** The session the card is linked to, when it has one. */
  sessionId: string | null;
  /** The card's own directory, for a session the store has not listed yet. */
  directory: string | null;
  /** The card's title, for the trigger's own name. */
  title: string;
  disabled: boolean;
  onStartPlan: (() => void) | null;
  onReturnToTodo: (() => void) | null;
  onRemove: (() => void) | null;
  /** Delete only the saved brief, keeping the session and the card. */
  onRemoveTodo: (() => void) | null;
};

/**
 * The card's own menu: the board's entries, and for a linked session the
 * session menu the sidebar offers. Pin is not here — a card carries its own
 * place on the board, so pinning it again says nothing. Each item's hint stays
 * in the sidebar: that copy names the sidebar, the tabs and In work.
 */
export function WorkBoardCardMenu({ sessionId, directory, title, disabled, onStartPlan, onReturnToTodo, onRemove, onRemoveTodo }: WorkBoardCardMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const [renaming, setRenaming] = React.useState(false);
  // The rename dialog opens after the menu's close transition, or Base UI's
  // focus cleanup takes the input's focus back to the trigger.
  const pendingRenameRef = React.useRef(false);
  const sessionWorkEnabled = useUIStore(state => state.sessionWorkEnabled);
  const session = useGlobalSessionsStore(state => (sessionId ? state.entityById.get(sessionId) ?? null : null));
  const sessionDirectory = session?.directory ?? directory;
  const canTrackWork = Boolean(session) && sessionWorkEnabled && !session?.parentID;
  const inWork = Boolean(session) && isSessionInWork(session);

  const toggleWork = () => {
    if (!session) return;
    void setSessionWorkState(session.id, sessionDirectory, inWork ? 'done' : 'open')
      .catch(() => toast.error(t('sessions.sidebar.session.work.updateFailed')));
  };

  const archive = () => {
    if (!session) return;
    // The board has no rendered tree, so the session's own subtree comes from
    // the global cache, the way a flat sidebar row resolves one.
    void runSessionSubtreeAction(
      'archive',
      session,
      collectSessionSubtreeIds(session.id, [], false),
      useSessionUIStore.getState(),
      t,
    );
  };

  const requestDelete = () => {
    if (!session) return;
    const descendants = collectSessionSubtreeIds(session.id, [], true)
      .map(id => useGlobalSessionsStore.getState().entityById.get(id))
      .filter((entry): entry is Session => Boolean(entry));
    sessionEvents.requestDelete({ sessions: [session, ...descendants], mode: 'session' });
  };

  return <>
    <DropdownMenu open={open} onOpenChange={setOpen} onOpenChangeComplete={(next) => {
      if (next || !pendingRenameRef.current) return;
      pendingRenameRef.current = false;
      setRenaming(true);
    }}>
      <DropdownMenuTrigger asChild>
        <button type="button" disabled={disabled} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-40 transition-opacity hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100" title={t('workBoard.cardActions', { title })} aria-label={t('workBoard.cardActions', { title })}>
          <Icon name="more" className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {onStartPlan ? <DropdownMenuItem onClick={onStartPlan}>{t('workBoard.startPlan')}</DropdownMenuItem> : null}
        {onReturnToTodo ? <DropdownMenuItem onClick={onReturnToTodo}>{t('workBoard.backTodo')}</DropdownMenuItem> : null}
        {onRemoveTodo ? <DropdownMenuItem onClick={onRemoveTodo}>{t('workBoard.removeTodo')}</DropdownMenuItem> : null}
        {onRemove ? <DropdownMenuItem onClick={onRemove}>{t('workBoard.remove')}</DropdownMenuItem> : null}
        {session ? <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => { pendingRenameRef.current = true; }}>
            <Icon name="pencil-ai" className="me-1 size-4" />{t('sessions.sidebar.session.menu.rename')}
          </DropdownMenuItem>
          <SessionAiRenameMenuItem sessionID={session.id} directory={sessionDirectory} open={open} Item={DropdownMenuItem} />
          <DropdownMenuItem onClick={() => copySessionId(session.id, t)}>
            <Icon name="file-copy" className="me-1 size-4" />{t('sessions.sidebar.session.menu.copyId')}
          </DropdownMenuItem>
          <WorkBoardExportMenuItem session={session} directory={sessionDirectory} />
          {canTrackWork ? <DropdownMenuItem onClick={toggleWork}>
            <Icon name={inWork ? 'check' : 'eye'} className="me-1 size-4" />
            {t(inWork ? 'sessions.sidebar.session.work.markDone' : 'sessions.sidebar.session.work.track')}
          </DropdownMenuItem> : null}
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={archive}>
            <Icon name="inbox-archive" className="me-1 size-4" />{t('sessions.sidebar.bulkActions.archive')}
          </DropdownMenuItem>
          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={requestDelete}>
            <Icon name="delete-bin" className="me-1 size-4" />{t('sessions.sidebar.bulkActions.delete')}
          </DropdownMenuItem>
        </> : null}
      </DropdownMenuContent>
    </DropdownMenu>
    {renaming && session ? <WorkBoardRenameDialog session={session} onClose={() => setRenaming(false)} /> : null}
  </>;
}

/**
 * Export as Markdown, loading the conversation through the sync runtime the
 * chat surfaces use. It is a component of its own because that runtime lives in
 * the sync tree: the menu content mounts only while the menu is open, and the
 * board renders where no such runtime is required.
 */
function WorkBoardExportMenuItem({ session, directory }: { session: Session; directory: string | null }) {
  const { t } = useI18n();
  const loadRecords = useSessionMessageRecordsForExport();

  const exportSession = async () => {
    if (!directory) {
      toast.error(t('sessions.sidebar.session.export.nothingToExport'));
      return;
    }
    const records = await loadRecords({ directory, sessionID: session.id }).catch(() => null);
    if (!records) {
      toast.error(t('sessions.sidebar.session.export.failedLoadHistory'));
      return;
    }
    if (records.length === 0) {
      toast.error(t('sessions.sidebar.session.export.nothingToExport'));
      return;
    }
    const markdown = formatSessionAsMarkdown(records, session.title ?? null);
    const filename = buildExportFilename(session.title ?? null);
    const savedPath = await saveAsMarkdownDesktop(markdown, filename);
    if (!savedPath) downloadAsMarkdown(markdown, filename);
    toast.success(t('sessions.sidebar.session.export.success'));
  };

  return <DropdownMenuItem onClick={() => { void exportSession(); }}>
    <Icon name="download" className="me-1 size-4" />{t('sessions.sidebar.session.menu.exportMarkdown')}
  </DropdownMenuItem>;
}

/** The card's rename, as a dialog: the card shows the brief, never the title. */
function WorkBoardRenameDialog({ session, onClose }: { session: Session; onClose: () => void }) {
  const { t } = useI18n();
  const [value, setValue] = React.useState(session.title ?? '');
  const [saving, setSaving] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const save = async () => {
    const next = value.trim();
    if (!next || next === (session.title ?? '').trim()) {
      onClose();
      return;
    }
    setSaving(true);
    try {
      await updateSessionTitle(session.id, next, { directory: session.directory });
      onClose();
    } catch (error) {
      // The dialog stays open with the typed title, so a failed write costs
      // nothing but a retry.
      toast.error(t('sessions.sidebar.session.rename.error', {
        detail: describeSessionActionError(error instanceof Error ? error : new Error(String(error)), t),
      }));
      setSaving(false);
    }
  };

  return <Dialog open onOpenChange={(next) => { if (!next && !saving) onClose(); }}>
    <DialogContent initialFocus={inputRef} className="max-w-sm">
      <DialogHeader>
        <DialogTitle>{t('sessions.sidebar.session.menu.rename')}</DialogTitle>
      </DialogHeader>
      <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <Input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => handleSessionRenameKeyDown(event, onClose)}
          aria-label={t('sessions.sidebar.session.menu.rename')}
          placeholder={t('sessions.sidebar.session.menu.rename')}
          disabled={saving}
        />
      </form>
      <DialogFooter>
        <Button variant="outline" size="sm" disabled={saving} onClick={onClose}>{t('workBoard.cancel')}</Button>
        <Button size="sm" disabled={saving || !value.trim()} onClick={() => { void save(); }}>
          {saving ? <Icon name="loader-4" className="size-4 animate-spin" /> : t('sessions.sidebar.session.rename.save')}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
