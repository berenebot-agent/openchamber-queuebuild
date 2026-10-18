import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { fetchSessionWorkBoardCards, updateWorkBoardCard, WorkBoardRequestError, type WorkBoardCard } from '@/lib/workBoardApi';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { clearTodoLoad, completeTodoSave, showWorkBoardForDirectory, useWorkBoardSavedTodo } from './workBoardSavedTodo';

type SavedTodoComposerHandler = (card: WorkBoardCard) => void;

type Operation = {
  card: WorkBoardCard;
  runtimeKey: string;
  scope: string;
  /** The new-session draft it was handed to, null for a session's composer. */
  newSessionDraftId: number | null;
  previous: { text: string; files: AttachedFile[]; todoMode: boolean };
  phase: 'draft' | 'saving' | 'sending' | 'sent';
};

type Options = {
  scope: string;
  sessionId: string | null;
  /** The open new-session draft this composer is on, if it is on one. */
  newSessionDraftId?: number | null;
  /** The main chat column's composer; a pinned column never takes a board's card. */
  isPrimary: boolean;
  available: boolean;
  todoMode: boolean;
  setTodoMode: (enabled: boolean) => void;
  readText: () => string;
  setText: (text: string) => void;
  files: AttachedFile[];
  setFiles: (files: AttachedFile[]) => void;
  focus: () => void;
};

function attachSavedFile(file: WorkBoardCard['attachments'][number]): AttachedFile {
  const bytes = Uint8Array.from(atob(file.dataUrl.slice(file.dataUrl.indexOf(',') + 1)), char => char.charCodeAt(0));
  return { ...file, file: new File([bytes], file.filename, { type: file.mimeType }), source: 'local' };
}

export function useSavedTodoComposer(options: Options) {
  const { t } = useI18n();
  const mutation = useWorkBoardSavedTodo(state => state.latestSave);
  const [operation, setOperation] = React.useState<Operation | null>(null);
  const operationRef = React.useRef(operation);
  const latestOptions = React.useRef(options);
  latestOptions.current = options;
  const change = React.useCallback((next: Operation | null) => { operationRef.current = next; setOperation(next); }, []);
  const owns = React.useCallback((op: Operation) => getRuntimeKey() === op.runtimeKey && latestOptions.current.scope === op.scope
    && operationRef.current?.previous === op.previous, []);
  const active = operation?.scope === options.scope && operation.runtimeKey === getRuntimeKey() ? operation : null;
  // The loader a card the board opened is handed to, so the brief lands in this
  // composer only once it is the one showing the card's session.
  const loadRef = React.useRef<SavedTodoComposerHandler | null>(null);

  React.useLayoutEffect(() => {
    const load: SavedTodoComposerHandler = (card) => {
      const current = latestOptions.current;
      // A card without a session parks into the open new-session draft, so both
      // sides of the comparison are normalized to the composer's own null.
      if (!current.available || (card.sessionId ?? null) !== (current.sessionId ?? null) || operationRef.current) {
        toast.error(t('workBoard.parkBlocked'));
        return;
      }
      const text = current.readText();
      const files = [...current.files];
      const nextFiles = [...files];
      for (const file of card.attachments) {
        if (!nextFiles.some(existing => existing.id === file.id)) nextFiles.push(attachSavedFile(file));
      }
      change({ card, scope: current.scope, runtimeKey: getRuntimeKey(), phase: 'draft',
        newSessionDraftId: current.newSessionDraftId ?? null,
        previous: { text, files, todoMode: current.todoMode } });
      current.setText([text, card.text].filter(value => value.length > 0).join('\n\n'));
      current.setFiles(nextFiles);
      current.setTodoMode(true);
      current.focus();
    };
    loadRef.current = load;
    return () => { if (loadRef.current === load) loadRef.current = null; };
  }, [t, change]);

  // A card the user clicked opens as the composer's draft, not a transcript row.
  // The card's session id picks the composer: null is the open new-session
  // draft, the session's id is that session's main composer.
  const pendingLoad = useWorkBoardSavedTodo(state => state.pendingLoad);
  React.useEffect(() => {
    if (!options.isPrimary || !pendingLoad) return;
    if (pendingLoad.runtimeKey !== getRuntimeKey()) return;
    const current = latestOptions.current;
    if ((pendingLoad.card.sessionId ?? null) !== current.sessionId) return;
    // A busy or queued session cannot park a brief, and a second card while one
    // is being edited has nowhere to go: drop the request rather than toast.
    if (!current.available || operationRef.current) {
      clearTodoLoad(pendingLoad.card.id);
      return;
    }
    clearTodoLoad(pendingLoad.card.id);
    loadRef.current?.(pendingLoad.card);
  }, [pendingLoad, options.isPrimary, options.sessionId, options.available]);

  React.useEffect(() => {
    const current = operationRef.current;
    if (current && !owns(current)) change(null);
  }, [options.scope, owns, change]);

  const cancel = React.useCallback(() => {
    const op = operationRef.current;
    if (!op || !owns(op) || op.phase !== 'draft') return;
    const current = latestOptions.current;
    current.setText(op.previous.text);
    current.setFiles(op.previous.files);
    current.setTodoMode(op.previous.todoMode);
    change(null);
    current.focus();
  }, [change, owns]);

  // A brief handed to a new-session draft belongs to that draft. Replacing the
  // draft — New Plan, New To-do — withdraws the brief with it, the same way
  // Cancel does, instead of leaving the edit on whatever the user opens next.
  React.useEffect(() => {
    const current = operationRef.current;
    if (!current || !owns(current) || current.newSessionDraftId === (options.newSessionDraftId ?? null)) return;
    if (current.phase === 'draft') cancel();
    else change(null);
  }, [options.newSessionDraftId, cancel, change, owns]);

  React.useEffect(() => {
    if (mutation?.card.briefRemoved && mutation.card.id === operation?.card.id
      && mutation.runtimeKey === operation.runtimeKey) cancel();
  }, [mutation, operation, cancel, owns, change]);

  const save = React.useCallback(async () => {
    const op = operationRef.current;
    if (!op || !owns(op) || op.phase !== 'draft') return;
    const current = latestOptions.current;
    const text = current.readText();
    const files = current.files;
    change({ ...op, phase: 'saving' });
    try {
      const card = await updateWorkBoardCard(op.card.id, {
        text, attachments: files.map(({ id, filename, mimeType, size, dataUrl }) => ({ id, filename, mimeType, size, dataUrl })),
        expectedUpdatedAt: op.card.updatedAt,
      });
      if (!owns(op)) return;
      completeTodoSave(card);
      showWorkBoardForDirectory(card.directory);
      // Edits made during the request remain as the next ordinary draft.
      if (latestOptions.current.readText() === text) latestOptions.current.setText('');
      if (latestOptions.current.files === files) latestOptions.current.setFiles([]);
      change(null);
      toast.success(t('workBoard.saved'));
    } catch (error) {
      if (!owns(op)) return;
      change({ ...op, phase: 'draft' });
      toast.error(error instanceof Error ? error.message : t('workBoard.failed'));
    }
  }, [change, owns, t]);

  const finish = React.useCallback(async (op: Operation) => {
    if (getRuntimeKey() !== op.runtimeKey) return;
    if (owns(op)) change({ ...op, phase: 'sent' });
    try {
      // A card without a session is a draft the send just made real: linking
      // the session the send created is what lets the card follow its lane.
      const linkSessionId = op.card.sessionId ? null : useSessionUIStore.getState().currentSessionId;
      const card = await updateWorkBoardCard(op.card.id, {
        stage: 'plan',
        sessionId: linkSessionId ?? undefined,
        expectedUpdatedAt: op.card.updatedAt,
      });
      if (getRuntimeKey() !== op.runtimeKey) return;
      completeTodoSave(card);
      if (owns(op)) change(null);
    } catch (error) {
      if (error instanceof WorkBoardRequestError && error.status === 409 && op.card.sessionId && getRuntimeKey() === op.runtimeKey) {
        try {
          const cards = await fetchSessionWorkBoardCards(op.card.sessionId);
          const current = cards.find(card => card.id === op.card.id);
          if (current && (current.stage === 'plan' || current.briefRemoved)) {
            completeTodoSave(current);
            if (owns(op)) change(null);
            return;
          }
        } catch { /* Keep the accepted-send recovery action if reconciliation fails. */ }
      }
      // Sending succeeded. Retrying this operation must only update the board.
      if (owns(op)) toast.error(t('workBoard.promotionFailed'));
    }
  }, [change, owns, t]);

  const beginSend = React.useCallback(() => {
    const op = operationRef.current;
    if (!op || !owns(op) || op.phase !== 'draft') return null;
    change({ ...op, phase: 'sending' });
    return {
      accepted: () => finish(op),
      failed: () => { if (owns(op)) change({ ...op, phase: 'draft' }); },
    };
  }, [change, finish, owns]);

  const retry = React.useCallback(() => {
    const op = operationRef.current;
    if (op?.phase === 'sent') void finish(op);
  }, [finish]);
  return React.useMemo(() => ({ active, cancel, save, beginSend, retry }), [active, cancel, save, beginSend, retry]);
}
