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
import path from 'path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const runGit = promisify(execFile);
import { assertPromptResponse } from '../opencode/prompt-response.js';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import { createSessionActivityProbe } from '../opencode/session-activity.js';

const QUEUE_FILE_NAME = 'message-queue.json';
const QUEUE_FILE_VERSION = 2;
const BUILD_RECHECK_MS = 5000;
const BUILD_INSTRUCTION = 'This build is serialized with other builds in this repository. Implement the requested work, run appropriate tests, and commit only your own changes when complete. Do not stage unrelated files, force reset, or silently discard changes. If you cannot safely commit, explicitly explain why; the next queued build will wait for a clean working tree.';

const MAX_SESSIONS = 50;
const MAX_ITEMS_PER_SESSION = 20;
const CONTENT_CHAR_LIMIT = 200_000;

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
  if (!text.trim() && attachments.length === 0 && context.length === 0) {
    throw new TypeError('item needs text, attachments, or context');
  }
  const sendConfig = parseSendConfig(raw.sendConfig);
  const provenance = asRecord(raw.scheduledTask);
  const projectId = asNonEmptyString(provenance?.projectId);
  const taskId = asNonEmptyString(provenance?.taskId);
  if (provenance && (!projectId || !taskId)) throw new TypeError('invalid scheduledTask provenance');
  if (!sendConfig && !provenance) throw new TypeError('item sendConfig with providerID and modelID is required');
  const item = { content, text };
  if (raw.buildQueue === true) item.buildQueue = true;
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
    return { id, createdAt: asCount(raw.createdAt) ?? Date.now(), ...parseQueuedItemInput(raw), ...(raw.buildQueue === true ? { buildOrder: asCount(raw.buildOrder) ?? 0 } : {}) };
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
  return publicItem;
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
  buildMonitorDelayMs = 2500,
  buildRecheckMs = BUILD_RECHECK_MS,
}) {
  const filePath = path.join(dataDir, QUEUE_FILE_NAME);

  /** sessionId → { directory, items } */
  const queues = new Map();
  // One build lease per project directory, held through the entire agent turn.
  const activeBuilds = new Map();
  const buildProblems = new Map();
  const buildMonitors = new Map();
  let nextBuildOrder = 1;
  let revision = 0;
  let loadPromise = null;
  let writePromise = Promise.resolve();
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
    activeBuilds: Object.fromEntries(activeBuilds),
    sessions: Object.fromEntries(
      Array.from(queues.entries()).map(([sessionId, queue]) => [sessionId, { directory: queue.directory, items: queue.items }]),
    ),
  });

  const readFile = async () => {
    let raw;
    try {
      raw = await fs.promises.readFile(filePath, 'utf8');
    } catch (error) {
      if (asRecord(error)?.code === 'ENOENT') return { sessions: {}, revision: 0, activeBuilds: {}, nextBuildOrder: 1 };
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
      return { sessions: {}, revision: 0, activeBuilds: {}, nextBuildOrder: 1 };
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
    return { sessions, revision: asCount(stored.revision) ?? 0, activeBuilds: asRecord(stored.activeBuilds) ?? {}, nextBuildOrder: asCount(stored.nextBuildOrder) ?? 1 };
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
              activeBuilds.set(directory, { ...value, observedBusy: true, ...(hasQueuedItem ? { needsReview: true, reviewReason: 'restart-during-dispatch' } : {}) });
            }
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
      })
      .catch((error) => {
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
  const pendingBuilds = (directory) => Array.from(queues.entries())
    .flatMap(([sessionId, queue]) => queue.items.filter(item => item.buildQueue && (!directory || queue.directory === directory))
      .map(item => ({ sessionId, directory: queue.directory, item })))
    .sort((a, b) => a.item.buildOrder - b.item.buildOrder || a.item.createdAt - b.item.createdAt || a.item.id.localeCompare(b.item.id));
  const buildSnapshot = () => ({
    revision,
    active: Array.from(activeBuilds.entries()).map(([directory, lease]) => ({ directory, ...lease, retryAvailable: queues.get(lease.sessionId)?.items.some(item => item.id === lease.itemId) === true })),
    queued: pendingBuilds().map(({ sessionId, directory, item }, index) => ({ id: item.id, sessionId, directory, content: item.content.slice(0, 300), createdAt: item.createdAt, order: index })),
    issues: [
      ...Array.from(buildProblems.entries()).filter(([directory]) => pendingBuilds(directory).length > 0).map(([directory, issue]) => ({ directory, issue })),
      ...Array.from(activeBuilds.entries()).filter(([, lease]) => lease.needsReview)
        .map(([directory, lease]) => ({ directory, issue: lease.reviewReason === 'aborted'
          ? 'The previous build was stopped. Review its changes before continuing.'
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

  const openCodeFetch = async (fetchPath, { directory, method = 'GET', body, query } = {}) => {
    const base = buildOpenCodeUrl(fetchPath, '');
    const params = new URLSearchParams(query || {});
    if (directory) params.set('directory', directory);
    const search = params.toString();
    const headers = { Accept: 'application/json', ...getOpenCodeAuthHeaders() };
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
    return activityProbe.hasWorkingChildren(sessionId, statuses);
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

  const sendItem = async (sessionId, directory, item) => {
    const { providerID, modelID, variant } = item.sendConfig;
    let agent = item.sendConfig.agent;
    let model = { id: modelID, providerID, ...(variant ? { variant } : {}) };
    const promptFiles = item.attachments.map(toPromptFile);
    const contextMessages = item.context.flatMap(toContextMessages);

    // Jev routing, when the queued send named the Auto sentinel. A failure
    // inside resolves to the fallback model; only a missing fallback throws.
    const routed = providerID && modelID ? await resolveAutoSelection?.({
      sessionId,
      directory,
      model,
      agent,
      requestText: item.text,
    }) : null;
    if (routed) {
      model = routed.model;
      agent = routed.agent ?? agent;
    }

    // v2 selects model and agent on the session, not per prompt: the choice is
    // switched once and then persists.
    if (!item.scheduledTask || (providerID && modelID)) await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/model`, {
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
    const command = await resolveSlashCommand(item.text, directory);

    // Standing project context rides the send exactly as a UI send would
    // attach it; a failed lookup sends without it rather than not at all.
    const knowledge = sessionKnowledgeRuntime
      ? await sessionKnowledgeRuntime.resolvePendingForSession(sessionId, directory)
        .catch(() => ({ text: '', signature: '' }))
      : { text: '', signature: '' };

    // Same order as a UI send: everything attached to the message is admitted
    // before the message itself, so the model reads it as background. This
    // holds for a command too: its route takes file attachments only, and
    // sending "/name args" as a prompt instead would skip the template
    // OpenCode 2.x expands only on the command route.
    const preamble = [...(item.buildQueue ? [{ text: BUILD_INSTRUCTION, resume: false }] : []), ...contextMessages];
    if (knowledge.text) preamble.push({ text: knowledge.text, resume: false });
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
      await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
        directory,
        method: 'POST',
        body: {
          text: item.text,
          ...(promptFiles.length > 0 ? { files: promptFiles } : {}),
          ...(item.agentMention ? { agents: [{ name: item.agentMention }] } : {}),
        },
      });
    }
    if (knowledge.text && sessionKnowledgeRuntime) {
      // After the send is accepted, so a rejected dispatch carries it again.
      await sessionKnowledgeRuntime.recordDelivered(sessionId, directory, knowledge.signature).catch(() => undefined);
    }
  };

  // --- project build leases ------------------------------------------------
  const setBuildProblem = (directory, message) => {
    if (buildProblems.get(directory) === message) return;
    if (message) buildProblems.set(directory, message);
    else buildProblems.delete(directory);
    broadcastGlobalUiEvent?.({ type: 'openchamber:build-queue.updated', properties: { directory } });
  };
  const inspectGit = async (directory) => {
    try {
      const { stdout } = await runGit('git', ['-C', directory, 'status', '--porcelain=v1', '--untracked-files=normal'], { timeout: 12000, maxBuffer: 1024 * 1024 });
      return stdout.trim() ? 'Repository has uncommitted or untracked changes. Commit or stash them to resume queued builds.' : null;
    } catch (error) {
      return 'Cannot verify Git working tree (' + String(error.message ?? error).slice(0, 160) + ').';
    }
  };
  const wakeProject = (directory) => {
    for (const [sessionId, queue] of queues) {
      if (queue.directory === directory && queue.items.some(item => item.buildQueue)) armDispatch(sessionId);
    }
  };
  const scheduleBuildMonitor = (directory, delay = buildMonitorDelayMs) => {
    if (stopped || !activeBuilds.has(directory) || activeBuilds.get(directory).needsReview) return;
    clearTimeout(buildMonitors.get(directory));
    const timer = setTimeout(() => { buildMonitors.delete(directory); void monitorBuild(directory); }, delay);
    timer.unref?.();
    buildMonitors.set(directory, timer);
  };
  async function monitorBuild(directory) {
    const lease = activeBuilds.get(directory);
    if (stopped || !lease || lease.needsReview) return;
    // The API can acknowledge the prompt before the session becomes busy.
    if (now() - lease.startedAt < buildMonitorDelayMs) { scheduleBuildMonitor(directory); return; }
    const idle = await isSessionIdle(lease.sessionId, directory);
    if (idle === false) lease.observedBusy = true;
    const children = idle === true ? await hasWorkingSubagents(lease.sessionId) : null;
    // Do not release a lease based on an idle snapshot before OpenCode has
    // actually started this prompt (the POST acknowledgement can precede it).
    let completed = lease.observedBusy === true;
    if (idle === true && children === false && !completed) {
      const page = await openCodeFetch(`/api/session/${encodeURIComponent(lease.sessionId)}/message`, {
        directory, query: { limit: '5' },
      }).catch(() => null);
      completed = (asList(asRecord(page)?.data) ?? []).some(value => {
        const message = asRecord(value);
        return (message?.type === 'assistant' || message?.role === 'assistant')
          && (asCount(asRecord(message.time)?.completed) ?? 0) >= lease.startedAt;
      });
    }
    if (activeBuilds.get(directory) !== lease) return;
    if (idle !== true || children !== false || !completed) { scheduleBuildMonitor(directory, buildRecheckMs); return; }
    activeBuilds.delete(directory);
    commit(lease.sessionId);
    wakeProject(directory);
  }
  const resolveBuild = async (directory, action) => {
    await load();
    const lease = activeBuilds.get(directory);
    if (!lease?.needsReview || (action !== 'skip' && action !== 'retry')) throw httpError('No recoverable build or invalid action', 409);
    const idle = await isSessionIdle(lease.sessionId, directory);
    const children = idle === true ? await hasWorkingSubagents(lease.sessionId) : null;
    if (idle !== true || children !== false) throw httpError('Build session may still be running; cannot resolve yet', 409);
    const queue = queues.get(lease.sessionId);
    const queuedItem = queue?.items.find(item => item.id === lease.itemId);
    if (action === 'retry' && !queuedItem) throw httpError('Build was already dispatched. Resubmit from its chat if needed; choose Continue to release queue', 409);
    if (action === 'skip' && queuedItem) setQueueItems(lease.sessionId, directory, queue.items.filter(item => item.id !== lease.itemId));
    activeBuilds.delete(directory);
    buildProblems.delete(directory);
    commit(lease.sessionId);
    wakeProject(directory);
    return buildSnapshot();
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

  // --- dispatch loop -------------------------------------------------------

  const clearTimer = (sessionId) => {
    const existing = timers.get(sessionId);
    if (existing) {
      clearTimeout(existing);
      timers.delete(sessionId);
    }
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
    return false;
  };

  async function tick(sessionId) {
    if (stopped) return;
    const queue = queues.get(sessionId);
    if (!queue || queue.items.length === 0 || sending.has(sessionId) || isHeld(sessionId)) return;

    const abortHoldUntil = (abortedAt.get(sessionId) ?? 0) + abortHoldMs;
    if (abortHoldUntil > now()) {
      armDispatch(sessionId, abortHoldUntil - now());
      return;
    }

    const head = queue.items[0];
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
    if (!item || item.id !== head.id || sending.has(sessionId)) return;

    if (item.buildQueue) {
      // Only the oldest head among all sessions for this project may start.
      // The lease is claimed synchronously after the asynchronous probes.
      if (activeBuilds.has(current.directory)) return;
      if (pendingBuilds(current.directory)[0]?.item.id !== item.id) return;
      const problem = checkBuildGit ? await checkBuildGit(current.directory) : await inspectGit(current.directory);
      if (problem) { setBuildProblem(current.directory, problem); armDispatch(sessionId, buildRecheckMs); return; }
      if (activeBuilds.has(current.directory) || queues.get(sessionId)?.items[0]?.id !== item.id || pendingBuilds(current.directory)[0]?.item.id !== item.id) return;
      setBuildProblem(current.directory, null);
      activeBuilds.set(current.directory, { sessionId, itemId: item.id, startedAt: now(), phase: 'dispatching' });
      commit(sessionId);
      // The dispatch lease must be durable BEFORE the prompt can be accepted.
      // Otherwise a crash could replay a build without any record of it.
      await writePromise;
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
      await sendItem(sessionId, current.directory, item);
      const after = queues.get(sessionId);
      if (after) setQueueItems(sessionId, after.directory, after.items.filter((entry) => entry.id !== item.id), 'sent');
      failures.delete(sessionId);
      sending.delete(sessionId);
      commit(sessionId);
      try {
        onPromptSent?.(sessionId);
      } catch {
        // bookkeeping only
      }
      if (item.buildQueue) {
        const lease = activeBuilds.get(current.directory);
        if (lease?.itemId === item.id) {
          lease.phase = 'running';
          commit(sessionId);
        }
        scheduleBuildMonitor(current.directory);
      }
      console.log(`[message-queue] sent queued message to ${sessionId}`);
    } catch (error) {
      if (item.buildQueue && activeBuilds.get(current.directory)?.itemId === item.id) {
        activeBuilds.delete(current.directory);
        wakeProject(current.directory);
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
    const originalQueue = queues.get(sessionId);
    if (originalQueue && originalQueue.directory !== directory) throw httpError('session queue directory mismatch', 409);
    if (originalQueue && originalQueue.items.length >= MAX_ITEMS_PER_SESSION && originalQueue.items.some(item => item.buildQueue || item.scheduledTask)) throw httpError('queue is full; managed jobs cannot be discarded', 409);
    if (parsed.scheduledTask) {
      for (const queue of queues.values()) {
        if (queue.items.some((entry) => entry.scheduledTask?.projectId === parsed.scheduledTask.projectId && entry.scheduledTask.taskId === parsed.scheduledTask.taskId)) {
          throw httpError('task is already queued', 409);
        }
      }
    }
    // Managed jobs must never be truncated or evicted to make room.
    if (parsed.scheduledTask || parsed.buildQueue) {
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
        .filter(([id, queue]) => id !== sessionId && !sending.has(id) && !queue.items.some(item => item.buildQueue || item.scheduledTask))
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
    return { ...result, itemId: item.id };
  };

  const remove = async (sessionIdInput, itemId) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    if (sending.get(sessionId) === itemId || Array.from(activeBuilds.values()).some(lease => lease.sessionId === sessionId && lease.itemId === itemId)) throw httpError('build is active or awaiting review', 409);
    const queue = queues.get(sessionId);
    if (!queue || !queue.items.some((item) => item.id === itemId)) {
      return { revision, session: sessionSnapshot(sessionId) };
    }
    const wasBuild = queue.items.some(item => item.id === itemId && item.buildQueue);
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id !== itemId));
    const updated = commit(sessionId);
    if (wasBuild) wakeProject(queue.directory);
    return updated;
  };

  /** Removes the item and hands its full payload (attachments included) back. */
  const take = async (sessionIdInput, itemId) => {
    const sessionId = requireSessionId(sessionIdInput);
    await load();
    if (sending.get(sessionId) === itemId) throw httpError('message is being sent', 409);
    const queue = queues.get(sessionId);
    const item = queue?.items.find((entry) => entry.id === itemId);
    if (!queue || !item) throw httpError('queued message not found', 404);
    if (item.scheduledTask || item.buildQueue) throw httpError('managed queued builds cannot be taken', 409);
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
    const items = queue.items.filter((item) => item.id !== sendingId && !item.scheduledTask && !item.buildQueue);
    if (items.length === 0) return { revision, session: sessionSnapshot(sessionId), items: [] };
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id === sendingId || item.scheduledTask || item.buildQueue));
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
    if (queue.items.some(item => item.buildQueue)) throw httpError('Use the project build queue to reorder builds', 409);
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
    setQueueItems(sessionId, queue.directory, queue.items.filter((item) => item.id === sendingId || item.buildQueue));
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
      holds.set(sessionId, now() + ttl);
      clearTimer(sessionId);
      return { held: true, expiresAt: holds.get(sessionId) };
    }
    holds.delete(sessionId);
    armDispatch(sessionId);
    return { held: false, expiresAt: null };
  };

  // --- events --------------------------------------------------------------

  const processPayload = (value) => {
    const payload = asRecord(value);
    if (stopped || !payload) return;

    const deletedSessionId = extractDeletedSessionId(payload);
    if (deletedSessionId) {
      for (const [directory, lease] of activeBuilds) {
        if (lease.sessionId !== deletedSessionId) continue;
        activeBuilds.delete(directory);
        clearTimeout(buildMonitors.get(directory));
        buildMonitors.delete(directory);
        commit(deletedSessionId);
        wakeProject(directory);
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
      for (const lease of activeBuilds.values()) {
        if (lease.sessionId !== abortedSessionId) continue;
        lease.needsReview = true;
        lease.reviewReason = 'aborted';
        for (const [directory, monitored] of activeBuilds) {
          if (monitored !== lease) continue;
          clearTimeout(buildMonitors.get(directory));
          buildMonitors.delete(directory);
        }
        commit(abortedSessionId);
      }
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
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
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

  return {
    load,
    snapshot,
    buildSnapshot,
    reorderBuilds,
    resolveBuild,
    sessionSnapshot,
    enqueue,
    cancelScheduledTask,
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
    flush: () => writePromise,
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
  app.post('/api/build-queue/resolve', async (req, res) => {
    try { res.json(await runtime.resolveBuild(req.body?.directory, req.body?.action)); }
    catch (error) { respondError(res, error, 'Failed to resolve build queue'); }
  });
  app.put('/api/build-queue/order', async (req, res) => {
    try { res.json(await runtime.reorderBuilds(req.body?.directory, req.body?.ids)); }
    catch (error) { respondError(res, error, 'Failed to reorder build queue'); }
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
