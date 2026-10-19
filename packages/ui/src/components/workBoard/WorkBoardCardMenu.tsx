import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
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

export type WorkBoardCardMenuProps = {
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

/** The session a card points at, from the shared cache the sidebar reads. */
const useWorkBoardSession = (sessionId: string | null) =>
  useGlobalSessionsStore(state => (sessionId ? state.entityById.get(sessionId) ?? null : null));

/**
 * Opens the card's rename dialog once the menu that asked for it has closed:
 * Base UI's unmount focus cleanup would otherwise pull focus back to the trigger.
 */
function useDeferredCardRename(sessionId: string | null) {
  const session = useWorkBoardSession(sessionId);
  const [renaming, setRenaming] = React.useState(false);
  const pendingRef = React.useRef(false);
  return {
    request: () => { pendingRef.current = true; },
    onOpenChangeComplete: (next: boolean) => {
      if (next || !pendingRef.current) return;
      pendingRef.current = false;
      setRenaming(true);
    },
    dialog: renaming && session ? <WorkBoardRenameDialog session={session} onClose={() => setRenaming(false)} /> : null,
  };
}

type WorkBoardCardMenuItemsProps = Pick<WorkBoardCardMenuProps, 'sessionId' | 'directory' | 'onStartPlan' | 'onReturnToTodo' | 'onRemove' | 'onRemoveTodo'> & {
  /** True while the menu showing the items is open. */
  open: boolean;
  /** The menu root's own item and separator, so one list serves both roots. */
  Item: React.ElementType;
  Separator: React.ElementType;
  onRequestRename: () => void;
};

/**
 * The menu's entries, rendered into whichever root shows them: the card's
 * three-dot dropdown, or the card's own right-click menu. Each item's hint stays
 * in the sidebar: that copy names the sidebar, the tabs and In work.
 */
function WorkBoardCardMenuItems({ sessionId, directory, open, Item, Separator, onRequestRename, onStartPlan, onReturnToTodo, onRemove, onRemoveTodo }: WorkBoardCardMenuItemsProps) {
  const { t } = useI18n();
  const sessionWorkEnabled = useUIStore(state => state.sessionWorkEnabled);
  const session = useWorkBoardSession(sessionId);
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
    {onStartPlan ? <Item onClick={onStartPlan}>{t('workBoard.startPlan')}</Item> : null}
    {onReturnToTodo ? <Item onClick={onReturnToTodo}>{t('workBoard.backTodo')}</Item> : null}
    {onRemoveTodo ? <Item onClick={onRemoveTodo}>{t('workBoard.removeTodo')}</Item> : null}
    {onRemove ? <Item onClick={onRemove}>{t('workBoard.remove')}</Item> : null}
    {session ? <>
      <Separator />
      <Item onClick={onRequestRename}>
        <Icon name="pencil-ai" className="me-1 size-4" />{t('sessions.sidebar.session.menu.rename')}
      </Item>
      <SessionAiRenameMenuItem sessionID={session.id} directory={sessionDirectory} open={open} Item={Item} />
      <Item onClick={() => copySessionId(session.id, t)}>
        <Icon name="file-copy" className="me-1 size-4" />{t('sessions.sidebar.session.menu.copyId')}
      </Item>
      <WorkBoardExportMenuItem session={session} directory={sessionDirectory} Item={Item} />
      {canTrackWork ? <Item onClick={toggleWork}>
        <Icon name={inWork ? 'check' : 'eye'} className="me-1 size-4" />
        {t(inWork ? 'sessions.sidebar.session.work.markDone' : 'sessions.sidebar.session.work.track')}
      </Item> : null}
      <Separator />
      <Item onClick={archive}>
        <Icon name="inbox-archive" className="me-1 size-4" />{t('sessions.sidebar.bulkActions.archive')}
      </Item>
      <Item className="text-destructive focus:text-destructive" onClick={requestDelete}>
        <Icon name="delete-bin" className="me-1 size-4" />{t('sessions.sidebar.bulkActions.delete')}
      </Item>
    </> : null}
  </>;
}

/**
 * The card's own three-dot menu: the board's entries, and for a linked session
 * the session menu the sidebar offers. Pin is not here — a card carries its own
 * place on the board, so pinning it again says nothing.
 */
export function WorkBoardCardMenu({ sessionId, directory, title, disabled, onStartPlan, onReturnToTodo, onRemove, onRemoveTodo }: WorkBoardCardMenuProps) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const rename = useDeferredCardRename(sessionId);
  return <>
    <DropdownMenu open={open} onOpenChange={setOpen} onOpenChangeComplete={rename.onOpenChangeComplete}>
      <DropdownMenuTrigger asChild>
        <button type="button" disabled={disabled} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-40 transition-opacity hover:opacity-100 focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100" title={t('workBoard.cardActions', { title })} aria-label={t('workBoard.cardActions', { title })}>
          <Icon name="more" className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <WorkBoardCardMenuItems
          sessionId={sessionId}
          directory={directory}
          open={open}
          onStartPlan={onStartPlan}
          onReturnToTodo={onReturnToTodo}
          onRemoveTodo={onRemoveTodo}
          onRemove={onRemove}
          Item={DropdownMenuItem}
          Separator={DropdownMenuSeparator}
          onRequestRename={rename.request}
        />
      </DropdownMenuContent>
    </DropdownMenu>
    {rename.dialog}
  </>;
}

/**
 * The card's own right-click menu: the same entries as its three-dot menu, on
 * the card itself. Base UI merges its trigger props into the card element, so
 * the card keeps its drag listeners, its click and its own style.
 */
export function WorkBoardCardContextMenu({ menu, trigger, children }: {
  /** The card's entries, exactly as its three-dot menu takes them. */
  menu: WorkBoardCardMenuProps;
  /** The card element the menu opens on. */
  trigger: React.ReactElement;
  /** The card's content, placed inside that element. */
  children: React.ReactNode;
}) {
  const { sessionId, directory, disabled, onStartPlan, onReturnToTodo, onRemove, onRemoveTodo } = menu;
  const [open, setOpen] = React.useState(false);
  const rename = useDeferredCardRename(sessionId);
  return <>
    <ContextMenu disabled={disabled} onOpenChange={setOpen} onOpenChangeComplete={rename.onOpenChangeComplete}>
      <ContextMenuTrigger render={trigger}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <WorkBoardCardMenuItems
          sessionId={sessionId}
          directory={directory}
          open={open}
          onStartPlan={onStartPlan}
          onReturnToTodo={onReturnToTodo}
          onRemoveTodo={onRemoveTodo}
          onRemove={onRemove}
          Item={ContextMenuItem}
          Separator={ContextMenuSeparator}
          onRequestRename={rename.request}
        />
      </ContextMenuContent>
    </ContextMenu>
    {rename.dialog}
  </>;
}

/**
 * Export as Markdown, loading the conversation through the sync runtime the
 * chat surfaces use. It is a component of its own because that runtime lives in
 * the sync tree: the menu content mounts only while the menu is open, and the
 * board renders where no such runtime is required.
 */
function WorkBoardExportMenuItem({ session, directory, Item }: { session: Session; directory: string | null; Item: React.ElementType }) {
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

  return <Item onClick={() => { void exportSession(); }}>
    <Icon name="download" className="me-1 size-4" />{t('sessions.sidebar.session.menu.exportMarkdown')}
  </Item>;
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
