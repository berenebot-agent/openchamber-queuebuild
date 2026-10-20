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

type WorkBoardSessionMenuItemsProps = {
  sessionId: string | null;
  directory: string | null;
  /** True while the menu showing the items is open. */
  open: boolean;
  /** The menu root's own item and separator, so one list serves both roots. */
  Item: React.ElementType;
  Separator: React.ElementType;
  onRequestRename: () => void;
};

/**
 * The session entries a card's menu shows: the session actions a sidebar row
 * offers. A queued row's menu shows the same list, so a build the user is
 * waiting on can be renamed, exported, archived or deleted from its row, the
 * way a card's own session can. Each item's hint stays in the sidebar: that
 * copy names the sidebar, the tabs and In work.
 */
function WorkBoardSessionMenuItems({ sessionId, directory, open, Item, Separator, onRequestRename }: WorkBoardSessionMenuItemsProps) {
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

  // A session the board has not listed has no session actions to offer.
  if (!session) return null;
  return <>
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
  </>;
}

/**
 * The card's own entries, rendered into whichever root shows them: the card's
 * three-dot dropdown, or the card's own right-click menu.
 */
function WorkBoardCardMenuItems({ sessionId, directory, open, Item, Separator, onRequestRename, onStartPlan, onReturnToTodo, onRemove, onRemoveTodo }: WorkBoardCardMenuItemsProps) {
  const { t } = useI18n();
  return <>
    {onStartPlan ? <Item onClick={onStartPlan}>{t('workBoard.startPlan')}</Item> : null}
    {onReturnToTodo ? <Item onClick={onReturnToTodo}>{t('workBoard.backTodo')}</Item> : null}
    {onRemoveTodo ? <Item onClick={onRemoveTodo}>{t('workBoard.removeTodo')}</Item> : null}
    {onRemove ? <Item onClick={onRemove}>{t('workBoard.remove')}</Item> : null}
    <WorkBoardSessionMenuItems sessionId={sessionId} directory={directory} open={open} Item={Item} Separator={Separator} onRequestRename={onRequestRename} />
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

export type WorkBoardQueueMenuProps = {
  /** The session the queued build belongs to. */
  sessionId: string;
  /** The build's title, for the trigger's own name and each entry's. */
  title: string;
  /** The board's project directory, for a session the store has not listed yet. */
  directory: string | null;
  /** True while a queue write is in flight. */
  disabled: boolean;
  /** True while this row's own item is paused. */
  paused: boolean;
  /** True for the first row in the dispatch order: it cannot move up. */
  first: boolean;
  /** True for the last row in the dispatch order: it cannot move down. */
  last: boolean;
  /** Moves the row one place up or down in the dispatch order. */
  onMove: (delta: number) => void;
  onTogglePause: () => void;
  onForce: () => void;
  onCancel: () => void;
};

/**
 * The queued row's entries: the row's own queue actions first, then the
 * session actions a card's menu shows. One list, so the row's three-dot menu
 * and its right-click menu can never drift apart.
 */
function WorkBoardQueueMenuItems({ menu, open, Item, Separator, onRequestRename }: {
  menu: WorkBoardQueueMenuProps;
  open: boolean;
  Item: React.ElementType;
  Separator: React.ElementType;
  onRequestRename: () => void;
}) {
  const { t } = useI18n();
  const { title, disabled, paused, first, last, onMove, onTogglePause, onForce, onCancel } = menu;
  return <>
    <Item aria-label={t('workBoard.moveUp', { title })} disabled={disabled || first} onClick={() => onMove(-1)}>{t('workBoard.moveUpShort')}</Item>
    <Item aria-label={t('workBoard.moveDown', { title })} disabled={disabled || last} onClick={() => onMove(1)}>{t('workBoard.moveDownShort')}</Item>
    <Item aria-label={t(paused ? 'workBoard.resume' : 'workBoard.pause', { title })} disabled={disabled}
      className={paused ? 'text-[var(--status-warning-text)]' : undefined} onClick={onTogglePause}>
      {t(paused ? 'workBoard.resumeShort' : 'workBoard.pauseShort')}
    </Item>
    <Item aria-label={t('workBoard.force', { title })} disabled={disabled} onClick={onForce}>{t('workBoard.forceShort')}</Item>
    <Item aria-label={t('workBoard.cancelBuild', { title })} disabled={disabled} onClick={onCancel}>{t('workBoard.cancelBuildShort')}</Item>
    <WorkBoardSessionMenuItems sessionId={menu.sessionId} directory={menu.directory} open={open} Item={Item} Separator={Separator} onRequestRename={onRequestRename} />
  </>;
}

/**
 * The queued row's three-dot menu: the same entries its right-click menu shows.
 * A phone gets a touch-sized trigger, because the row's own controls do not
 * fit beside it there and a long press starts a drag.
 */
export function WorkBoardQueueMenu({ menu, touch = false }: { menu: WorkBoardQueueMenuProps; touch?: boolean }) {
  const { t } = useI18n();
  const [open, setOpen] = React.useState(false);
  const rename = useDeferredCardRename(menu.sessionId);
  const label = t('workBoard.cardActions', { title: menu.title });
  return <>
    <DropdownMenu open={open} onOpenChange={setOpen} onOpenChangeComplete={rename.onOpenChangeComplete}>
      <DropdownMenuTrigger asChild>
        {touch
          ? <Button size="icon" variant="ghost" className="size-10 shrink-0" disabled={menu.disabled} aria-label={label} title={label}>
            <Icon name="more" className="size-5" />
          </Button>
          // The row's own controls reveal the cluster they sit in, so this
          // trigger carries no reveal of its own.
          : <button type="button" disabled={menu.disabled} className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground focus-visible:text-foreground" title={label} aria-label={label}>
            <Icon name="more" className="size-3.5" />
          </button>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <WorkBoardQueueMenuItems menu={menu} open={open} Item={DropdownMenuItem} Separator={DropdownMenuSeparator} onRequestRename={rename.request} />
      </DropdownMenuContent>
    </DropdownMenu>
    {rename.dialog}
  </>;
}

/**
 * The queued row's right-click menu: the same entries as its three-dot menu,
 * on the row itself. Base UI merges its trigger props into the row element, so
 * the row keeps its drag listeners, its tooltip and its own style.
 */
export function WorkBoardQueueContextMenu({ menu, trigger, children }: {
  /** The row's entries, exactly as its three-dot menu takes them. */
  menu: WorkBoardQueueMenuProps;
  /** The row element the menu opens on. */
  trigger: React.ReactElement;
  /** The row's content, placed inside that element. */
  children: React.ReactNode;
}) {
  const [open, setOpen] = React.useState(false);
  const rename = useDeferredCardRename(menu.sessionId);
  return <>
    <ContextMenu disabled={menu.disabled} onOpenChange={setOpen} onOpenChangeComplete={rename.onOpenChangeComplete}>
      <ContextMenuTrigger render={trigger}>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <WorkBoardQueueMenuItems menu={menu} open={open} Item={ContextMenuItem} Separator={ContextMenuSeparator} onRequestRename={rename.request} />
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
