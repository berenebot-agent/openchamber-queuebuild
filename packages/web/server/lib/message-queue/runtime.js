// Server-owned message queue: messages the user queued while a session was
// busy, delivered by the web server the moment the session goes idle. The
// queue lives here, not in the browser, so closing the tab, locking the phone,
// or losing the connection no longer strands what was queued. Structural
// template: permission-auto-accept (server-authoritative state, UI as a
// projection, VS Code keeps its own foreground implementation).
//
// Event-driven like session-goal: the shared upstream hub delivers
// `session.status`, and an idle transition arms a short per-session timer. The
// tick re-verifies idleness against OpenCode (status map + message tail) before
// it sends, because a queued prompt sent into a running turn would be steered
// into it instead of starting the next one.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const runGit = promisify(execFile);
import { assertPromptResponse } from '../opencode/prompt-response.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';
import { readMergedSettingsSync } from '../opencode/settings-files.js';
import { attachmentHint } from '../routing/runtime.js';
import { isBuildAgentName } from './build-classification.js';

const QUEUE_FILE_NAME = 'message-queue.json';
const QUEUE_FILE_VERSION = 2;
const BUILD_RECHECK_MS = 5000;
const BUILD_INSTRUCTION = 'This build is serialized with other builds in this repository. Implement the requested work, run appropriate tests, and commit only your own changes when complete. Do not stage unrelated files, force reset, or silently discard changes. If you cannot safely commit, explicitly explain why; the next queued build will wait for a clean working tree.';

// Where the instance keeps `settings.json`; the build queue's Git gate is read
// from it off the disk at dispatch, the same way the other server modules that
// consult one profile key on a hot path do. `createMessageQueueRuntime` may
// override it (tests, or an embedder with another data dir).
const defaultBuildQueueSettingsFile = path.join(
  process.env.OPENCHAMBER_DATA_DIR
    ? path.resolve(process.env.OPENCHAMBER_DATA_DIR)
    : path.join(os.homedir(), '.config', 'openchamber'),
  'settings.json',
);

const MAX_SESSIONS = 50;
const MAX_ITEMS_PER_SESSION = 20;
const CONTENT_CHAR_LIMIT = 200_000;
// How much of a build's own prompt the queue snapshots carry. It is what the
// board's tooltip shows as the reason a card is queued or running.
const BUILD_SNAPSHOT_CHAR_LIMIT = 300;

// Idle events arrive in bursts around a turn boundary; a short quiet window
// coalesces them before the tick verifies idleness against OpenCode.
const DISPATCH_QUIET_MS = 500;
// After a user abort the UI held the queue for two seconds so the stop is not
// immediately followed by the next prompt; the server keeps that window.
const ABORT_HOLD_MS = 2_000;
// While a background subagent keeps the turn open, how often the head is
// rechecked in case the parent's rerun idle event is missed.
const SUBAGENT_RECHECK_MS = 5_000;
const RETRY_BASE_DELAY_MS = 2_000;
const RETRY_MAX_DELAY_MS = 60_000;
// A hold is asserted by a UI-driven process (auto-review) that dies with the
// UI; it expires unless the UI keeps re-asserting it.
const HOLD_DEFAULT_TTL_MS = 5 * 60 * 1000;
const HOLD_MAX_TTL_MS = 10 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;
const MESSAGE_TAIL_LIMIT = 2;

const ATTACHMENT_SOURCES = new Set(['local', 'server', 'vscode']);
// Context captured with a queued message (see QueuedContextPart in the UI
// store): attached context items carry metadata the timeline renders back;
// the other kinds are plain synthetic text.
const CONTEXT_PART_KINDS = new Set(['context', 'instruction', 'synthetic']);
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{4,128}$/;

const getQueuedSendRetryDelayMs = (failures) =>
  Math.min(RETRY_BASE_DELAY_MS * 2 ** Math.max(failures - 1, 0), RETRY_MAX_DELAY_MS);

// Boundary readers: the only place raw JSON (client bodies, the queue file,
// OpenCode responses, hub events) is inspected. Everything below them
// branches on the domain values they return.
const asNonEmptyString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');
const asText = (value) => (typeof value === 'string' ? value : '');
const asRecord = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : null);
const asList = (value) => (Array.isArray(value) ? value : null);
const asCount = (value) => (Number.isFinite(value) && value >= 0 ? Math.floor(value) : null);
// One directory, one key: the same normalisation the work board projects with,
// so a Windows path and a trailing slash cannot split a project's lane.
const directoryKey = (value) => asNonEmptyString(value).replace(/\\/g, '/').replace(/\/+$/, '');

const isValidSessionId = (value) => SESSION_ID_PATTERN.test(asNonEmptyString(value));

const httpError = (message, status) => Object.assign(new Error(message), { status });

const parseSendConfig = (value) => {
  const raw = asRecord(value);
  if (!raw) return null;
  const providerID = asNonEmptyString(raw.providerID);
  const modelID = asNonEmptyString(raw.modelID);
  if (!providerID || !modelID) return null;
  const sendConfig = { providerID, modelID };
  const agent = asNonEmptyString(raw.agent);
  if (agent) sendConfig.agent = agent;
  const variant = asNonEmptyString(raw.variant);
  if (variant) sendConfig.variant = variant;
  return sendConfig;
};

const parseAttachment = (value) => {
  const raw = asRecord(value);
  if (!raw) return null;
  const filename = asNonEmptyString(raw.filename);
  const mimeType = asNonEmptyString(raw.mimeType);
  const dataUrl = asText(raw.dataUrl);
  if (!filename || !mimeType || !dataUrl) return null;
  const attachment = {
    id: asNonEmptyString(raw.id) || `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    filename,
    mimeType,
    size: asCount(raw.size) ?? 0,
    source: ATTACHMENT_SOURCES.has(raw.source) ? raw.source : 'local',
  };
  const serverPath = asNonEmptyString(raw.serverPath);
  if (serverPath) attachment.serverPath = serverPath;
  attachment.dataUrl = dataUrl;
  return attachment;
};

const parseContextPart = (value) => {
  const raw = asRecord(value);
  if (!raw || !CONTEXT_PART_KINDS.has(raw.kind)) return null;
  const text = asText(raw.text);
  if (raw.kind !== 'context') return { kind: raw.kind, text };
  // The metadata is the UI's structured payload; the server only carries it
  // to the prompt, so its shape is the UI's to validate on the way back.
  const metadata = asRecord(raw.metadata);
  if (!metadata) return null;
  const part = { kind: 'context', text, metadata };
  const instructions = asNonEmptyString(raw.instructions);
  if (instructions) part.instructions = instructions;
  return part;
};

/**
 * Validates a queued item posted by a client. Throws a TypeError (→ 400) for
 * anything that could not be delivered later: a queue must never hold an item
 * the server cannot send.
 */
export const parseQueuedItemInput = (value) => {
  const raw = asRecord(value);
  if (!raw) throw new TypeError('item is required');
  const content = asText(raw.content).replace(/^\n+|\n+$/g, '');
  if (content.length > CONTENT_CHAR_LIMIT) throw new TypeError('item content is too long');
  const text = raw.text === undefined ? content : asText(raw.text);
  const attachments = (asList(raw.attachments) ?? []).map(parseAttachment);
  if (attachments.some((attachment) => attachment === null)) throw new TypeError('invalid attachment');
  const context = (asList(raw.context) ?? []).map(parseContextPart);
  if (context.some((part) => part === null)) throw new TypeError('invalid context part');
  const commandAdmission = asRecord(raw.admission)?.kind === 'command' && asNonEmptyString(raw.admission.name);
  if (!text.trim() && attachments.length === 0 && context.length === 0 && !commandAdmission) {
    throw new TypeError('item needs text, attachments, or context');
  }
  const sendConfig = parseSendConfig(raw.sendConfig);
  const provenance = asRecord(raw.scheduledTask);
  const projectId = asNonEmptyString(provenance?.projectId);
  const taskId = asNonEmptyString(provenance?.taskId);
  if (provenance && (!projectId || !taskId)) throw new TypeError('invalid scheduledTask provenance');
  // Older admitted prompts may lack the server-captured model and agent.
  const admitted = asRecord(raw.admission) !== null || (asList(raw.acceptedPrompts) ?? []).length > 0;
  if (!sendConfig && !provenance && !admitted) throw new TypeError('item sendConfig with providerID and modelID is required');
  const item = { content, text };
  if (raw.buildQueue === true) item.buildQueue = true;
  // The id the client's own prompt carried. Kept so the accepted prompt can be
  // recognised if the client replays it, and so the queue can answer for the
  // turn it is holding rather than starting a second one.
  const messageId = asNonEmptyString(raw.messageId);
  if (messageId) item.messageId = messageId;
  if (asRecord(raw.admission)) item.admission = raw.admission;
  // The admissions this item still owes: a prompt the server accepted from the
  // wire, and every further prompt merged into the same lane slot.
  const acceptedPrompts = (asList(raw.acceptedPrompts) ?? []).map((entry) => {
    const record = asRecord(entry);
    const admission = asRecord(record?.admission);
    if (!admission) return null;
    const entryId = asNonEmptyString(record.messageId);
    return entryId ? { messageId: entryId, admission } : { admission };
  });
  if (acceptedPrompts.some((entry) => entry === null)) throw new TypeError('invalid acceptedPrompts entry');
  if (acceptedPrompts.length > 0) item.acceptedPrompts = acceptedPrompts;
  else if (item.admission) item.acceptedPrompts = [messageId ? { messageId, admission: item.admission } : { admission: item.admission }];
  const agentMention = asNonEmptyString(raw.agentMention);
  if (agentMention) item.agentMention = agentMention;
  item.attachments = attachments;
  item.context = context;
  const contextPreview = asNonEmptyString(raw.contextPreview).slice(0, 103);
  if (contextPreview) item.contextPreview = contextPreview;
  item.sendConfig = sendConfig ?? {};
  if (provenance) {
    item.scheduledTask = { projectId, taskId };
    const agent = asNonEmptyString(raw.sendConfig?.agent);
    if (agent) item.sendConfig.agent = agent;
  }
  return item;
};

const parseStoredItem = (value) => {
  const raw = asRecord(value);
  const id = raw ? asNonEmptyString(raw.id) : '';
  if (!id) return null;
  try {
    const item = {
      id,
      createdAt: asCount(raw.createdAt) ?? Date.now(),
      ...parseQueuedItemInput(raw),
    };
    if (raw.buildQueue === true) {
      item.buildOrder = asCount(raw.buildOrder) ?? 0;
      if (raw.buildPaused === true) item.buildPaused = true;
    }
    return item;
  } catch {
    return null;
  }
};

const toPublicAttachment = ({ dataUrl: _dataUrl, ...attachment }) => attachment;

// What clients see: everything except the payloads — attachment data URLs
// (megabytes of base64) and captured context (a PR diff, say) — which would
// otherwise ride every broadcast. A take hands the full item back.
const toPublicItem = (item) => {
  const publicItem = { id: item.id, createdAt: item.createdAt, content: item.content, text: item.text };
  if (item.messageId) publicItem.messageId = item.messageId;
  // Every wire id this slot accepted, so a client that was told each of them
  // was queued can confirm any of them after a lost response.
  const messageIds = (item.acceptedPrompts ?? []).map((entry) => asNonEmptyString(entry?.messageId)).filter(Boolean);
  if (item.messageId && !messageIds.includes(item.messageId)) messageIds.unshift(item.messageId);
  if (messageIds.length > 0) publicItem.messageIds = messageIds;
  if (item.agentMention) publicItem.agentMention = item.agentMention;
  publicItem.attachments = item.attachments.map(toPublicAttachment);
  // Older persisted items have no UI summary. Prefer their attached comment
  // before falling back to the model-facing context text.
  const contextPreview = item.contextPreview || item.context
    .filter((part) => part.kind !== 'instruction')
    .map((part) => asNonEmptyString(asRecord(part.metadata?.openchamberContext)?.text) || part.text.trim())
    .find(Boolean);
  if (contextPreview) {
    const firstLine = contextPreview.split('\n', 1)[0];
    publicItem.contextPreview = firstLine.slice(0, 100)
      + (contextPreview.length > firstLine.length || firstLine.length > 100 ? '...' : '');
  }
  publicItem.sendConfig = { ...item.sendConfig };
  if (item.scheduledTask) publicItem.scheduledTask = { ...item.scheduledTask };
  if (item.buildQueue) publicItem.buildQueue = true;
  if (item.buildPaused) publicItem.buildPaused = true;
  return publicItem;
};

/**
 * The model a build was queued with, as the build snapshot and the board read
 * it: the selection admission captured on the item. `null` when the item names
 * none (a scheduled job, or an item stored before that capture existed).
 */
const queuedModelOf = (item) => {
  const { providerID, modelID, variant } = item.sendConfig;
  if (!providerID || !modelID) return null;
  const model = { providerID, id: modelID };
  if (variant) model.variant = variant;
  return model;
};

const extractSessionStatus = (payload) => {
  if (payload.type !== 'session.status') return null;
  const properties = asRecord(payload.properties) ?? {};
  const status = asRecord(properties.status) ?? {};
  const info = asRecord(properties.info) ?? {};
  const sessionId = asNonEmptyString(properties.sessionID);
  const type = asNonEmptyString(status.type) || asNonEmptyString(info.type);
  if (!sessionId || !type) return null;
  return { sessionId, type };
};

const extractAssistantMessageUpdate = (payload) => {
  if (payload.type !== 'message.updated') return null;
  const info = asRecord(asRecord(payload.properties)?.info);
  if (!info || info.role !== 'assistant') return null;
  const sessionId = asNonEmptyString(info.sessionID);
  if (!sessionId) return null;
  return {
    sessionId,
    completed: asCount(asRecord(info.time)?.completed) !== null,
  };
};

/**
 * A user abort no longer arrives as an assistant message carrying
 * `MessageAbortedError`: v2 reports `session.execution.interrupted`, which the
 * translator turns into `session.idle` with `aborted: true`.
 */
const extractAbortedSessionId = (payload) => {
  if (payload.type !== 'session.idle') return null;
  const properties = asRecord(payload.properties) ?? {};
  if (properties.aborted !== true) return null;
  return asNonEmptyString(properties.sessionID);
};

const extractDeletedSessionId = (payload) => {
  if (payload.type !== 'session.deleted') return null;
  const properties = asRecord(payload.properties) ?? {};
  return asNonEmptyString(asRecord(properties.info)?.id) || asNonEmptyString(properties.sessionID) || null;
};

export function createMessageQueueRuntime({
  globalEventHub,
  buildOpenCodeUrl,
  getOpenCodeAuthHeaders,
  sessionKnowledgeRuntime = null,
  broadcastGlobalUiEvent,
  onPromptSent,
  beforeScheduledTaskSend,
  validateScheduledTaskTarget,
  onScheduledTaskResult,
  // Resolves the `openchamber/auto` sentinel into a real model and agent right
  // before the send; absent means the queue never sees the sentinel.
  resolveAutoSelection = null,
  dataDir,
  fetchImpl = fetch,
  now = Date.now,
  dispatchQuietMs = DISPATCH_QUIET_MS,
  abortHoldMs = ABORT_HOLD_MS,
  retryDelayMs = getQueuedSendRetryDelayMs,
  checkBuildGit = null,
  prepareBuildCommit = null,
  buildMonitorDelayMs = 2500,
  buildRecheckMs = BUILD_RECHECK_MS,
  buildCompletionGraceMs = 30000,
  settingsFilePath = defaultBuildQueueSettingsFile,
  // The project's own config file, where its build-queue enablement is stored.
  // Absent means the queue keeps its pre-setting behavior: enabled, with no way
  // to turn it off.
  projectConfigRuntime = null,
  // Resolves a request directory to the project's canonical identity
  // (`{ projectId, directory }`), so a prompt cannot opt itself out of its
  // session's own queue by naming a different directory.
  resolveProjectIdentity = null,
}) {
  const filePath = path.join(dataDir, QUEUE_FILE_NAME);

  /** sessionId → { directory, items } */
  const queues = new Map();
  // One build lease per project directory, held through the entire agent turn.
  const activeBuilds = new Map();
  const buildProblems = new Map();
  const preparingBuilds = new Map();
  const preparationFailures = new Map();
  const buildCommits = new Map();
  const buildMonitors = new Map();
  // Sessions a user forced into build outside the queue lane. Display and
  // tracking only: they hold no lease, wait for no order, and never gate
  // dispatch. Cleared once the session's own turn is done.
  const forcedBuilds = new Map(); // sessionId → { directory, startedAt }
  const forcedMonitors = new Map(); // sessionId → timeout
  // A Force whose prompt may or may not have been accepted, held durably from
  // before the dispatch until either the prompt is confirmed or a human
  // resolves it. A reservation never gates dispatch and is never re-forced.
  const forceReservations = new Map(); // sessionId → { directory, itemId, startedAt, needsReview?, reviewReason? }
  let nextBuildOrder = 1;
  let revision = 0;
  let loadPromise = null;
  let writePromise = Promise.resolve();
  let persistenceError = null;
  let stopped = false;

  // An unfinished assistant message older than this marker is a run that died
  // with the previous server, not a streaming turn: no completion event will
  // ever arrive for it, so treating it as live strands restored queue items
  // forever. A run that outlived the restart (external OpenCode) is still
  // caught by the live status check, which runs first.
  const runtimeStartedAt = now();

  /** In-memory only — a restart has no in-flight sends. */
  const sending = new Map(); // sessionId → itemId
  const timers = new Map(); // sessionId → timeout
  const holdTimers = new Map(); // sessionId → hold-expiry timeout
  const failures = new Map(); // sessionId → { itemId, failures, nextAttemptAt }
  const abortedAt = new Map(); // sessionId → timestamp
  const holds = new Map(); // sessionId → expiresAt
  // sessionId → directory, kept after the queue empties: the UI keys its
  // projection by directory, so the broadcast that removes the last item must
  // still name it or the client cannot tell which queue just finished.
  const directories = new Map();

  // --- persistence ---------------------------------------------------------

  const serialize = () => ({
    version: QUEUE_FILE_VERSION,
    revision,
    nextBuildOrder,
    // An adopted lease tracks a turn the queue does not own and holds no queued
    // item; a restart re-detects that live build, so writing it here would only
    // park a lane whose turn is already over.
    activeBuilds: Object.fromEntries(Array.from(activeBuilds).filter(([, lease]) => !lease.adopted)),
    forceReservations: Object.fromEntries(forceReservations),
    sessions: Object.fromEntries(
      Array.from(queues.entries()).map(([sessionId, queue]) => [sessionId, { directory: queue.directory, items: queue.items }]),
    ),
  });

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (asRecord(error)?.code === 'ENOENT') return { sessions: {}, revision: 0, activeBuilds: {}, forceReservations: {}, nextBuildOrder: 1 };
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Malformed is a failure, not an empty queue: keep the bytes for the
      // user and start over rather than overwriting them on the next write.
      const backup = `${filePath}.corrupt-${now()}`;
      await fs.promises.rename(filePath, backup).catch(() => undefined);
      console.warn(`[message-queue] queue file was unreadable and moved to ${backup}: ${error?.message ?? error}`);
      return { sessions: {}, revision: 0, activeBuilds: {}, forceReservations: {}, nextBuildOrder: 1 };
    }
    const stored = asRecord(parsed) ?? {};
    const sessions = {};
    for (const [sessionId, value] of Object.entries(asRecord(stored.sessions) ?? {})) {
      const entry = asRecord(value);
      if (!entry || !isValidSessionId(sessionId)) continue;
      const directory = asNonEmptyString(entry.directory);
      const items = (asList(entry.items) ?? []).map(parseStoredItem).filter(Boolean);
      if (!directory || items.length === 0) continue;
      sessions[sessionId] = { directory, items };
    }
    return { sessions, revision: asCount(stored.revision) ?? 0, activeBuilds: asRecord(stored.activeBuilds) ?? {}, forceReservations: asRecord(stored.forceReservations) ?? {}, nextBuildOrder: asCount(stored.nextBuildOrder) ?? 1 };
  };

  const load = () => {
    if (!loadPromise) {
      loadPromise = readFile()
        .then((stored) => {
          for (const [sessionId, entry] of Object.entries(stored.sessions)) queues.set(sessionId, entry);
          revision = Math.max(revision, stored.revision);
          for (const [directory, value] of Object.entries(stored.activeBuilds)) {
            if (asNonEmptyString(directory) && isValidSessionId(asRecord(value)?.sessionId)) {
              // A restored lease represents a prompt dispatched before restart.
              // The live status probe still prevents releasing external runs that survived.
              const hasQueuedItem = queues.get(value.sessionId)?.items.some(item => item.id === value.itemId);
              activeBuilds.set(directory, { ...value, observedBusy: false, restored: true, ...(hasQueuedItem ? { needsReview: true, reviewReason: 'restart-during-dispatch' } : {}) });
            }
          }
          // A reservation restored from disk is a Force whose prompt may have
          // been accepted. It is never re-sent and never cleared alone: the item
          // stays queued and the user resolves the uncertain state.
          for (const [sessionId, value] of Object.entries(stored.forceReservations)) {
            const entry = asRecord(value);
            if (!isValidSessionId(sessionId) || !asNonEmptyString(entry?.directory) || !asNonEmptyString(entry?.itemId)) continue;
            forceReservations.set(sessionId, {
              directory: asNonEmptyString(entry.directory),
              itemId: asNonEmptyString(entry.itemId),
              startedAt: asCount(entry.startedAt) ?? now(),
              needsReview: true,
              reviewReason: 'restart-during-force',
            });
          }
          nextBuildOrder = Math.max(nextBuildOrder, stored.nextBuildOrder, ...Array.from(queues.values()).flatMap(q => q.items.map(i => (i.buildOrder ?? 0) + 1)));

        })
        .catch((error) => {
          // A read failure keeps the in-memory (empty) queue but must not be
          // mistaken for "nothing queued": the next write would clobber the
          // file, so writes stay disabled until a later load succeeds.
          loadPromise = null;
          throw error;
        });
    }
    return loadPromise;
  };

  const persist = () => {
    const payload = JSON.stringify(serialize());
    writePromise = writePromise
      .then(async () => {
        await fs.promises.mkdir(dataDir, { recursive: true });
        const tmpPath = `${filePath}.${process.pid}.tmp`;
        // Queued prompts are conversation content: readable by the owner only.
        await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf8', mode: 0o600 });
        await fs.promises.rename(tmpPath, filePath);
        persistenceError = null;
      })
      .catch((error) => {
        persistenceError = error;
        console.warn('[message-queue] failed to persist queue:', error?.message ?? error);
      });
    return writePromise;
  };

  // --- snapshots -----------------------------------------------------------

  const sessionSnapshot = (sessionId) => {
    const queue = queues.get(sessionId);
    return {
      sessionId,
      directory: queue?.directory ?? directories.get(sessionId) ?? '',
      items: (queue?.items ?? []).map(toPublicItem),
      sendingId: sending.get(sessionId) ?? null,
    };
  };

  const snapshot = () => ({
    revision,
    sessions: Array.from(queues.keys()).map(sessionSnapshot),
  });
  // A queued build belongs to a Build-mode session. The composer decides that
  // from the session's own agent, but items queued before that gate existed can
  // carry the flag from a Plan session; those must not surface as project
  // builds, and reordering cannot rely on their position. Persisted data is
  // left as it is: this only decides what the queue dispatches and shows.
  //
  // A prompt the server admitted from the wire (`admission`) was classified
  // against the session's live agent by the server itself, so it is build work
  // by construction and carries no client-supplied agent string to re-check.
  const isBuildItem = (item) => item.buildQueue === true
    && (item.admission !== undefined || item.sendConfig?.agent?.toLowerCase() === 'build');
  /**
   * One lane slot per session: a further Build prompt joins the item the
   * session already holds instead of taking a second place in the project
   * order. Text, attachments and context join it the way they would ride one
   * queued message; the id, position, pause state and captured selection stay
   * with the slot the user created first.
   *
   * Every admitted prompt keeps its own wire identity in `acceptedPrompts`:
   * two prompts merged into one slot are still two admissions to perform, each
   * with its id, files, agents, skills and metadata, and the client was told
   * about each of them separately.
   */
  const appendToBuildSlot = (item, incoming) => {
    const content = [item.content, incoming.content].filter(Boolean).join('\n\n');
    const text = [item.text, incoming.text].filter(Boolean).join('\n\n');
    if (content.length > CONTENT_CHAR_LIMIT || text.length > CONTENT_CHAR_LIMIT) {
      throw new TypeError('item content is too long');
    }
    item.content = content;
    item.text = text;
    if (incoming.attachments.length > 0) item.attachments = [...item.attachments, ...incoming.attachments];
    if (incoming.context.length > 0) item.context = [...item.context, ...incoming.context];
    if (incoming.agentMention && !item.agentMention) item.agentMention = incoming.agentMention;
    if (incoming.contextPreview && !item.contextPreview) item.contextPreview = incoming.contextPreview;
    if (incoming.admission) {
      item.acceptedPrompts = [...(item.acceptedPrompts ?? []), { admission: incoming.admission, messageId: incoming.messageId }];
    }
  };
  const pendingBuilds = (directory) => Array.from(queues.entries())
    .flatMap(([sessionId, queue]) => queue.items.filter(item => isBuildItem(item) && (!directory || queue.directory === directory))
      .map(item => ({ sessionId, directory: queue.directory, item })))
    .sort((a, b) => a.item.buildOrder - b.item.buildOrder || a.item.createdAt - b.item.createdAt || a.item.id.localeCompare(b.item.id));
  // An unresolved Force owns its item: the queue must not send it again, and it
  // holds no place in the project's runnable order, so another build can start.
  const reservedForItem = (sessionId, itemId) => forceReservations.get(sessionId)?.itemId === itemId;
  const runnableBuilds = (directory) => pendingBuilds(directory)
    .filter(entry => !entry.item.buildPaused && !reservedForItem(entry.sessionId, entry.item.id));
  const buildSnapshot = () => ({
    revision,
    preparation: Array.from(preparingBuilds, ([directory, value]) => ({ directory, phase: value.phase })),
    commits: Array.from(buildCommits, ([directory, value]) => ({ directory, ...value })),
    active: Array.from(activeBuilds.entries()).map(([directory, lease]) => ({ directory, ...lease, retryAvailable: queues.get(lease.sessionId)?.items.some(item => item.id === lease.itemId) === true })),
    forced: [
      ...Array.from(forcedBuilds, ([sessionId, value]) => ({
        sessionId,
        directory: value.directory,
        startedAt: value.startedAt,
        content: value.content ?? null,
        model: value.model ?? null,
      })),
      // An unresolved Force is not a running build: it carries the item it
      // targeted and the recovery the board offers for it.
      ...Array.from(forceReservations, ([sessionId, value]) => ({
        sessionId,
        directory: value.directory,
        startedAt: value.startedAt,
        itemId: value.itemId,
        needsReview: value.needsReview !== false,
        action: value.needsReview !== false ? 'resolve' : null,
        content: value.content ?? null,
        model: value.model ?? null,
      })),
    ],
    queued: pendingBuilds().map(({ sessionId, directory, item }, index) => ({ id: item.id, sessionId, directory, content: item.content.slice(0, BUILD_SNAPSHOT_CHAR_LIMIT), createdAt: item.createdAt, order: index, paused: item.buildPaused === true, model: queuedModelOf(item) })),
    issues: [
      ...Array.from(buildProblems.entries()).filter(([directory]) => pendingBuilds(directory).length > 0).map(([directory, issue]) => ({ directory, issue })),
      ...Array.from(activeBuilds.entries()).filter(([, lease]) => lease.needsReview)
        .map(([directory, lease]) => ({ directory, issue: lease.reviewReason === 'aborted'
          ? 'The previous build was stopped. Review its changes before continuing.'
          : lease.reviewReason === 'persistence-failed'
            ? 'Build queue storage failed. Repair server storage, then review this build.'
            : lease.reviewReason === 'dispatch-failed'
              ? 'Build dispatch returned an error, but the prompt may have started. Review the original session before retrying.'
              : 'Server restarted during build dispatch. Review the original session to prevent a duplicate execution.' })),
    ],
  });

  const broadcast = (sessionId) => {
    broadcastGlobalUiEvent?.({
      type: 'openchamber:message-queue.updated',
      properties: { revision, session: sessionSnapshot(sessionId) },
    });
  };

  /** Every mutation goes through here: bump, persist, broadcast. */
  const commit = (sessionId) => {
    revision += 1;
    void persist();
    broadcast(sessionId);
    return { revision, session: sessionSnapshot(sessionId) };
  };

  const reportScheduledResult = (item, status, error) => {
    if (!item.scheduledTask) return;
    Promise.resolve().then(() => onScheduledTaskResult?.(item.scheduledTask, status, error))
      .catch((failure) => console.warn('[message-queue] scheduled task state write failed:', failure?.message ?? failure));
  };

  const setQueueItems = (sessionId, directory, items, status = 'cancelled', error) => {
    for (const item of queues.get(sessionId)?.items ?? []) {
      if (item.scheduledTask && !items.some((entry) => entry.id === item.id)) reportScheduledResult(item, status, error);
    }
    directories.set(sessionId, directory);
    if (items.length === 0) {
      queues.delete(sessionId);
      return;
    }
    queues.set(sessionId, { directory, items });
  };

  // --- OpenCode access -----------------------------------------------------

  const openCodeFetch = async (fetchPath, { directory, method = 'GET', body, query, headers: extraHeaders } = {}) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const params = new URLSearchParams(query || {});
    if (directory) params.set('directory', directory);
    const search = params.toString();
    const headers = { Accept: 'application/json', ...getOpenCodeAuthHeaders(), ...extraHeaders };
    const init = { method, headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) };
    if (body) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const response = await fetchImpl(search ? `${base}?${search}` : base, init);
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw httpError(`OpenCode ${method} ${fetchPath} failed with ${response.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`, response.status);
    }
    if (method === 'POST') {
      await assertPromptResponse(response, 'OpenCode dispatch');
    }
    return unwrapOpenCodeResponse(await response.json().catch(() => null));
  };

  /**
   * Live idleness, or null when it could not be established. Unknown is never
   * idle: a fetch failure re-arms instead of sending into a running turn.
   */
  const activityProbe = createSessionActivityProbe({ buildOpenCodeUrl, getOpenCodeAuthHeaders, timeoutMs: FETCH_TIMEOUT_MS, fetchImpl });

  /** True while a subagent of the session runs; null when it could not be checked. */
  const hasWorkingSubagents = async (sessionId) => {
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!statuses) return null;
    return activityProbe.hasWorkingDescendants(sessionId, statuses);
  };

  const isSessionIdle = async (sessionId, directory) => {
    // `/api/session/active` is global and lists only the sessions that are
    // running right now, so an absent entry means idle.
    // The route answers `{ data: { [id]: { type: 'running' } } }`; the shared
    // unwrap hands over the map, and an envelope is still accepted.
    const body = asRecord(await openCodeFetch('/api/session/active').catch(() => null));
    const statuses = asRecord(body && 'data' in body ? body.data : body);
    if (!statuses) return null;
    if (asRecord(statuses[sessionId])) return false;
    // A missed event leaves no entry while a turn still streams. The trailing
    // unfinished assistant message is the live evidence of that turn (mirrors
    // the UI gate). v2 lists messages newest first.
    const page = await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/message`, {
      directory,
      query: { limit: String(MESSAGE_TAIL_LIMIT) },
    }).catch(() => null);
    const messages = asList(asRecord(page)?.data);
    if (!messages) return null;
    const last = asRecord(messages[0]);
    const lastTime = asRecord(last?.time);
    if (last?.type === 'assistant' && asCount(lastTime?.completed) === null) {
      const created = asCount(lastTime?.created);
      if (created === null || created >= runtimeStartedAt) return false;
      // Unfinished tail from before this runtime started: its run died with
      // the previous server, so it must not block delivery. (A missing
      // created timestamp stays conservative and blocks, as before.)
      console.log(`[message-queue] ignoring pre-boot unfinished tail for ${sessionId}`);
    }
    return true;
  };

  const resolveSlashCommand = async (text, directory) => {
    if (!text.startsWith('/')) return null;
    const [head, ...tail] = text.split(' ');
    const name = head.slice(1);
    if (!name) return null;
    const commands = asList(await openCodeFetch('/api/command', { directory })) ?? [];
    const match = commands.map(asRecord).find((command) => command?.name === name);
    if (!match) return null;
    return {
      name,
      arguments: tail.join(' '),
    };
  };

  // v2 takes prompt attachments as URIs; a data URL is one.
  const toPromptFile = (attachment) => ({
    uri: attachment.dataUrl,
    ...(attachment.filename ? { name: attachment.filename } : {}),
  });

  /**
   * Captured context travels as synthetic messages in v2 — the composer's
   * inline `synthetic: true` text parts are gone. One message per entry, an
   * attached item's metadata riding along, and its reading instructions (a
   * linked PR) going first.
   */
  const toContextMessages = (part) => {
    const body = { text: part.text, resume: false };
    if (part.kind !== 'context') return [body];
    const withMetadata = part.metadata ? { ...body, metadata: part.metadata } : body;
    return part.instructions
      ? [{ text: part.instructions, resume: false }, withMetadata]
      : [withMetadata];
  };

  const sendItem = async (sessionId, directory, item, buildSelection, { forced = false } = {}) => {
    const { providerID, modelID, variant } = item.sendConfig;
    let agent = item.sendConfig.agent;
    // Older admitted prompts without captured selection keep the session's.
    const admittedPrompt = Object.keys(item.sendConfig).length === 0 && (item.acceptedPrompts?.length ?? 0) > 0;
    let model = { id: modelID, providerID, ...(variant ? { variant } : {}) };
    const promptFiles = item.attachments.map(toPromptFile);
    const contextMessages = item.context.flatMap(toContextMessages);

    // Jev routing, when the queued send named the Auto sentinel. A failure
    // inside resolves to the fallback model; only a missing fallback throws.
    const routed = buildSelection ?? (providerID && modelID ? await resolveAutoSelection?.({
      sessionId,
      directory,
      model,
      agent,
      requestText: `${item.text}${attachmentHint({ files: promptFiles })}`.trim(),
    }) : null);
    if (routed) {
      model = routed.model;
      agent = routed.agent ?? agent;
    }

    // v2 selects model and agent on the session, not per prompt: the choice is
    // switched once and then persists. Legacy admissions and scheduled items
    // without captured selection keep the target's.
    if ((!item.scheduledTask && !admittedPrompt) || (providerID && modelID)) await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/model`, {
      directory,
      method: 'POST',
      body: { model },
    });
    if (agent) {
      await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/agent`, {
        directory,
        method: 'POST',
        body: { agent },
      });
    }

    // Resolved before anything is admitted: a failed command lookup fails the
    // whole send, so a retry does not admit the context twice.
    const accepted = await Promise.all((item.acceptedPrompts ?? []).filter(entry => asRecord(entry?.admission))
      .map(async entry => ({
        ...entry,
        command: entry.admission.kind === 'command'
          ? { name: entry.admission.name, arguments: asText(entry.admission.text) }
          : await resolveSlashCommand(asText(entry.admission.text), directory),
      })));
    const command = accepted.length ? null : await resolveSlashCommand(item.text, directory);

    // Standing project context is written into the session first, exactly as
    // a UI send does it; a failed write sends without it rather than not at all.
    if (sessionKnowledgeRuntime) await sessionKnowledgeRuntime.sync(sessionId, directory);

    // Same order as a UI send: everything attached to the message is admitted
    // before the message itself, so the model reads it as background. This
    // holds for a command too: its route takes file attachments only, and
    // sending "/name args" as a prompt instead would skip the template
    // OpenCode 2.x expands only on the command route.
    const admission = asRecord(item.admission);
    // Synthetics the prompt arrived behind (standing context, a goal briefing)
    // are staged with it: forwarding them while the prompt waits would leave
    // the model reading background with nothing following it.
    const leading = [
      ...(admission?.leading ?? []),
      ...accepted.flatMap((entry) => entry.admission.leading ?? []),
    ].map((part) => ({
      text: asText(asRecord(part)?.text),
      resume: false,
    })).filter((part) => part.text);
    const preamble = [
      ...(isBuildItem(item) && !forced ? [{ text: BUILD_INSTRUCTION, resume: false }] : []),
      ...leading,
      ...contextMessages,
    ];
    for (const synthetic of preamble) {
      await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/synthetic`, {
        directory,
        method: 'POST',
        body: synthetic,
      });
    }

    if (command) {
      await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/command`, {
        directory,
        method: 'POST',
        body: {
          // OpenCode 2.0.8 renamed the command body field `command` to `name`.
          name: command.name,
          text: command.arguments,
          ...(promptFiles.length > 0 ? { files: promptFiles } : {}),
        },
      });
    } else {
      // A prompt admitted from the wire keeps the identity it arrived with: the
      // client's own message id, its file/agent/skill attachments and metadata.
      // Sending a fresh id would leave the client's optimistic row unmatched,
      // and dropping the attachments would lose what the user attached.
      //
      // Prompts merged into one lane slot are still separate admissions, so
      // each goes out with its own id and payload, in the order they arrived.
      if (accepted.length > 0) {
        for (const entry of accepted) {
          const { admission: record, messageId, command } = entry;
          // The prompt is the turn's own initiator, exactly as an ordinary
          // queued message is: stating `queue` here parked it in the session's
          // inbox instead, so the turn ran on the preamble alone and the user's
          // request was only delivered later. The idle probe is not atomic with
          // this send, so a turn that starts in the gap would swallow the build
          // as steering — that race is the price of the prompt actually
          // starting its turn. A steer the user asked for was already refused a
          // queue entry, so nothing here is a steer.
          const isCommand = Boolean(command);
          const body = { text: command ? command.arguments : asText(record.text) };
          const promptId = asNonEmptyString(messageId);
          if (command) body.name = command.name;
          else if (promptId) body.id = promptId;
          // shortcut: older admissions have only slot-wide files; retain those until the pre-fix queue drains.
          const files = record.files ?? promptFiles;
          if (files.length > 0) body.files = files;
          if ((record.agents ?? []).length > 0) body.agents = record.agents;
          if ((record.skills ?? []).length > 0) body.skills = record.skills;
          if (record.metadata) body.metadata = record.metadata;
          if (record.resume !== undefined) body.resume = record.resume;
          await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/${isCommand ? 'command' : 'prompt'}`, {
            directory,
            method: 'POST',
            body,
          });
        }
      } else {
        // Same reason as above: the serialized lane sends its prompt as the
        // turn's own initiator, never parked behind it.
        const body = { text: item.text };
        if (promptFiles.length > 0) body.files = promptFiles;
        if (item.agentMention) body.agents = [{ name: item.agentMention }];
        await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
          directory,
          method: 'POST',
          body,
        });
      }
    }
  };

  // --- project build leases ------------------------------------------------
  const setBuildProblem = (directory, message) => {
    if (buildProblems.get(directory) === message) return;
    if (message) buildProblems.set(directory, message);
    else buildProblems.delete(directory);
    broadcastGlobalUiEvent?.({ type: 'openchamber:build-queue.updated', properties: { directory } });
  };
  // Settings owns this instance-wide policy. Legacy booleans preserve
  // their behavior until a policy is selected; missing settings pause safely.
  const buildGitPolicy = () => {
    try {
      const settings = readMergedSettingsSync({ fs, path, settingsFilePath });
      if (['continue', 'commit', 'pause'].includes(settings?.buildQueueGitPolicy)) return settings.buildQueueGitPolicy;
      return settings?.buildQueueRequireCleanGit === false ? 'continue' : 'pause';
    } catch {
      return 'pause';
    }
  };
  const inspectGit = async (directory) => {
    try {
      const { stdout } = await runGit('git', ['-C', directory, 'status', '--porcelain=v1', '--untracked-files=normal'], { timeout: 12000, maxBuffer: 1024 * 1024 });
      return stdout.trim() ? 'Repository has uncommitted or untracked changes. Commit or stash them to resume queued builds.' : null;
    } catch {
      // A directory that is not a Git repository, or one where Git cannot run,
      // never satisfies the gate: name it plainly instead of a bare command error.
      return 'Cannot verify the Git working tree. Check that Git is installed, or choose Allow continue in Settings.';
    }
  };
  /**
   * A Build session of this directory that is running now but holds no lease,
   * or `null` when there is none. The lane only serializes what it dispatched
   * itself, so a build started before the project's queue was on, or by a path
   * outside the queue, would otherwise run beside a queued one.
   *
   * `unknown` (the directory list could not be read) is a third answer, and the
   * caller must not dispatch on it: an unreadable list is not "no live build".
   * Sessions the user forced are excluded — a Force exists to run beside the
   * queue, and the queue must not start waiting for it.
   */
  const findLiveBuild = async (directory) => {
    const body = asRecord(await openCodeFetch('/api/session/active').catch(() => null));
    const statuses = asRecord(body && 'data' in body ? body.data : body);
    if (!statuses) return undefined;
    const activeIds = Object.keys(statuses).filter(sessionId => asRecord(statuses[sessionId]) && !forcedBuilds.has(sessionId));
    if (activeIds.length === 0) return null;
    // v2 scopes the session list by header, not by query (see the admission
    // routes). A plain query would name OpenCode's own working directory.
    const listed = asList(asRecord(await openCodeFetch('/api/session', {
      headers: { 'x-opencode-directory': encodeURIComponent(directory) },
    }).catch(() => null))?.data);
    if (!listed) return undefined;
    const key = directoryKey(directory);
    const live = listed.map(asRecord).find(session => session && !session.parentID
      && activeIds.includes(asNonEmptyString(session.id) ?? '')
      && directoryKey(asNonEmptyString(asRecord(session.location)?.directory) ?? '') === key
      && isBuildAgentName(asNonEmptyString(session.agent) ?? ''));
    return live ? asNonEmptyString(live.id) : null;
  };
  const wakeProject = (directory) => {
    for (const [sessionId, queue] of queues) {
      // A build item needs the lane; an ordinary item may be sitting behind a
      // freeze that is being lifted now, so both kinds are armed.
      if (queue.directory === directory && queue.items.length > 0) armDispatch(sessionId);
    }
    // Every build-lane mutation ends here, and the work board reads this
    // snapshot. Announcing it here is what makes a queued or
    // completed build appear when it happened rather than on the next poll.
    broadcastGlobalUiEvent?.({ type: 'openchamber:build-queue.updated', properties: { directory } });
  };
  const scheduleBuildMonitor = (directory, delay = buildMonitorDelayMs) => {
    if (stopped || !activeBuilds.has(directory)) return;
    // A flagged lane is still monitored so a stale flag can clear itself once the
    // session goes quiet; `persistence-failed` is the exception (storage is the fix).
    if (activeBuilds.get(directory).needsReview && buildReviewBlocksUserUnfreeze(activeBuilds.get(directory))) return;
    clearTimeout(buildMonitors.get(directory));
    const timer = setTimeout(() => { buildMonitors.delete(directory); void monitorBuild(directory); }, delay);
    timer.unref?.();
    buildMonitors.set(directory, timer);
  };
  async function monitorBuild(directory) {
    const lease = activeBuilds.get(directory);
    if (stopped || !lease) return;
    // An adopted lane is not queue work: the turn belongs to a session the user
    // started outside the queue, so it releases exactly as a forced build does —
    // no review park, and no rerun. The lane only waited for this turn.
    if (lease.adopted) {
      if (now() - lease.startedAt < buildMonitorDelayMs) { scheduleBuildMonitor(directory); return; }
      const adoptedIdle = await isSessionIdle(lease.sessionId, directory);
      if (activeBuilds.get(directory) !== lease) return;
      const adoptedChildren = adoptedIdle === true ? await hasWorkingSubagents(lease.sessionId) : null;
      if (adoptedIdle !== true || adoptedChildren !== false) {
        delete lease.unconfirmedIdleAt;
        scheduleBuildMonitor(directory, buildRecheckMs);
        return;
      }
      const adoptedCompleted = await leaseTurnCompleted(lease, directory);
      if (activeBuilds.get(directory) !== lease) return;
      if (adoptedCompleted !== true) {
        lease.unconfirmedIdleAt ??= now();
        if (now() - lease.unconfirmedIdleAt < buildCompletionGraceMs) { scheduleBuildMonitor(directory, buildRecheckMs); return; }
      }
      activeBuilds.delete(directory);
      commit(lease.sessionId);
      wakeProject(directory);
      return;
    }
    if (lease.needsReview) {
      // A flagged lane is not automatically a lost cause: if its own turn is
      // verifiably finished and the session is quiet, the flag is stale and the
      // lane must let go. `persistence-failed` is the one reason that must not
      // self-clear — its cause is storage, and re-dispatching is unsafe.
      if (buildReviewBlocksUserUnfreeze(lease)) return;
      const flaggedIdle = await isSessionIdle(lease.sessionId, directory);
      if (activeBuilds.get(directory) !== lease || !lease.needsReview) return;
      if (flaggedIdle !== true) { scheduleBuildMonitor(directory, buildRecheckMs); return; }
      const flaggedChildren = await hasWorkingSubagents(lease.sessionId);
      if (activeBuilds.get(directory) !== lease || !lease.needsReview) return;
      if (flaggedChildren !== false) { scheduleBuildMonitor(directory, buildRecheckMs); return; }
      const flaggedEvidence = await leaseTurnCompleted(lease, directory);
      if (activeBuilds.get(directory) !== lease || !lease.needsReview) return;
      if (flaggedEvidence !== true) { scheduleBuildMonitor(directory, buildRecheckMs); return; }
      // The lease's own item is still waiting: releasing the lane would let the
      // tick dispatch it again, the duplicate this review exists to prevent.
      // Only dispatch-failed and restart-during-dispatch keep their item queued.
      if (queues.get(lease.sessionId)?.items.some(item => item.id === lease.itemId)) return;
      activeBuilds.delete(directory);
      commit(lease.sessionId);
      wakeProject(directory);
      return;
    }
    // The API can acknowledge the prompt before the session becomes busy.
    if (now() - lease.startedAt < buildMonitorDelayMs) { scheduleBuildMonitor(directory); return; }
    const idle = await isSessionIdle(lease.sessionId, directory);
    if (idle === false) lease.observedBusy = true;
    const children = idle === true ? await hasWorkingSubagents(lease.sessionId) : null;
    // Seeing a busy -> idle transition is NOT proof that the Build turn
    // completed: it may have been interrupted, especially across a restart.
    // Require a completed assistant response from this lease's own turn.
    let completed = false;
    let inspected = false;
    if (idle === true && children === false) {
      const evidence = await leaseTurnCompleted(lease, directory);
      completed = evidence === true;
      inspected = evidence !== null;
    }
    if (activeBuilds.get(directory) !== lease || lease.needsReview) return;
    if (idle !== true || children !== false || !inspected) delete lease.unconfirmedIdleAt;
    else if (!completed) lease.unconfirmedIdleAt ??= now();
    if (inspected && idle === true && children === false && !completed
      && (lease.restored || now() - lease.unconfirmedIdleAt >= buildCompletionGraceMs)) {
      // The previous server may have died mid-turn, or OpenCode may still be
      // starting the accepted prompt. Neither permits starting another build.
      lease.needsReview = true;
      lease.reviewReason = lease.restored ? 'restart-unconfirmed' : 'completion-unconfirmed';
      commit(lease.sessionId);
      // Keep watching: a completion that arrives late turns this flag stale, and
      // the monitor's flagged branch is what clears it.
      scheduleBuildMonitor(directory, buildRecheckMs);
      return;
    }
    if (idle !== true || children !== false || !completed) { scheduleBuildMonitor(directory, buildRecheckMs); return; }
    // The lane belongs to the session, not to one turn: what the user sent while
    // the Build ran (a queued follow-up, or a steer already inside the running
    // turn) is delivered by the session's own queue, and its lane is released
    // only once that queue is empty. A pending build of this same session is the
    // lane's own next work — the project order picks it up — so it does not hold
    // the lane.
    const remaining = queues.get(lease.sessionId)?.items ?? [];
    if (remaining.some(item => !isBuildItem(item)) || sending.has(lease.sessionId)) {
      scheduleBuildMonitor(directory, buildRecheckMs);
      return;
    }
    activeBuilds.delete(directory);
    commit(lease.sessionId);
    wakeProject(directory);
  }

  /**
   * Clears a forced build once its session's own turn is done. A forced build
   * is not queue work, so it never parks for review: a confirmed idle turn
   * clears it at once, and an idle session with no completed reply clears it
   * after the same grace the lease monitor uses. The marker stays on the board
   * for exactly as long as the session is working.
   */
  const scheduleForcedMonitor = (sessionId, delay = buildMonitorDelayMs) => {
    if (stopped || !forcedBuilds.has(sessionId)) return;
    clearTimeout(forcedMonitors.get(sessionId));
    const timer = setTimeout(() => { forcedMonitors.delete(sessionId); void monitorForcedBuild(sessionId); }, delay);
    timer.unref?.();
    forcedMonitors.set(sessionId, timer);
  };
  async function monitorForcedBuild(sessionId) {
    const forced = forcedBuilds.get(sessionId);
    if (stopped || !forced) return;
    if (now() - forced.startedAt < buildMonitorDelayMs) { scheduleForcedMonitor(sessionId); return; }
    const idle = await isSessionIdle(sessionId, forced.directory);
    const children = idle === true ? await hasWorkingSubagents(sessionId) : null;
    if (idle !== true || children !== false) {
      delete forced.unconfirmedIdleAt;
      scheduleForcedMonitor(sessionId, buildRecheckMs);
      return;
    }
    const completed = await leaseTurnCompleted({ sessionId, startedAt: forced.startedAt }, forced.directory);
    if (completed !== true) {
      forced.unconfirmedIdleAt ??= now();
      if (now() - forced.unconfirmedIdleAt < buildCompletionGraceMs) { scheduleForcedMonitor(sessionId, buildRecheckMs); return; }
    }
    forcedBuilds.delete(sessionId);
    commit(sessionId);
    wakeProject(forced.directory);
  }

  /**
   * Whether this lease's own turn already produced a completed assistant reply.
   * `null` means it could not be established (OpenCode unreachable): an
   * interrupted build must not be released on unknown evidence.
   */
  const leaseTurnCompleted = async (lease, directory) => {
    const page = await openCodeFetch(`/api/session/${encodeURIComponent(lease.sessionId)}/message`, {
      directory, query: { limit: '5' },
    }).catch(() => null);
    const messages = asList(asRecord(page)?.data);
    if (messages === null) return null;
    return messages.some(value => {
      const message = asRecord(value);
      return (message?.type === 'assistant' || message?.role === 'assistant')
        && (asCount(asRecord(message.time)?.completed) ?? 0) >= lease.startedAt;
    });
  };

  /**
   * A user abort is reported per session, but a build lease owns one turn of
   * that session. A Stop on any later turn — a follow-up question in the same
   * chat — must not strand the project's build lane, so the abort only parks a
   * lease whose own turn has no successful idle record. An unreadable history keeps
   * the conservative behavior and parks the lease for review.
   */
  const flagAbortedBuildLeases = async (sessionId) => {
    for (const [directory, lease] of Array.from(activeBuilds)) {
      if (activeBuilds.get(directory) !== lease || lease.sessionId !== sessionId || lease.needsReview) continue;
      // An adopted lane owns no queue work, so a Stop needs no review: release
      // it and let the queued build proceed.
      if (lease.adopted) {
        activeBuilds.delete(directory);
        clearTimeout(buildMonitors.get(directory));
        buildMonitors.delete(directory);
        commit(sessionId);
        wakeProject(directory);
        continue;
      }
      lease.needsReview = true;
      lease.reviewReason = 'aborted';
      clearTimeout(buildMonitors.get(directory));
      buildMonitors.delete(directory);
      commit(sessionId);
      // Park synchronously while checking history so the monitor cannot release
      // a genuinely interrupted turn based on an intermediate tool-step reply.
      const succeeded = await leaseHasSuccessfulTurn(lease, directory);
      if (stopped || activeBuilds.get(directory) !== lease) continue;
      if (!succeeded) {
        // The turn is genuinely parked for review. Keep a monitor on it anyway,
        // so a flag that later turns out to be stale can clear itself.
        scheduleBuildMonitor(directory);
        continue;
      }
      delete lease.needsReview;
      delete lease.reviewReason;
      commit(sessionId);
      scheduleBuildMonitor(directory);
    }
  };

  const leaseHasSuccessfulTurn = async (lease, directory) => {
    let cursor;
    const seen = new Set();
    for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
      const query = { limit: '50' };
      if (cursor) query.cursor = cursor;
      const page = await openCodeFetch(`/api/session/${encodeURIComponent(lease.sessionId)}/message`, {
        directory, query,
      }).catch(() => null);
      const messages = asList(asRecord(page)?.data);
      if (!messages) return false;
      for (const value of messages) {
        const message = asRecord(value);
        const created = asCount(asRecord(message?.time)?.created);
        if (created !== null && created < lease.startedAt) return false;
        if (message?.type === 'idle' && message.outcome === 'succeeded'
          && created !== null && created >= lease.startedAt) return true;
      }
      cursor = asNonEmptyString(asRecord(asRecord(page)?.cursor)?.next);
      if (!cursor || seen.has(cursor) || messages.length === 0) return false;
      seen.add(cursor);
    }
    return false;
  };

  /**
   * Whether the lease's own turn is over. `true` when a terminal `idle` record
   * for the turn exists (`succeeded` or `interrupted`), or when no such record
   * exists but nothing from the lease's own span is still streaming — that is the
   * only evidence the ambiguous-dispatch and restart parks can ever produce.
   * `false` while the lease's turn is still streaming, `null` when it cannot be
   * read. Unknown never releases a lane.
   *
   * This asks about the lease's turn, not about the session being idle this
   * instant. A later turn may have started since; that does not undo the fact
   * that the turn this lease owns is finished.
   */
  const leaseTurnOver = async (lease, directory) => {
    let cursor;
    const seen = new Set();
    for (let pageNumber = 0; pageNumber < 8; pageNumber += 1) {
      const query = { limit: '50' };
      if (cursor) query.cursor = cursor;
      const page = await openCodeFetch(`/api/session/${encodeURIComponent(lease.sessionId)}/message`, {
        directory, query,
      }).catch(() => null);
      const messages = asList(asRecord(page)?.data);
      if (!messages) return null;
      for (const value of messages) {
        const message = asRecord(value);
        const created = asCount(asRecord(message?.time)?.created);
        // Newest first: anything older than the lease's turn ends the search,
        // but only after this page's own terminal records were considered.
        if (created !== null && created < lease.startedAt) break;
        if (message?.type !== 'idle' || created === null || created < lease.startedAt) continue;
        if (message.outcome === 'succeeded' || message.outcome === 'interrupted') return true;
      }
      cursor = asNonEmptyString(asRecord(asRecord(page)?.cursor)?.next);
      if (!cursor || seen.has(cursor) || messages.length === 0) break;
      seen.add(cursor);
    }
    // No terminal record for the lease's turn. That is what parks the
    // ambiguous-dispatch and restart cases, so the fallback decides them: the
    // turn is over unless something from its own span is still streaming.
    const tail = await openCodeFetch(`/api/session/${encodeURIComponent(lease.sessionId)}/message`, {
      directory, query: { limit: '5' },
    }).catch(() => null);
    const recent = asList(asRecord(tail)?.data);
    if (recent === null) return null;
    return recent.every(value => {
      const message = asRecord(value);
      const created = asCount(asRecord(message?.time)?.created);
      // Older than the lease, or a later turn the user started: not this lease.
      if (created === null || created < lease.startedAt) return true;
      // An unfinished assistant reply from the lease's own span is still live.
      return !(message?.type === 'assistant' && asCount(asRecord(message.time)?.completed) === null);
    });
  };

  const resolveBuild = async (directory, action, itemId) => {
    await load();
    const lease = activeBuilds.get(directory);
    // A named item must be the lease's own; with no lease it may be an
    // unresolved Force, checked below.
    if (itemId && lease && lease.itemId !== itemId) throw httpError('The build queue changed. Refresh it before continuing.', 409);
    // An unconfirmed Force has its own recovery: the item was not taken by the
    // queue, so nothing is released, and the item stays queued. Only a human
    // clearing the marker moves it on.
    if (!lease && itemId) {
      const reserved = Array.from(forceReservations.entries()).find(([, value]) => value.itemId === itemId && value.directory === directory);
      if (reserved) {
        if (action !== 'skip') throw httpError('No recoverable build or invalid action', 409);
        forceReservations.delete(reserved[0]);
        commit(reserved[0]);
        wakeProject(directory);
        return buildSnapshot();
      }
    }
    if (!lease && action === 'retry' && buildProblems.has(directory)) {
      preparationFailures.delete(directory);
      setBuildProblem(directory, null);
      wakeProject(directory);
      return buildSnapshot();
    }
    if (!lease?.needsReview || (action !== 'skip' && action !== 'retry')) throw httpError('No recoverable build or invalid action', 409);
    // The gate is the lease's own turn, not instant session idleness. Requiring
    // idleness was unsatisfiable: a message delivered into the session after the
    // freeze kept it busy, so the button that clears the freeze could never run.
    const turnOver = await leaseTurnOver(lease, directory);
    if (turnOver !== true) throw httpError('Build session may still be running; cannot resolve yet', 409);
    if (activeBuilds.get(directory) !== lease) throw httpError('The build queue changed. Refresh it before continuing.', 409);
    const queue = queues.get(lease.sessionId);
    const queuedItem = queue?.items.find(item => item.id === lease.itemId);
    if (action === 'retry' && !queuedItem) throw httpError('Build was already dispatched. Resubmit from its chat if needed; choose Continue to release queue', 409);
    // A turn is running now: adopt it as this lane's active build rather than
    // releasing into a void. The running turn becomes the work the lane tracks,
    // and the queue resumes when it ends. Unreadable status keeps the freeze.
    const idle = await isSessionIdle(lease.sessionId, directory);
    if (idle === null) throw httpError('Build session may still be running; cannot resolve yet', 409);
    if (idle === false) {
      delete lease.needsReview;
      delete lease.reviewReason;
      lease.adoptedAt = now();
      lease.phase = 'running';
      lease.observedBusy = true;
      commit(lease.sessionId);
      wakeProject(directory);
      scheduleBuildMonitor(directory);
      return buildSnapshot();
    }
    if (action === 'skip' && queuedItem) setQueueItems(lease.sessionId, directory, queue.items.filter(item => item.id !== lease.itemId));
    activeBuilds.delete(directory);
    buildProblems.delete(directory);
    commit(lease.sessionId);
    wakeProject(directory);
    return buildSnapshot();
  };

  /**
   * Starts one waiting build now, outside the queue lane. The project's lease,
   * its dispatch order and the Git policy are all skipped: the item is sent to
   * its own idle session, removed from the queue, and tracked separately so the
   * gate stays free and the rest of the queue keeps flowing. It never gates
   * dispatch and is never parked for review, because the queue does not own it.
   */
  const forceDispatch = async (directoryInput, sessionIdInput, itemIdInput) => {
    const directory = asNonEmptyString(directoryInput);
    const sessionId = requireSessionId(sessionIdInput);
    const itemId = asNonEmptyString(itemIdInput);
    if (!directory || !itemId) throw new TypeError('directory and itemId are required');
    await load();
    const queue = queues.get(sessionId);
    if (!queue || queue.directory !== directory) throw httpError('Build not found in this project', 404);
    const item = queue.items.find(entry => entry.id === itemId);
    if (!item) throw httpError('Build is no longer queued', 404);
    if (!isBuildItem(item)) throw httpError('Only a queued build can be forced', 409);
    if (sending.has(sessionId) || forcedBuilds.has(sessionId) || forceReservations.has(sessionId)) throw httpError('This build is already being sent', 409);
    const idle = await isSessionIdle(sessionId, directory);
    if (idle === null) throw httpError('The session status is unavailable; try again before forcing this build', 409);
    if (idle !== true) throw httpError('The session is busy; wait for its turn to finish before forcing this build', 409);
    const subagents = await hasWorkingSubagents(sessionId);
    if (subagents === null) throw httpError('The session status is unavailable; try again before forcing this build', 409);
    if (subagents !== false) throw httpError('The session has running subagents; wait before forcing this build', 409);
    // Re-read after the probes: the queue may have changed while they ran, and
    // a simultaneous Force may have reserved the session in the meantime.
    if (sending.has(sessionId) || forcedBuilds.has(sessionId) || forceReservations.has(sessionId)) throw httpError('This build is already being sent', 409);
    const current = queues.get(sessionId)?.items.find(entry => entry.id === itemId);
    if (!current || current.id !== item.id) throw httpError('The build queue changed. Refresh it and try again.', 409);

    // Reserve before the send, synchronously, so a second Force cannot pass its
    // own probe-to-reserve gap and dispatch the same item twice.
    const reservation = {
      directory, itemId: item.id, startedAt: now(), needsReview: true, reviewReason: 'force-unconfirmed',
      content: item.content.slice(0, BUILD_SNAPSHOT_CHAR_LIMIT), model: queuedModelOf(item),
    };
    forceReservations.set(sessionId, reservation);
    sending.set(sessionId, item.id);
    broadcast(sessionId);
    // The reservation must be durable before the prompt can be accepted, or a
    // crash would replay a Force with no record of it.
    commit(sessionId);
    await writePromise;
    if (persistenceError) {
      forceReservations.delete(sessionId);
      sending.delete(sessionId);
      commit(sessionId);
      throw httpError('Cannot persist the build queue. Check server storage before continuing.', 503);
    }
    try {
      // `sendItem` resolves the Auto sentinel itself, so a forced send switches
      // the session's model and agent the same way a queued one does.
      await sendItem(sessionId, directory, current, undefined, { forced: true });
    } catch (error) {
      sending.delete(sessionId);
      // The reservation stays: the prompt may have started, and neither a
      // re-force nor an automatic retry may risk a second dispatch. The item
      // stays queued and the board shows the resolution control.
      commit(sessionId);
      wakeProject(directory);
      // A timed-out or rejected prompt may still have started. There is no
      // lease to park, so the item stays queued and the caller is warned.
      return { revision, warning: 'The prompt was not confirmed. It may have started; open the session before forcing it again.' };
    }
    sending.delete(sessionId);
    const after = queues.get(sessionId);
    if (after) setQueueItems(sessionId, after.directory, after.items.filter(entry => entry.id !== item.id), 'sent');
    forceReservations.delete(sessionId);
    forcedBuilds.set(sessionId, {
      directory, startedAt: reservation.startedAt,
      content: current.content.slice(0, BUILD_SNAPSHOT_CHAR_LIMIT), model: queuedModelOf(current),
    });
    commit(sessionId);
    wakeProject(directory);
    scheduleForcedMonitor(sessionId);
    return buildSnapshot();
  };

  /**
   * A review flag whose cause was server storage, not the build itself. Clearing
   * it would unfreeze the lane onto an enqueue that cannot be persisted either,
   * so a dispatch could run with no durable record of it. Storage is the fix.
   */
  const buildReviewBlocksUserUnfreeze = (lease) => lease.reviewReason === 'persistence-failed';

  /**
   * A lane waiting for a human decision, held by the given session. Its session
   * stops taking delivery while it waits: a message that reaches the session
   * anyway is what made the freeze unresolvable, because a busy session cannot
   * pass the release gate.
   */
  const buildLaneFrozenFor = (directory, sessionId) => {
    const lease = activeBuilds.get(directory);
    return lease?.needsReview === true && lease.sessionId === sessionId;
  };

  /**
   * A Build prompt submitted to the session that holds the project's lease is the
   * user unfreezing that lease from the chat it belongs to: whatever the
   * uncertain dispatch did, they want this build instead. This is the same
   * decision the work board's Continue makes (it drops the frozen item), so it
   * uses the same effect. Only the lease-holding session can unfreeze itself, and
   * only a Build prompt counts; a plain message or another session's build is not
   * an instruction to carry on building.
   *
   * The lease is released here without waiting for idleness. Dispatch timing is
   * the tick's job: if the ambiguous build really did start, the session is busy
   * and the new item waits for the turn to end rather than steering into it.
   */
  const unfreezeBuildLeaseForSession = (sessionId, directory) => {
    const lease = activeBuilds.get(directory);
    if (!lease || lease.sessionId !== sessionId || !lease.needsReview) return false;
    if (buildReviewBlocksUserUnfreeze(lease)) return false;
    // The frozen item is what the user is replacing. Dropping it matches the
    // Continue action; appending to it would resume the abandoned prompt.
    const queue = queues.get(sessionId);
    if (queue) setQueueItems(sessionId, directory, queue.items.filter(item => item.id !== lease.itemId));
    clearTimeout(buildMonitors.get(directory));
    buildMonitors.delete(directory);
    buildProblems.delete(directory);
    activeBuilds.delete(directory);
    console.log(`[build-queue] unfroze ${directory} from a build prompt in ${sessionId}`);
    return true;
  };

  const reorderBuilds = async (directory, ids) => {
    await load();
    if (!asNonEmptyString(directory) || !Array.isArray(ids)) throw new TypeError('directory and ordered ids required');
    const pending = pendingBuilds(directory);
    if (ids.length !== pending.length || new Set(ids).size !== ids.length || pending.some(entry => !ids.includes(entry.item.id))) throw new TypeError('provide all queued build ids exactly once');
    const byId = new Map(pending.map(entry => [entry.item.id, entry]));
    // Prevent a second build in one session from overtaking its own head.
    for (const sessionId of new Set(pending.map(entry => entry.sessionId))) {
      const before = pending.filter(entry => entry.sessionId === sessionId).map(entry => entry.item.id);
      const after = ids.filter(id => byId.get(id)?.sessionId === sessionId);
      if (before.some((id, index) => after[index] !== id)) throw httpError('Cannot reorder builds within a session', 409);
    }
    const touched = new Set();
    for (const id of ids) { const entry = byId.get(id); entry.item.buildOrder = nextBuildOrder++; touched.add(entry.sessionId); }
    for (const sessionId of touched) commit(sessionId);
    wakeProject(directory);
    return buildSnapshot();
  };

  const setBuildPaused = async (sessionIdInput, itemIdInput, paused) => {
    const sessionId = requireSessionId(sessionIdInput);
    const itemId = asNonEmptyString(itemIdInput);
    if (!itemId || (paused !== true && paused !== false)) throw new TypeError('itemId and paused state required');
    await load();
    const queue = queues.get(sessionId);
    const directory = queue?.directory ?? directories.get(sessionId);
    if (sending.get(sessionId) === itemId || activeBuilds.get(directory)?.itemId === itemId) throw httpError('Cannot pause a build that has started', 409);
    const item = queue?.items.find(entry => entry.id === itemId);
    if (!item || !isBuildItem(item)) throw httpError('Queued build not found', 404);
    if (paused) item.buildPaused = true;
    else delete item.buildPaused;
    commit(sessionId);
    if (!paused) armDispatch(sessionId);
    return buildSnapshot();
  };

  // --- dispatch loop -------------------------------------------------------

  // Parking blocks dispatch during asynchronous idle and storage checks.
  const parkingSessions = new Set();
  const clearTimer = (sessionId) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      timers.delete(sessionId);
    }
  };

  const clearHoldTimer = (sessionId) => {
    const timer = holdTimers.get(sessionId);
    if (timer) clearTimeout(timer);
    holdTimers.delete(sessionId);
  };

  const scheduleHoldExpiry = (sessionId, expiresAt) => {
    clearHoldTimer(sessionId);
    const timer = setTimeout(() => {
      if (holdTimers.get(sessionId) !== timer) return;
      holdTimers.delete(sessionId);
      if (holds.get(sessionId) !== expiresAt) return;
      const remaining = expiresAt - now();
      if (remaining > 0) {
        scheduleHoldExpiry(sessionId, expiresAt);
        return;
      }
      holds.delete(sessionId);
      armDispatch(sessionId);
    }, Math.max(0, expiresAt - now()));
    timer.unref?.();
    holdTimers.set(sessionId, timer);
  };

  const armDispatch = (sessionId, delayMs = dispatchQuietMs) => {
    if (stopped || !queues.has(sessionId)) return;
    clearTimer(sessionId);
    const timer = setTimeout(() => {
      timers.delete(sessionId);
      tick(sessionId).catch((error) => {
        console.warn('[message-queue] dispatch tick failed:', error?.message ?? error);
      });
    }, Math.max(0, delayMs));
    timer.unref?.();
    timers.set(sessionId, timer);
  };

  const isHeld = (sessionId) => {
    const expiresAt = holds.get(sessionId);
    if (expiresAt === undefined) return false;
    if (expiresAt > now()) return true;
    holds.delete(sessionId);
    clearHoldTimer(sessionId);
    return false;
  };

  async function tick(sessionId) {
    if (stopped) return;
    const queue = queues.get(sessionId);
    if (!queue || queue.items.length === 0 || sending.has(sessionId) || parkingSessions.has(sessionId) || isHeld(sessionId)) return;

    // A lane frozen for review also freezes the queue of the session that owns
    // it. Delivering there is what made Continue impossible: the freeze could not
    // stop the message, and the message kept the session busy, so the release
    // gate had nothing idle to see. The items stay put and go out once the lane
    // is resolved. Other sessions in the project are untouched — only the lane's
    // own session is what the user is being asked about.
    const frozenOwner = buildLaneFrozenFor(queue.directory, sessionId);
    if (frozenOwner) {
      armDispatch(sessionId, buildRecheckMs);
      return;
    }

    const abortHoldUntil = (abortedAt.get(sessionId) ?? 0) + abortHoldMs;
    if (abortHoldUntil > now()) {
      armDispatch(sessionId, abortHoldUntil - now());
      return;
    }

    const head = queue.items[0];
    if (isBuildItem(head) && (head.buildPaused || reservedForItem(sessionId, head.id))) return;
    const failure = failures.get(sessionId);
    if (failure && failure.itemId !== head.id) failures.delete(sessionId);
    else if (failure && failure.nextAttemptAt > now()) {
      armDispatch(sessionId, failure.nextAttemptAt - now());
      return;
    }

    const idle = await isSessionIdle(sessionId, queue.directory);
    if (idle === null) {
      if (head.scheduledTask && validateScheduledTaskTarget) {
        try {
          await validateScheduledTaskTarget(head.scheduledTask.projectId, sessionId);
        } catch (error) {
          if (error?.statusCode === 404 || error?.statusCode === 409) {
            const after = queues.get(sessionId);
            if (after) setQueueItems(sessionId, after.directory, after.items.filter((entry) => entry.id !== head.id), 'failed', error.message);
            commit(sessionId);
            armDispatch(sessionId);
            return;
          }
        }
      }
      armDispatch(sessionId, retryDelayMs(1));
      return;
    }
    // Busy: the next idle status event re-arms the loop.
    if (!idle) return;

    // A queued message waits for the whole turn. A parent idles while a
    // background subagent works and runs again when OpenCode hands the
    // result back, so the turn is only over once no subagent runs. That rerun
    // re-arms through its idle event; the recheck covers a missed one.
    const subagentsWorking = await hasWorkingSubagents(sessionId);
    if (subagentsWorking !== false) {
      armDispatch(sessionId, subagentsWorking === null ? retryDelayMs(1) : SUBAGENT_RECHECK_MS);
      return;
    }

    // Re-read after the awaits — the user may have edited the queue meanwhile.
    const current = queues.get(sessionId);
    const item = current?.items[0];
    if (!item || item.id !== head.id || sending.has(sessionId) || parkingSessions.has(sessionId)) return;
    let buildSelection;

    if (isBuildItem(item)) {
      // Only the oldest head among all sessions for this project may start.
      // The lease is claimed synchronously after the asynchronous probes.
      if (activeBuilds.has(current.directory) || preparingBuilds.has(current.directory)) return;
      if (runnableBuilds(current.directory)[0]?.item.id !== item.id) return;
      // Nothing in this lane, but a Build of this project may be running outside
      // it — started before the queue was on, or by a path the queue does not
      // cover. Adopt that turn as this lane's active build instead of starting a
      // second one beside it: the queued build waits, and the adopted lane
      // releases itself when that turn ends. A directory whose live builds could
      // not be read is unknown, so dispatch waits rather than guessing.
      {
        const liveSessionId = await findLiveBuild(current.directory);
        if (liveSessionId === undefined) { armDispatch(sessionId, buildRecheckMs); return; }
        // Re-check after the awaits: another tick may have claimed the lane, or
        // the build may have finished while the list was being read.
        if (activeBuilds.has(current.directory) || preparingBuilds.has(current.directory)) return;
        if (liveSessionId) {
          activeBuilds.set(current.directory, { sessionId: liveSessionId, startedAt: now(), phase: 'running', adopted: true });
          commit(sessionId);
          scheduleBuildMonitor(current.directory);
          wakeProject(current.directory);
          return;
        }
      }
      // Claim preparation before awaiting Git or the model. The dispatch lease
      // follows preparation and remains durable before the prompt is sent.
      const policy = buildGitPolicy();
      if (policy !== 'commit') preparationFailures.delete(current.directory);
      if (policy === 'commit') {
        if (preparationFailures.get(current.directory) === item.id) {
          armDispatch(sessionId, buildRecheckMs);
          return;
        }
        const preparation = { itemId: item.id, phase: 'initializing' };
        preparingBuilds.set(current.directory, preparation);
        setBuildProblem(current.directory, null);
        const isCurrent = () => !stopped && queues.get(sessionId)?.items[0]?.id === item.id
          && queues.get(sessionId)?.items[0]?.buildPaused !== true
          && runnableBuilds(current.directory)[0]?.item.id === item.id && !activeBuilds.has(current.directory);
        try {
          if (!prepareBuildCommit) throw new Error('Automatic commit preparation is unavailable on this server.');
          const config = item.sendConfig;
          buildSelection = await resolveAutoSelection?.({
            sessionId,
            directory: current.directory,
            model: { id: config.modelID, providerID: config.providerID, ...(config.variant ? { variant: config.variant } : {}) },
            agent: config.agent,
            requestText: `${item.text}${attachmentHint({ files: item.attachments.map(toPromptFile) })}`.trim(),
          });
          const result = await prepareBuildCommit(current.directory, {
            sendConfig: buildSelection ? {
              ...config, providerID: buildSelection.model.providerID, modelID: buildSelection.model.id,
            } : config,
            isCurrent,
            onProgress: phase => {
              preparation.phase = phase;
              broadcastGlobalUiEvent?.({ type: 'openchamber:build-queue.updated', properties: { directory: current.directory } });
            },
          });
          if (result) buildCommits.set(current.directory, result);
          const stillIdle = await isSessionIdle(sessionId, current.directory);
          const stillNoSubagents = stillIdle === true ? await hasWorkingSubagents(sessionId) : null;
          if (stillIdle !== true || stillNoSubagents !== false) {
            armDispatch(sessionId, buildRecheckMs);
            return;
          }
        } catch (error) {
          preparationFailures.set(current.directory, item.id);
          setBuildProblem(current.directory, error.message || 'Automatic commit preparation failed. Retry from the Work Board.');
          armDispatch(sessionId, buildRecheckMs);
          return;
        } finally {
          preparingBuilds.delete(current.directory);
          broadcastGlobalUiEvent?.({ type: 'openchamber:build-queue.updated', properties: { directory: current.directory } });
          wakeProject(current.directory);
        }
        if (!isCurrent()) { wakeProject(current.directory); return; }
      } else if (policy === 'pause') {
        const problem = checkBuildGit ? await checkBuildGit(current.directory) : await inspectGit(current.directory);
        if (problem) { setBuildProblem(current.directory, problem); armDispatch(sessionId, buildRecheckMs); return; }
      } else if (buildProblems.has(current.directory)) {
        setBuildProblem(current.directory, null);
      }
      if (parkingSessions.has(sessionId) || activeBuilds.has(current.directory) || queues.get(sessionId)?.items[0]?.id !== item.id || runnableBuilds(current.directory)[0]?.item.id !== item.id) return;
      setBuildProblem(current.directory, null);
      activeBuilds.set(current.directory, {
        sessionId, itemId: item.id, startedAt: now(), phase: 'dispatching',
        // What the running card says about itself after the item is gone: the
        // prompt that started it and the model it runs on.
        content: item.content.slice(0, BUILD_SNAPSHOT_CHAR_LIMIT), model: queuedModelOf(item),
      });
      commit(sessionId);
      // The dispatch lease must be durable BEFORE the prompt can be accepted.
      // Otherwise a crash could replay a build without any record of it.
      await writePromise;
      const lease = activeBuilds.get(current.directory);
      if (persistenceError) {
        // Never send without an on-disk lease: a crash here risks replay.
        if (lease?.itemId === item.id) {
          lease.needsReview = true;
          lease.reviewReason = 'persistence-failed';
        }
        setBuildProblem(current.directory, 'Cannot persist the build queue. Check server storage before continuing.');
        return;
      }
      if (stopped || parkingSessions.has(sessionId) || lease?.itemId !== item.id || queues.get(sessionId)?.items[0]?.id !== item.id) return;
    }

    // The first activity check can be separated from dispatch by Git checks or
    // durable lease writes. Recheck immediately before marking the item in
    // flight or changing session state. OpenCode has no atomic send-if-idle
    // operation, so a direct send can still begin after this check.
    const finalIdle = await isSessionIdle(sessionId, current.directory);
    const finalSubagents = finalIdle === true ? await hasWorkingSubagents(sessionId) : null;
    const held = isHeld(sessionId);
    const latestQueue = queues.get(sessionId);
    const stillHead = latestQueue?.items[0]?.id === item.id;
    const stillOldestBuild = !isBuildItem(item) || runnableBuilds(current.directory)[0]?.item.id === item.id;
    const leaseBeforeSend = activeBuilds.get(current.directory);
    const releaseBuildLease = () => {
      if (!isBuildItem(item) || leaseBeforeSend?.itemId !== item.id) return;
      activeBuilds.delete(current.directory);
      commit(sessionId);
      wakeProject(current.directory);
    };
    if (finalIdle !== true || finalSubagents !== false || held || stopped || parkingSessions.has(sessionId)
      || sending.has(sessionId) || !stillHead || !stillOldestBuild) {
      releaseBuildLease();
      if (latestQueue?.items.length && !held && !stopped) {
        armDispatch(sessionId, finalSubagents === true ? SUBAGENT_RECHECK_MS : retryDelayMs(1));
      }
      return;
    }

    sending.set(sessionId, item.id);
    broadcast(sessionId);
    try {
      if (item.scheduledTask) {
        try {
          await beforeScheduledTaskSend?.(sessionId, current.directory, item);
        } catch (error) {
          if (error?.statusCode !== 404 && error?.statusCode !== 409) throw error;
          sending.delete(sessionId);
          const after = queues.get(sessionId);
          if (after) setQueueItems(sessionId, after.directory, after.items.filter((entry) => entry.id !== item.id), 'failed', error.message);
          failures.delete(sessionId);
          commit(sessionId);
          armDispatch(sessionId);
          return;
        }
      }
      await sendItem(sessionId, current.directory, item, buildSelection);
      const after = queues.get(sessionId);
      if (after) setQueueItems(sessionId, after.directory, after.items.filter((entry) => entry.id !== item.id), 'sent');
      // The admission is settled: a replay of the client's prompt id would now
      // duplicate work OpenCode has already run.
      forgetAdmittedWhenSent(sessionId, item);
      failures.delete(sessionId);
      sending.delete(sessionId);
      commit(sessionId);
      try {
        onPromptSent?.(sessionId);
      } catch {
        // bookkeeping only
      }
      if (isBuildItem(item)) {
        const lease = activeBuilds.get(current.directory);
        if (lease?.itemId === item.id) {
          lease.phase = 'running';
          commit(sessionId);
        }
        scheduleBuildMonitor(current.directory);
      }
      console.log(`[message-queue] sent queued message to ${sessionId}`);
    } catch (error) {
      // A timed-out or rejected prompt may nevertheless have been accepted.
      // Do not retry a build automatically: it could execute the same changes twice.
      if (isBuildItem(item) && activeBuilds.get(current.directory)?.itemId === item.id) {
        const lease = activeBuilds.get(current.directory);
        lease.needsReview = true;
        lease.reviewReason = 'dispatch-failed';
        sending.delete(sessionId);
        console.warn(`[build-queue] dispatch uncertain for ${sessionId}:`, error?.message ?? error);
        commit(sessionId);
        return;
      }
      sending.delete(sessionId);
      const count = (failure?.itemId === item.id ? failure.failures : 0) + 1;
      const nextAttemptAt = now() + retryDelayMs(count);
      failures.set(sessionId, { itemId: item.id, failures: count, nextAttemptAt });
      console.warn(`[message-queue] send to ${sessionId} failed (attempt ${count}):`, error?.message ?? error);
      broadcast(sessionId);
      armDispatch(sessionId, nextAttemptAt - now());
    }
  }

  const reconcileAll = () => {
    for (const directory of activeBuilds.keys()) scheduleBuildMonitor(directory);
    for (const sessionId of queues.keys()) {
      if (!timers.has(sessionId)) armDispatch(sessionId, dispatchQuietMs);
    }
  };

  // --- public mutations ----------------------------------------------------

  const requireSessionId = (sessionId) => {
    if (!isValidSessionId(sessionId)) throw new TypeError('sessionId is invalid');
    return sessionId;
  };

  const enqueue = async (sessionIdInput, directoryInput, itemInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    const directory = asNonEmptyString(directoryInput);
    if (!directory) throw new TypeError('directory is required');
    const parsed = parseQueuedItemInput(itemInput);
    await load();
    if (parkingSessions.has(sessionId)) throw httpError('Session is being parked to To-do', 409);
    const originalQueue = queues.get(sessionId);
    if (originalQueue && originalQueue.directory !== directory) throw httpError('session queue directory mismatch', 409);
    // One lane slot per session. A Build prompt only takes a place in the
    // project order when its session does not already hold one: the session
    // that owns the lane collects its next prompt in its own queue until the
    // lane is released, and a session that already waits appends to the item it
    // holds. Either way the session keeps one row and one place.
    if (isBuildItem(parsed)) {
      // A review-frozen lease owned by this session is unfrozen by this prompt
      // before anything else looks at the lane. That drops the frozen item, so
      // this session's queue is re-read below: the slot and lease are what is
      // left after the unfreeze, not what was there before it.
      unfreezeBuildLeaseForSession(sessionId, directory);
      const lease = activeBuilds.get(directory);
      if (lease?.sessionId === sessionId && buildReviewBlocksUserUnfreeze(lease)) {
        throw httpError('Build queue storage is unavailable. Repair server storage before submitting another build.', 503);
      }
      const current = queues.get(sessionId);
      const slot = (current?.items ?? []).find(entry => isBuildItem(entry));
      if (lease?.sessionId === sessionId && !lease.needsReview) {
        // The lane is already this session's: the prompt needs no second place
        // in the order, and the session's own queue delivers it in turn.
        delete parsed.buildQueue;
      } else if (slot && sending.get(sessionId) !== slot.id) {
        appendToBuildSlot(slot, parsed);
        const result = commit(sessionId);
        armDispatch(sessionId);
        return { ...result, itemId: slot.id };
      } else if (slot) {
        // The held item is mid-send and cannot take more text without losing
        // it; this prompt joins the session's own queue instead.
        delete parsed.buildQueue;
      }
    }
    if (originalQueue && originalQueue.items.length >= MAX_ITEMS_PER_SESSION && originalQueue.items.some(item => isBuildItem(item) || item.scheduledTask)) throw httpError('queue is full; managed jobs cannot be discarded', 409);
    if (parsed.scheduledTask) {
      for (const queue of queues.values()) {
        if (queue.items.some((entry) => entry.scheduledTask?.projectId === parsed.scheduledTask.projectId && entry.scheduledTask.taskId === parsed.scheduledTask.taskId)) {
          throw httpError('task is already queued', 409);
        }
      }
    }
    // Managed jobs must never be truncated or evicted to make room.
    if (parsed.scheduledTask || (parsed.buildQueue && parsed.sendConfig.agent?.toLowerCase() === 'build')) {
      if ((queues.get(sessionId)?.items.length ?? 0) >= MAX_ITEMS_PER_SESSION || (!queues.has(sessionId) && queues.size >= MAX_SESSIONS)) {
        throw httpError('message queue is full', 409);
      }
    }
    const item = {
      id: `queued-${now()}-${Math.random().toString(36).slice(2, 9)}`,
      createdAt: now(),
      ...parsed,
      ...(parsed.buildQueue ? { buildOrder: nextBuildOrder++ } : {}),
    };
    const existing = queues.get(sessionId);
    const items = [...(existing?.items ?? []), item].slice(-MAX_ITEMS_PER_SESSION);
    setQueueItems(sessionId, directory, items);
    directories.set(sessionId, directory);
    if (queues.size > MAX_SESSIONS) {
      const oldest = Array.from(queues.entries())
        .filter(([id, queue]) => id !== sessionId && !sending.has(id) && !queue.items.some(item => isBuildItem(item) || item.scheduledTask))
        .sort((left, right) => (left[1].items[0]?.createdAt ?? 0) - (right[1].items[0]?.createdAt ?? 0))
        .slice(0, queues.size - MAX_SESSIONS);
      for (const [staleId] of oldest) {
        setQueueItems(staleId, directories.get(staleId), []);
        clearTimer(staleId);
        broadcast(staleId);
        directories.delete(staleId);
      }
    }
    const result = commit(sessionId);
    // The session may already be idle (queued from a busy-looking composer
    // right as the turn ended); the tick verifies before sending.
    armDispatch(sessionId);
    if (isBuildItem(item)) wakeProject(directory);
    return { ...result, itemId: item.id };
  };

  /**
   * Removes the item and hands its full payload back so the composer can
   * restore a cancelled message instead of losing what the user typed.
   */
  const remove = async (sessionIdInput, itemId) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    if (sending.get(sessionId) === itemId || Array.from(activeBuilds.values()).some(lease => lease.sessionId === sessionId && lease.itemId === itemId)) throw httpError('build is active or awaiting review', 409);
    const queue = queues.get(sessionId);
    const removed = queue?.items.find((item) => item.id === itemId);
    if (!removed) {
      return { revision, session: sessionSnapshot(sessionId) };
    }
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id !== itemId));
    // Cancelling the item drops the uncertain Force that pointed at it.
    if (forceReservations.get(sessionId)?.itemId === itemId) forceReservations.delete(sessionId);
    const updated = commit(sessionId);
    if (isBuildItem(removed)) wakeProject(queue.directory);
    return { ...updated, item: removed };
  };

  /** Removes the item and hands its full payload (attachments included) back. */
  const take = async (sessionIdInput, itemId) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    if (sending.get(sessionId) === itemId) throw httpError('message is being sent', 409);
    const queue = queues.get(sessionId);
    const item = queue?.items.find((entry) => entry.id === itemId);
    if (!queue || !item) throw httpError('queued message not found', 404);
    if (item.scheduledTask || isBuildItem(item)) throw httpError('managed queued builds cannot be taken', 409);
    setQueueItems(sessionId, queue.directory, queue.items.filter((entry) => entry.id !== itemId));
    return { ...commit(sessionId), item };
  };

  /** Removes every item not currently being sent and hands them back in order. */
  const takeAll = async (sessionIdInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId), items: [] };
    const sendingId = sending.get(sessionId) ?? null;
    const items = queue.items.filter((item) => item.id !== sendingId && !item.scheduledTask && !isBuildItem(item));
    if (items.length === 0) return { revision, session: sessionSnapshot(sessionId), items: [] };
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id === sendingId || item.scheduledTask || isBuildItem(item)));
    return { ...commit(sessionId), items };
  };

  const reorder = async (sessionIdInput, itemIds) => {
    const sessionId = requireSessionId(sessionIdInput);
    if (!asList(itemIds) || itemIds.some((id) => !asNonEmptyString(id))) {
      throw new TypeError('itemIds must be a list of ids');
    }
    await load();
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId) };
    if (queue.items.some(isBuildItem)) throw httpError('Use the project build queue to reorder builds', 409);
    const byId = new Map(queue.items.map((item) => [item.id, item]));
    if (itemIds.length !== byId.size || new Set(itemIds).size !== itemIds.length || itemIds.some((id) => !byId.has(id))) {
      throw new TypeError('itemIds must list every queued message exactly once');
    }
    queues.set(sessionId, { directory: queue.directory, items: itemIds.map((id) => byId.get(id)) });
    return commit(sessionId);
  };

  const clear = async (sessionIdInput) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    const queue = queues.get(sessionId);
    if (!queue) return { revision, session: sessionSnapshot(sessionId) };
    // Never drop a message already handed to OpenCode: its send resolves and
    // must find its entry.
    const sendingId = sending.get(sessionId) ?? null;
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id === sendingId || isBuildItem(item)));
    clearTimer(sessionId);
    const result = commit(sessionId);
    wakeProject(queue.directory);
    return result;
  };

  const setHold = (sessionIdInput, held, ttlMs = HOLD_DEFAULT_TTL_MS) => {
    const sessionId = requireSessionId(sessionIdInput);
    if (held !== true && held !== false) throw new TypeError('held must be a boolean');
    if (held) {
      const ttl = Math.min(asCount(ttlMs) || HOLD_DEFAULT_TTL_MS, HOLD_MAX_TTL_MS);
      const expiresAt = now() + ttl;
      holds.set(sessionId, expiresAt);
      scheduleHoldExpiry(sessionId, expiresAt);
      clearTimer(sessionId);
      return { held: true, expiresAt };
    }
    holds.delete(sessionId);
    clearHoldTimer(sessionId);
    armDispatch(sessionId);
    return { held: false, expiresAt: null };
  };

  // --- events --------------------------------------------------------------

  const processPayload = (value) => {
    const payload = asRecord(value);
    if (stopped || !payload) return;

    const deletedSessionId = extractDeletedSessionId(payload);
    if (deletedSessionId) {
      holds.delete(deletedSessionId);
      clearHoldTimer(deletedSessionId);
      for (const [directory, lease] of activeBuilds) {
        if (lease.sessionId !== deletedSessionId) continue;
        activeBuilds.delete(directory);
        clearTimeout(buildMonitors.get(directory));
        buildMonitors.delete(directory);
        commit(deletedSessionId);
        wakeProject(directory);
      }
      if (forcedBuilds.has(deletedSessionId)) {
        forcedBuilds.delete(deletedSessionId);
        clearTimeout(forcedMonitors.get(deletedSessionId));
        forcedMonitors.delete(deletedSessionId);
      }
      // The session is gone, so its uncertain Force can never be resolved in
      // that chat; the queued item is dropped with the session below.
      if (forceReservations.has(deletedSessionId)) {
        const reservation = forceReservations.get(deletedSessionId);
        forceReservations.delete(deletedSessionId);
        commit(deletedSessionId);
        wakeProject(reservation.directory);
      }
      if (!queues.has(deletedSessionId)) return;
      setQueueItems(deletedSessionId, directories.get(deletedSessionId), []);
      clearTimer(deletedSessionId);
      failures.delete(deletedSessionId);
      commit(deletedSessionId);
      directories.delete(deletedSessionId);
      return;
    }

    const status = extractSessionStatus(payload);
    if (status) {
      if (status.type !== 'idle') {
        for (const lease of activeBuilds.values()) if (lease.sessionId === status.sessionId) lease.observedBusy = true;
      }
      if (!queues.has(status.sessionId)) return;
      if (status.type === 'idle') armDispatch(status.sessionId);
      else clearTimer(status.sessionId);
      return;
    }

    const abortedSessionId = extractAbortedSessionId(payload);
    if (abortedSessionId) {
      if (queues.has(abortedSessionId)) abortedAt.set(abortedSessionId, now());
      void flagAbortedBuildLeases(abortedSessionId);
      return;
    }

    const assistant = extractAssistantMessageUpdate(payload);
    if (assistant && queues.has(assistant.sessionId)) {
      // A completed reply without a following idle status (missed event)
      // must still drain the queue; the tick verifies idleness itself.
      if (assistant.completed && !timers.has(assistant.sessionId)) armDispatch(assistant.sessionId);
    }
  };

  const processEvent = (event) => {
    // The hub translates v2 wire events into the server's vocabulary once.
    for (const payload of event?.translated?.() ?? []) processPayload(payload);
  };

  const start = () => {
    const unsubscribeEvent = globalEventHub.subscribeEvent(processEvent);
    const unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
      if (status?.type === 'connect') reconcileAll();
    });
    void load()
      .then(() => {
        if (queues.size > 0) console.log(`[message-queue] restored queues for ${queues.size} session(s)`);
        reconcileAll();
      })
      .catch((error) => {
        console.warn('[message-queue] failed to load queue file:', error?.message ?? error);
      });
    return () => {
      unsubscribeEvent();
      unsubscribeStatus();
    };
  };

  const stop = () => {
    stopped = true;
    for (const timer of buildMonitors.values()) clearTimeout(timer);
    buildMonitors.clear();
    for (const timer of forcedMonitors.values()) clearTimeout(timer);
    forcedMonitors.clear();
    forcedBuilds.clear();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    for (const timer of holdTimers.values()) clearTimeout(timer);
    holdTimers.clear();
  };

  /** Coordinate a To-do save with dispatch; never abort a running turn. */
  const parkSession = async (sessionIdInput, directoryInput, saveCard) => {
    const sessionId = requireSessionId(sessionIdInput);
    const directory = asNonEmptyString(directoryInput);
    if (!directory || typeof saveCard !== 'function') throw new TypeError('directory and saveCard are required');
    await load();
    if (parkingSessions.has(sessionId)) throw httpError('Session is already being parked', 409);
    parkingSessions.add(sessionId);
    clearTimer(sessionId);
    try {
      const queue = queues.get(sessionId);
      if (queue && queue.directory !== directory) throw httpError('session queue directory mismatch', 409);
      if (sending.has(sessionId) || Array.from(activeBuilds.values()).some(lease => lease.sessionId === sessionId)) {
        throw httpError('Session has an active or uncertain build', 409);
      }
      if (queue?.items.length) {
        throw httpError('Remove queued messages from the Build Queue before saving to To-Do', 409);
      }
      const idle = await isSessionIdle(sessionId, directory);
      const subagents = idle === true ? await hasWorkingSubagents(sessionId) : null;
      if (idle !== true || subagents !== false) throw httpError('Session is active or its idle status is unavailable', 409);
      // Dispatch is blocked by parkingSessions while this check and save run.
      if (queues.get(sessionId)?.items.length) throw httpError('Remove queued messages before saving to To-Do', 409);
      if (sending.has(sessionId) || Array.from(activeBuilds.values()).some(lease => lease.sessionId === sessionId)) {
        throw httpError('Session started executing while parking', 409);
      }
      return await saveCard([]);

    } finally {
      parkingSessions.delete(sessionId);
      armDispatch(sessionId);
    }
  };

  const cancelScheduledTask = async (projectId, taskId) => {
    await load();
    for (const [sessionId, queue] of queues) {
      const items = queue.items.filter((item) => item.scheduledTask?.projectId !== projectId || item.scheduledTask.taskId !== taskId || sending.get(sessionId) === item.id);
      if (items.length === queue.items.length) continue;
      setQueueItems(sessionId, queue.directory, items);
      commit(sessionId);
      armDispatch(sessionId);
    }
  };

  // --- admission -----------------------------------------------------------

  /**
   * The queue entry already holding this prompt id, or a settled marker when it
   * was dispatched and removed. A replayed prompt must never be admitted twice:
   * the client may have lost the response to an admission the server completed.
   */
  const admittedMessageIds = new Map(); // messageId → { sessionId, itemId } (settled history)

  /** Every wire id an item still owes, from whichever shape stored it. */
  const acceptedIdsOf = (item) => {
    const ids = (item.acceptedPrompts ?? []).map((entry) => asNonEmptyString(entry?.messageId)).filter(Boolean);
    if (item.messageId && !ids.includes(item.messageId)) ids.unshift(item.messageId);
    return ids;
  };

  const findAdmitted = (messageId) => {
    if (!messageId) return null;
    for (const [sessionId, queue] of queues) {
      // A merged slot holds several ids; a repeat of any of them is a repeat.
      const item = queue.items.find((entry) => acceptedIdsOf(entry).includes(messageId));
      if (item) return { sessionId, itemId: item.id, settled: false };
    }
    return admittedMessageIds.get(messageId) ?? null;
  };

  const settleAdmitted = (messageId) => {
    if (!messageId) return;
    admittedMessageIds.set(messageId, { sessionId: null, itemId: null, settled: true });
    while (admittedMessageIds.size > MAX_SESSIONS * MAX_ITEMS_PER_SESSION) {
      admittedMessageIds.delete(admittedMessageIds.keys().next().value);
    }
  };

  /**
   * Admits a prompt the server classified as project Build work. Idempotent by
   * the client's own prompt id: a repeat of an id the queue already holds (or
   * already dispatched) answers `{ admitted: false }` instead of queueing twice.
   */
  const admitBuildPrompt = async ({ sessionId: sessionIdInput, directory: directoryInput, item: itemInput }) => {
    const sessionId = requireSessionId(sessionIdInput);
    const directory = asNonEmptyString(directoryInput);
    if (!directory) throw new TypeError('directory is required');
    const parsed = parseQueuedItemInput(itemInput);
    if (!parsed.messageId) throw new TypeError('an admitted prompt needs its messageId');
    await load();
    const existing = findAdmitted(parsed.messageId);
    if (existing) {
      return { admitted: false, settled: existing.settled === true, itemId: existing.itemId ?? null };
    }
    parsed.buildQueue = true;
    const result = await enqueue(sessionId, directory, parsed);
    return { admitted: true, settled: false, itemId: result.itemId, revision: result.revision };
  };

  /** Settles the admission record once its item leaves the queue. */
  const forgetAdmittedWhenSent = (sessionId, sentItem) => {
    for (const messageId of acceptedIdsOf(sentItem)) settleAdmitted(messageId);
  };

  // --- queue settings ------------------------------------------------------

  /**
   * The project identity a directory belongs to: its canonical directory and
   * the project id its setting is stored under. The directory is resolved the
   * way every other server route resolves one, so a worktree keeps its own
   * queue while sharing its project's enablement.
   */
  const projectIdentityOf = async (input) => {
    const directory = asNonEmptyString(asRecord(input)?.directory);
    if (!resolveProjectIdentity) return { directory, projectId: null };
    try {
      return await resolveProjectIdentity({ directory }) ?? { directory, projectId: null };
    } catch {
      return { directory, projectId: null };
    }
  };

  // Settings and admission share one chain: a prompt admitted while the switch
  // is being turned off must see one of the two orders, never a torn read.
  let admissionChain = Promise.resolve();
  const withAdmission = (work) => {
    const next = admissionChain.catch(() => undefined).then(work);
    admissionChain = next.catch(() => undefined);
    return next;
  };

  /**
   * Whether the project's build queue is on: `true`, `false`, or `null` when
   * the stored value could not be read. `null` is not "off": the settings
   * endpoint answers it as enabled, while an execution-starting admission
   * treats it as a possible bypass and refuses (see the admission guard).
   */
  const queueEnabledStateFor = async (identity) => {
    const projectId = asNonEmptyString(asRecord(identity)?.projectId);
    // No project to place the directory in, or no store: the setting is not
    // this server's to know, so the queue is on and nothing is refused by it.
    if (!projectConfigRuntime || !projectId) return true;
    try {
      const stored = await projectConfigRuntime.readBuildQueueEnabled(projectId);
      return stored !== false;
    } catch {
      return null;
    }
  };

  const queueEnabledFor = async (identity) => (await queueEnabledStateFor(identity)) !== false;

  const readQueueSettings = async (identityInput) => {
    const identity = await projectIdentityOf(identityInput);
    if (!asNonEmptyString(identity?.projectId)) throw httpError('A project directory is required', 400);
    return { enabled: await queueEnabledFor(identity) };
  };

  const writeQueueSettings = async (identityInput, enabled) => withAdmission(async () => {
    if (enabled !== true && enabled !== false) throw new TypeError('enabled must be a boolean');
    const identity = await projectIdentityOf(identityInput);
    const projectId = asNonEmptyString(identity?.projectId);
    if (!projectId) throw httpError('A project directory is required', 400);
    if (!projectConfigRuntime) throw httpError('This server cannot store the build queue setting', 503);
    // Turning the queue off while work is in flight would strand the build that
    // is running and the builds waiting behind it; both must be finished or
    // cancelled first, so the user is told rather than silently losing them.
    if (enabled === false) {
      const directory = asNonEmptyString(identity.directory);
      const holding = directory && activeBuilds.has(directory)
        ? 'A build is running for this project.'
        : (preparingBuilds.has(directory ?? '') ? 'A build is being prepared for this project.' : null);
      if (holding) throw httpError(`${holding} Finish or cancel it before turning the queue off.`, 409);
      const queued = pendingBuilds(directory || undefined).length;
      if (queued > 0) throw httpError(`${queued} queued build(s) must be cancelled or started before turning the queue off.`, 409);
      for (const sessionId of sending.keys()) {
        if (queues.get(sessionId)?.items.some((item) => isBuildItem(item))) {
          throw httpError('A build is being dispatched for this project. Wait for it before turning the queue off.', 409);
        }
      }
    }
    await projectConfigRuntime.setBuildQueueEnabled(projectId, enabled);
    return { enabled };
  });

  /** The admission path the prompt route uses, serialized with the setting. */
  const admitSubmission = (input) => withAdmission(() => admitBuildPrompt(input));

  /**
   * Whether the queue holds anything for this session that a direct API call
   * must not walk away from: a waiting item, an in-flight send, or a build lease
   * this session owns.
   */
  const hasManagedWorkFor = (sessionId) => {
    const queue = queues.get(sessionId);
    if (queue && queue.items.length > 0) return true;
    if (sending.has(sessionId)) return true;
    if (forceReservations.has(sessionId)) return true;
    for (const lease of activeBuilds.values()) if (lease.sessionId === sessionId) return true;
    return false;
  };

  return {
    load,
    snapshot,
    buildSnapshot,
    reorderBuilds,
    setBuildPaused,
    resolveBuild,
    forceDispatch,
    sessionSnapshot,
    enqueue,
    admitBuildPrompt,
    admitSubmission,
    resolveProjectIdentity: projectIdentityOf,
    hasManagedWorkFor,
    /** `true`/`false`, or `null` when the stored value could not be read. */
    queueEnabledStateFor,
    readQueueSettings,
    writeQueueSettings,
    cancelScheduledTask,
    parkSession,
    remove,
    take,
    takeAll,
    reorder,
    clear,
    setHold,
    processPayload,
    start,
    stop,
    /** Drains the pending write; tests and shutdown use it. */
    flush: () => Promise.all([writePromise, admissionChain]).then(() => undefined),
  };
}

export function registerMessageQueueRoutes(app, runtime) {
  const respondError = (res, error, fallback) => {
    const status = error instanceof TypeError ? 400 : (Number.isInteger(error?.status) ? error.status : 500);
    res.status(status).json({ error: error?.message ?? fallback });
  };

  app.get('/api/build-queue', async (_req, res) => {
    try { await runtime.load(); res.json(runtime.buildSnapshot()); }
    catch (error) { respondError(res, error, 'Failed to load build queue'); }
  });
  // The project's queue enablement. `{ directory }` is the only input on the
  // read, and the answer is `{ enabled }`; a directory the server cannot place
  // in a project is a 400, never a silent `true`.
  app.get('/api/build-queue/settings', async (req, res) => {
    try { res.json(await runtime.readQueueSettings({ directory: req.query?.directory })); }
    catch (error) { respondError(res, error, 'Failed to read build queue settings'); }
  });
  app.put('/api/build-queue/settings', async (req, res) => {
    try {
      res.json(await runtime.writeQueueSettings(
        { directory: req.body?.directory },
        req.body?.enabled,
      ));
    } catch (error) { respondError(res, error, 'Failed to save build queue settings'); }
  });
  app.post('/api/build-queue/resolve', async (req, res) => {
    try { res.json(await runtime.resolveBuild(req.body?.directory, req.body?.action, req.body?.itemId)); }
    catch (error) { respondError(res, error, 'Failed to resolve build queue'); }
  });
  app.post('/api/build-queue/force', async (req, res) => {
    try { res.json(await runtime.forceDispatch(req.body?.directory, req.body?.sessionId, req.body?.itemId)); }
    catch (error) { respondError(res, error, 'Failed to force build'); }
  });
  app.put('/api/build-queue/order', async (req, res) => {
    try { res.json(await runtime.reorderBuilds(req.body?.directory, req.body?.ids)); }
    catch (error) { respondError(res, error, 'Failed to reorder build queue'); }
  });
  app.put('/api/build-queue/sessions/:sessionId/items/:itemId/pause', async (req, res) => {
    try { res.json(await runtime.setBuildPaused(req.params.sessionId, req.params.itemId, req.body?.paused)); }
    catch (error) { respondError(res, error, 'Failed to update queued build'); }
  });
  app.delete('/api/build-queue/sessions/:sessionId/items/:itemId', async (req, res) => {
    try { res.json(await runtime.remove(req.params.sessionId, req.params.itemId)); }
    catch (error) { respondError(res, error, 'Failed to cancel queued build'); }
  });

  app.get('/api/message-queue', async (_req, res) => {
    try {
      await runtime.load();
      res.json(runtime.snapshot());
    } catch (error) {
      respondError(res, error, 'Failed to load message queue');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/items', async (req, res) => {
    try {
      if (req.body?.item?.scheduledTask) throw new TypeError('scheduledTask is server-owned');
      res.json(await runtime.enqueue(req.params.sessionId, req.body?.directory, req.body?.item));
    } catch (error) {
      respondError(res, error, 'Failed to queue message');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/take', async (req, res) => {
    try {
      res.json(await runtime.takeAll(req.params.sessionId));
    } catch (error) {
      respondError(res, error, 'Failed to take queued messages');
    }
  });

  app.put('/api/message-queue/sessions/:sessionId/order', async (req, res) => {
    try {
      res.json(await runtime.reorder(req.params.sessionId, req.body?.itemIds));
    } catch (error) {
      respondError(res, error, 'Failed to reorder queue');
    }
  });

  app.put('/api/message-queue/sessions/:sessionId/hold', async (req, res) => {
    try {
      await runtime.load();
      res.json(runtime.setHold(req.params.sessionId, req.body?.held, req.body?.ttlMs));
    } catch (error) {
      respondError(res, error, 'Failed to update queue hold');
    }
  });

  app.delete('/api/message-queue/sessions/:sessionId', async (req, res) => {
    try {
      res.json(await runtime.clear(req.params.sessionId));
    } catch (error) {
      respondError(res, error, 'Failed to clear queue');
    }
  });

  app.post('/api/message-queue/sessions/:sessionId/items/:itemId/take', async (req, res) => {
    try {
      res.json(await runtime.take(req.params.sessionId, req.params.itemId));
    } catch (error) {
      respondError(res, error, 'Failed to take queued message');
    }
  });

  app.delete('/api/message-queue/sessions/:sessionId/items/:itemId', async (req, res) => {
    try {
      res.json(await runtime.remove(req.params.sessionId, req.params.itemId));
    } catch (error) {
      respondError(res, error, 'Failed to remove queued message');
    }
  });
}
