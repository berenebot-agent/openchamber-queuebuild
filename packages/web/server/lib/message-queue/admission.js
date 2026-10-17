// Queue admission for a prompt that reaches the OpenCode route while the
// project's build queue is on.
//
// A browser can post to `/api/session/:id/prompt` directly, so the only
// trustworthy statement about a submission is the server's own: the session's
// agent, the project's enablement, and the shape of the request. The composer
// marks a submission it wants queued explicitly; without that mark nothing here
// changes and the prompt reaches OpenCode untouched.
//
// The marked prompt is captured as it arrived — id, text, files, agents,
// skills, metadata — and dispatched later by the queue with that same identity,
// so the client's optimistic row reconciles when the real admission lands.
// Repeats of one id are deduplicated durably, so a lost response cannot admit
// the same turn twice.
//
// Request bodies and OpenCode's answers are parsed here, at the boundary that
// reads them; the classification below works on the parsed values.

import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { unwrapOpenCodeResponse } from '../opencode/response-envelope.js';
import {
  classifySubmission,
  commandAgentOf,
  isBuildAgentName,
  modelFactSchema,
  parseAgentFacts,
  parseCommandFacts,
  parseSessionFact,
  slashCommandNameOf,
} from './build-classification.js';

export const ADMIT_HEADER = 'x-openchamber-build-queue';

// A `buildQueue` flag on a client body is a display hint, never authority.
// A request may ask to be admitted only through the explicit header.
export const isAdmitRequest = (req) => req?.get?.(ADMIT_HEADER) === 'admit';

/** The wire shape of an admitted submission; unknown keys are dropped. */
export const promptBodySchema = z.object({
  id: z.string().min(1).optional(),
  text: z.string().optional(),
  name: z.string().min(1).optional(),
  delivery: z.enum(['steer', 'queue']).optional(),
  resume: z.boolean().optional(),
  files: z.array(z.object({ uri: z.string().min(1), name: z.string().optional() })).optional(),
  agents: z.array(z.unknown()).optional(),
  skills: z.array(z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The item a queued prompt becomes. It keeps the wire fields the dispatch must
 * reproduce, so nothing about the turn changes between admission and send.
 * A body whose files do not parse is refused by admission.
 */
export const buildQueuedItemFromPrompt = ({ body, directory, sessionId, kind, sendConfig = {}, leading = [] }) => {
  const parsed = promptBodySchema.safeParse(body);
  if (!parsed.success) return null;
  const request = parsed.data;
  const text = request.text ?? '';
  const files = (request.files ?? []).map((file) => ({
    id: `file-${file.uri.slice(-48)}`,
    filename: file.name || file.uri.split('/').pop() || 'attachment',
    mimeType: 'application/octet-stream',
    size: 0,
    source: 'server',
    dataUrl: file.uri,
  }));
  const admission = {
    sessionId,
    directory,
    kind,
    name: request.name,
    text,
    files: request.files ?? [],
    delivery: request.delivery,
    agents: request.agents ?? [],
    skills: request.skills ?? [],
    metadata: request.metadata,
    resume: request.resume === undefined ? undefined : request.resume === true,
    leading,
  };
  const messageId = request.id ?? (kind === 'command' ? `command-${randomUUID()}` : undefined);
  return {
    content: kind === 'command' ? `/${request.name}${text ? ` ${text}` : ''}` : text,
    text,
    attachments: files,
    context: [],
    sendConfig,
    messageId,
    admission,
    acceptedPrompts: [{ messageId, admission }],
  };
};

/**
 * Reads live classification and selection facts. A failed read answers `null`
 * so admission can refuse unverifiable Build work.
 */
export const createAdmissionFacts = ({ buildOpenCodeUrl, getOpenCodeAuthHeaders, fetchImpl = fetch }) => {
  const openCodeFetch = async (fetchPath, { directory } = {}) => {
    const response = await fetchImpl(buildOpenCodeUrl(fetchPath, ''), {
      headers: {
        Accept: 'application/json',
        ...getOpenCodeAuthHeaders(),
        ...(directory ? { 'x-opencode-directory': encodeURIComponent(directory), 'x-opencode-directory-encoding': 'uri' } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`OpenCode ${fetchPath} failed with ${response.status}`);
    return unwrapOpenCodeResponse(await response.json());
  };
  const sessionSummary = async (sessionId, directory) => {
    const body = await openCodeFetch(`/api/session/${encodeURIComponent(sessionId)}`, { directory }).catch(() => null);
    const parsed = parseSessionFact(body);
    return parsed.success ? parsed.data : null;
  };
  const defaultAgent = async (directory) => {
    // OpenCode's default agent is what a session with no recorded selection
    // runs. `/api/agent` lists them; the one marked default, else `build`.
    const body = await openCodeFetch('/api/agent', { directory }).catch(() => null);
    const parsed = parseAgentFacts(body);
    if (!parsed.success) return null;
    const marked = parsed.data.find((agent) => agent.default === true || agent.isDefault === true);
    return marked?.id || 'build';
  };
  const commandList = async (directory) => {
    const body = await openCodeFetch('/api/command', { directory }).catch(() => null);
    const parsed = parseCommandFacts(body);
    return parsed.success ? parsed.data : null;
  };
  const defaultModel = async (directory) => {
    const parsed = modelFactSchema.safeParse(await openCodeFetch('/api/model/default', { directory }).catch(() => null));
    return parsed.success ? parsed.data : null;
  };
  const isSessionRunning = async (sessionId) => {
    const parsed = z.record(z.string(), z.object({ type: z.string() })).safeParse(
      await openCodeFetch('/api/session/active').catch(() => null),
    );
    return parsed.success ? Boolean(parsed.data[sessionId]) : null;
  };
  return { sessionSummary, defaultAgent, commandList, defaultModel, isSessionRunning };
};

/**
 * Decides whether this request is queued, and answers the classification either
 * way. `enqueue` is the runtime's own; `readEnabled` answers the project's
 * setting.
 */
export const admitPrompt = async ({
  req,
  body,
  sessionId,
  directory,
  kind = 'prompt',
  facts,
  readEnabled,
  resolveIdentity,
  enqueue,
}) => {
  // Unmarked requests are never inspected: the prompt goes to OpenCode as it
  // arrived, exactly as before this module existed.
  if (!isAdmitRequest(req)) return { action: 'pass' };

  const identity = await Promise.resolve(resolveIdentity({ directory, sessionId })).catch(() => null);
  if (!identity?.directory) return { action: 'pass' };

  // The session's canonical directory, not the one the request named. A prompt
  // cannot opt itself out of its own session's queue by asking with another
  // directory, and a worktree's queue stays separate from its project's.
  const enabled = await readEnabled(identity);
  if (enabled === false) return { action: 'pass' };
  // The setting could not be read, so the prompt cannot be proven to belong to
  // a project whose queue is off. Admitting it would dispatch onto a queue that
  // may be disabled; running it would bypass one that is on. Refuse instead.
  if (enabled !== true) throw Object.assign(new Error('The build queue setting could not be read on this server.'), { status: 503 });

  const session = await facts.sessionSummary(sessionId, identity.directory);
  // Unknown session in an enabled project: its agent cannot be verified, so a
  // Build turn would run outside the lane. The caller sees a failure to retry.
  if (!session) throw Object.assign(new Error('The session’s agent could not be verified. Try again.'), { status: 409 });

  const parsed = promptBodySchema.safeParse(body);
  const request = parsed.success ? parsed.data : {};
  const slashName = kind === 'command' ? request.name ?? '' : slashCommandNameOf(request.text ?? '');

  let commandAgent = null;
  let commandResolved = false;
  if (slashName) {
    const commands = await facts.commandList(identity.directory);
    if (commands !== null) {
      commandResolved = true;
      commandAgent = commandAgentOf(commands, slashName);
    }
  }
  const fallbackAgent = await facts.defaultAgent(identity.directory);
  const running = request.delivery === 'steer' && await facts.isSessionRunning(sessionId) === true;

  const verdict = classifySubmission({
    session,
    defaultAgent: fallbackAgent,
    kind,
    text: request.text ?? '',
    delivery: request.delivery ?? null,
    running,
    commandAgent,
    commandResolved,
  });
  if (verdict.reason === 'unknown-agent' || verdict.reason === 'unresolved-command') {
    throw Object.assign(new Error('The submission’s agent could not be verified. Try again.'), { status: 409 });
  }
  if (!verdict.build) return { action: 'pass', reason: verdict.reason };

  const model = session.model ?? await facts.defaultModel(identity.directory);
  if (!model) throw Object.assign(new Error('The session’s model could not be verified. Try again.'), { status: 409 });
  const sendConfig = { providerID: model.providerID, modelID: model.id, agent: commandAgent || session.agent || fallbackAgent,
    ...(model.variant ? { variant: model.variant } : {}) };
  const item = buildQueuedItemFromPrompt({ body, directory: identity.directory, sessionId, kind, sendConfig });
  if (!item) throw new TypeError('Unsupported Build prompt body');

  const admitted = await enqueue(sessionId, identity.directory, item);
  return { action: 'queued', itemId: admitted.itemId };
};

/**
 * The execution-starting admission routes and whether a given request would
 * actually start one. OpenCode starts execution by default; `resume: false` is
 * the only suppressor, so the guard must read the default as "starts".
 *
 * `compact` is deliberately absent: it runs the compaction agent, which is a
 * separate legitimate non-Build turn, so it is not queue work merely because a
 * model runs.
 */
export const startsExecution = ({ kind, body, query }) => {
  if (kind === 'prompt' || kind === 'command' || kind === 'shell') return true;
  if (kind === 'synthetic') return body?.resume !== false;
  // Activating a skill appends a message and resumes execution; `resume` is
  // optional and defaults to on.
  if (kind === 'skill') return body?.resume !== false;
  // Interrupting is always allowed; resuming is what can start a turn.
  if (kind === 'interrupt') return query?.resume === true || query?.resume === 'true';
  return false;
};

/**
 * Whether this request would change the ownership of work the queue manages:
 * a session move out of its project, or a direct mutating change to the inbox
 * the queue delivered into. Those are refused while the queue holds anything
 * for the session, so a project's build work cannot be walked out from under it.
 */
export const escapesManagedOwnership = ({ kind, body }) => {
  if (kind === 'move') return true;
  // Changing a pending item's delivery, or cancelling one, edits work the queue
  // may be tracking; the queue's own controls own that.
  if (kind === 'inbox-mutation') return true;
  return kind === 'inbox-update' && body?.delivery === 'steer';
};

/**
 * Whether this request must be queued or refused rather than run now.
 *
 * Only execution-starting admissions and ownership-changing mutations are
 * considered, and only for a Build session in a project whose queue is on. A
 * `resume: false` synthetic starts nothing and is always allowed: it is how the
 * queue itself admits context.
 */
export const guardExecutionStart = async ({ body, query, sessionId, directory, kind, facts, readEnabled, resolveIdentity, hasManagedWork }) => {
  const starting = startsExecution({ kind, body, query });
  const escaping = escapesManagedOwnership({ kind, body });
  if (!starting && !escaping) return { allow: true };
  const identity = await Promise.resolve(resolveIdentity({ directory, sessionId })).catch(() => null);
  // No project to place it in, or no server-side setting store: the queue does
  // not own this request, so it is not this guard's to refuse.
  if (!identity?.directory) return { allow: true };
  const enabled = await readEnabled(identity);
  // The setting itself could not be read. On a request that could start a turn
  // or move managed work that is a possible bypass, so it is refused.
  if (enabled === null) return { allow: false, reason: 'setting-unavailable' };
  if (enabled === false) return { allow: true };

  // An ownership change is only the queue's business while the queue actually
  // holds something for this session; an idle session may move freely.
  if (escaping && !starting) {
    const managed = await hasManagedWork?.(sessionId);
    if (managed !== true) return { allow: true };
    return { allow: false, reason: kind === 'move' ? 'session-move' : 'inbox-mutation' };
  }

  const session = await facts.sessionSummary(sessionId, identity.directory);
  // Unknown session or agent in an enabled project: the request could be a
  // queue bypass, so it is refused. A prompt the queue should have owned is a
  // failure the caller must see, not a turn that quietly ran outside the lane.
  if (!session) return { allow: false, reason: 'session-unreadable' };
  if (session.parentID) return { allow: true };

  const fallbackAgent = await facts.defaultAgent(identity.directory);
  const agent = session.agent || fallbackAgent;
  if (!agent) return { allow: false, reason: 'agent-unknown' };
  if (!isBuildAgentName(agent)) return { allow: true };
  if (kind === 'prompt' && body?.delivery === 'steer' && await facts.isSessionRunning(sessionId) === true) return { allow: true };

  // A marked request is admitted by its own route (`admitPrompt`) instead of
  // running. The marker never exempts a route the queue cannot take, so a
  // marked skill, interrupt, move, inbox change or shell is judged here as if
  // it were unmarked.
  return { allow: false, reason: 'build-session' };
};

/**
 * The response a queued prompt answers with. The SDK decodes this as
 * `SessionInbox.User`, so it must carry the full record the real admission
 * would have produced: the client's own id, the payload it sent, and the
 * delivery it asked for. A bare 202 would fail the decode.
 */
export const queuedPromptResponse = ({ body, sessionId, now }) => {
  const parsed = promptBodySchema.safeParse(body);
  const request = parsed.success ? parsed.data : {};
  const payload = { text: request.text ?? '' };
  if (request.files) payload.files = request.files;
  if (request.agents) payload.agents = request.agents;
  if (request.skills) payload.skills = request.skills;
  if (request.metadata) payload.metadata = request.metadata;
  return {
    data: {
      id: request.id ?? `queued-${now}`,
      sessionID: sessionId,
      time: { created: now },
      type: 'user',
      payload,
      delivery: request.delivery ?? 'queue',
    },
  };
};
