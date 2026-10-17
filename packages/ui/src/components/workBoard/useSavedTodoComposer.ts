import React from 'react';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { fetchSessionWorkBoardCards, updateWorkBoardCard, WorkBoardRequestError, type WorkBoardCard } from '@/lib/workBoardApi';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import { completeTodoSave, useWorkBoardSavedTodo } from './workBoardSavedTodo';

export type SavedTodoComposerHandler = (card: WorkBoardCard, mode: 'edit' | 'plan') => void;

/** Each chat column registers its own composer, including pinned columns. */
export const SavedTodoComposerContext = React.createContext<React.RefObject<SavedTodoComposerHandler | null> | null>(null);

type Operation = {
  card: WorkBoardCard;
  mode: 'edit' | 'plan';
  runtimeKey: string;
  scope: string;
  previous: { text: string; files: AttachedFile[]; todoMode: boolean; agent: string | undefined };
  phase: 'draft' | 'saving' | 'sending' | 'sent';
};

type Options = {
  scope: string;
  sessionId: string | null;
  available: boolean;
  planAgent: string | undefined;
  agent: string | undefined;
  todoMode: boolean;
  setTodoMode: (enabled: boolean) => void;
  selectAgent: (agent: string) => void;
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
  const registration = React.useContext(SavedTodoComposerContext);
  const mutation = useWorkBoardSavedTodo(state => state.latestSave);
  const [operation, setOperation] = React.useState<Operation | null>(null);
  const operationRef = React.useRef(operation);
  const latestOptions = React.useRef(options);
  latestOptions.current = options;
  const change = React.useCallback((next: Operation | null) => { operationRef.current = next; setOperation(next); }, []);
  const owns = React.useCallback((op: Operation) => getRuntimeKey() === op.runtimeKey && latestOptions.current.scope === op.scope
    && operationRef.current?.previous === op.previous, []);
  const active = operation?.scope === options.scope && operation.runtimeKey === getRuntimeKey() ? operation : null;

  React.useLayoutEffect(() => {
    if (!registration) return;
    const load: SavedTodoComposerHandler = (card, mode) => {
      const current = latestOptions.current;
      if (!current.available || card.sessionId !== current.sessionId || operationRef.current
        || (mode === 'plan' && !current.planAgent)) {
        toast.error(t('workBoard.parkBlocked'));
        return;
      }
      const text = current.readText();
      const files = [...current.files];
      const nextFiles = [...files];
      for (const file of card.attachments) {
        if (!nextFiles.some(existing => existing.id === file.id)) nextFiles.push(attachSavedFile(file));
      }
      change({ card, mode, scope: current.scope, runtimeKey: getRuntimeKey(), phase: 'draft',
        previous: { text, files, todoMode: current.todoMode, agent: current.agent } });
      current.setText([text, card.text].filter(value => value.length > 0).join('\n\n'));
      current.setFiles(nextFiles);
      current.setTodoMode(mode === 'edit');
      if (mode === 'plan' && current.planAgent) current.selectAgent(current.planAgent);
      current.focus();
    };
    registration.current = load;
    return () => { if (registration.current === load) registration.current = null; };
  }, [registration, t, change]);

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
    if (op.previous.agent) current.selectAgent(op.previous.agent);
    change(null);
    current.focus();
  }, [change, owns]);

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
      const card = await updateWorkBoardCard(op.card.id, { stage: 'plan', expectedUpdatedAt: op.card.updatedAt });
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
