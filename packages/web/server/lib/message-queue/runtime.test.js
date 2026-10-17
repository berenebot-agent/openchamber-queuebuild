import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageQueueRuntime, parseQueuedItemInput } from './runtime.js';

const SESSION = 'ses_queue_test_1';
const DIRECTORY = '/repo';

const item = (overrides = {}) => ({
  content: 'follow up',
  text: 'follow up',
  attachments: [],
  sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'build' },
  ...overrides,
});

const tempDirs = [];
const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-message-queue-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake OpenCode: status map, message tail, command list, and a log of every
 * prompt/command it received.
 */
const createOpenCode = () => {
  const state = {
    // `/api/session/active` lists only running sessions; an absent id is idle.
    active: {},
    // Subagent sessions per parent, as `GET /api/session?parentID=` lists them.
    children: {},
    tail: [],
    commands: [],
    sent: [],
    switched: [],
    failNext: null,
    failMessages: false,
    failStatus: 500,
    htmlNext: null,
  };
  // v2 wraps `/api/*` payloads in `{ location, data }`; a message page is
  // `{ data, cursor }` and lists newest first.
  const wrapped = (data) => Response.json({ location: { directory: DIRECTORY }, data });
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    if (state.failNext && state.failNext.test(pathname)) {
      state.failNext = null;
      return new Response('boom', { status: state.failStatus });
    }
    if (method === 'POST' && state.htmlNext?.test(pathname)) {
      state.htmlNext = null;
      return new Response('<!doctype html><title>OpenChamber</title>', { status: 200, headers: { 'content-type': 'text/html' } });
    }
    // Real shape: `{ data }` without a `location`, unlike directory-scoped routes.
    if (pathname === '/api/session/active') return Response.json({ data: state.active });
    if (pathname === '/api/session' && method === 'GET') {
      const parentID = new URL(url).searchParams.get('parentID');
      return Response.json({ data: (state.children[parentID] ?? []).map((id) => ({ id, parentID })), cursor: {} });
    }
    if (/^\/api\/session\/[^/]+$/.test(pathname) && method === 'GET') {
      const id = decodeURIComponent(pathname.split('/').at(-1));
      const parentID = Object.keys(state.children).find((parent) => state.children[parent].includes(id));
      return wrapped({ id, parentID });
    }
    if (pathname.endsWith('/message')) return state.failMessages
      ? new Response('unavailable', { status: 503 }) : Response.json({ data: state.tail, cursor: {} });
    if (pathname === '/api/command') return wrapped(state.commands);
    if (method === 'POST' && (pathname.endsWith('/model') || pathname.endsWith('/agent'))) {
      // Kept apart from `sent`: switching the session is not a message.
      state.switched.push({ path: pathname, body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && (pathname.endsWith('/prompt') || pathname.endsWith('/command') || pathname.endsWith('/synthetic'))) {
      state.sent.push({ path: pathname, body: JSON.parse(init.body) });
      return wrapped({ id: `msg_${state.sent.length}` });
    }
    return new Response('not found', { status: 404 });
  });
  return { state, fetchImpl };
};

const createRuntime = ({ dataDir = makeDataDir(), openCode = createOpenCode(), knowledge = null, retryDelayMs, resolveAutoSelection, now, beforeScheduledTaskSend, onScheduledTaskResult, checkBuildGit, prepareBuildCommit, buildMonitorDelayMs, buildRecheckMs, buildCompletionGraceMs, settingsFilePath } = {}) => {
  let eventHandler = () => {};
  let statusHandler = () => {};
  const broadcasts = [];
  const promptSent = [];
  const options = {
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
      subscribeStatus(handler) { statusHandler = handler; return () => {}; },
    },
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    sessionKnowledgeRuntime: knowledge,
    broadcastGlobalUiEvent: (event) => broadcasts.push(event),
    onPromptSent: (sessionId) => promptSent.push(sessionId),
    dataDir,
    fetchImpl: openCode.fetchImpl,
    dispatchQuietMs: 0,
    abortHoldMs: 50,
    beforeScheduledTaskSend,
    onScheduledTaskResult,
  };
  if (retryDelayMs) options.retryDelayMs = retryDelayMs;
  if (resolveAutoSelection) options.resolveAutoSelection = resolveAutoSelection;
  if (now) options.now = now;
  if (checkBuildGit) options.checkBuildGit = checkBuildGit;
  if (prepareBuildCommit) options.prepareBuildCommit = prepareBuildCommit;
  if (buildMonitorDelayMs !== undefined) options.buildMonitorDelayMs = buildMonitorDelayMs;
  if (buildRecheckMs !== undefined) options.buildRecheckMs = buildRecheckMs;
  if (buildCompletionGraceMs !== undefined) options.buildCompletionGraceMs = buildCompletionGraceMs;
  if (settingsFilePath !== undefined) options.settingsFilePath = settingsFilePath;
  const runtime = createMessageQueueRuntime(options);
  return {
    runtime,
    openCode,
    dataDir,
    broadcasts,
    promptSent,
    // The hub hands server-side subscribers already-translated events.
    emit: (payload, directory = DIRECTORY) => eventHandler({ payload, directory, translated: () => [payload] }),
    connect: () => statusHandler({ type: 'connect' }),
  };
};

const settle = async (ms = 30) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

describe('scheduled task items', () => {
  const scheduled = (projectId = 'project-1', overrides = {}) => item({
    scheduledTask: { projectId, taskId: 'task-1' }, sendConfig: {}, ...overrides,
  });

  it('deduplicates project and task across sessions, but not across projects', async () => {
    const { runtime, openCode } = createRuntime();
    openCode.state.active = { [SESSION]: { type: 'running' } };
    await runtime.enqueue(SESSION, DIRECTORY, scheduled());
    await expect(runtime.enqueue('ses_other', DIRECTORY, scheduled())).rejects.toMatchObject({ status: 409 });
    await runtime.enqueue(SESSION, DIRECTORY, scheduled('project-2'));
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(2);
    runtime.stop();
    await runtime.flush();
  });

  it('inherits without a model POST and reports sent without waiting for completion', async () => {
    const results = [];
    const { runtime, openCode } = createRuntime({ onScheduledTaskResult: (task, status) => results.push({ task, status }) });
    await runtime.enqueue(SESSION, DIRECTORY, scheduled());
    await settle();
    expect(openCode.state.switched).toEqual([]);
    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].body).toEqual({ text: 'follow up' });
    expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
    expect(results).toEqual([{ task: { projectId: 'project-1', taskId: 'task-1' }, status: 'sent' }]);
    runtime.stop();
    await runtime.flush();
  });

  it('applies explicit selection and keeps the existing directory query', async () => {
    const { runtime, openCode } = createRuntime();
    await runtime.enqueue(SESSION, DIRECTORY, scheduled('project-1', { sendConfig: { providerID: 'openai', modelID: 'chosen', agent: 'plan' } }));
    await settle();
    expect(openCode.state.switched.map((entry) => entry.body)).toEqual([{ model: { providerID: 'openai', id: 'chosen' } }, { agent: 'plan' }]);
    const promptCall = openCode.fetchImpl.mock.calls.find(([url]) => new URL(url).pathname.endsWith('/prompt'));
    expect(new URL(promptCall[0]).searchParams.get('directory')).toBe(DIRECTORY);
    runtime.stop();
    await runtime.flush();
  });

  it('supports an agent override without switching the target model', async () => {
    const { runtime, openCode } = createRuntime();
    await runtime.enqueue(SESSION, DIRECTORY, scheduled('project-1', { sendConfig: { agent: 'plan' } }));
    await settle();
    expect(openCode.state.switched.map((entry) => entry.body)).toEqual([{ agent: 'plan' }]);
    runtime.stop();
    await runtime.flush();
  });

  it('keeps an agent-only override across persistence and restart', async () => {
    const first = createRuntime();
    first.openCode.state.active = { [SESSION]: { type: 'running' } };
    await first.runtime.enqueue(SESSION, DIRECTORY, scheduled('project-1', { sendConfig: { agent: 'plan' } }));
    first.runtime.stop();
    await first.runtime.flush();
    const second = createRuntime({ dataDir: first.dataDir });
    await second.runtime.load();
    expect(second.runtime.sessionSnapshot(SESSION).items[0].sendConfig).toEqual({ agent: 'plan' });
    second.runtime.start();
    await settle();
    expect(second.openCode.state.switched.map((entry) => entry.body)).toEqual([{ agent: 'plan' }]);
    expect(second.openCode.state.sent).toHaveLength(1);
    second.runtime.stop();
    await second.runtime.flush();
  });

  it.each([404, 409])('drops a target refusal %s without holding ordinary items behind it', async (statusCode) => {
    const results = [];
    const { runtime, openCode } = createRuntime({
      beforeScheduledTaskSend: async () => { throw Object.assign(new Error('Scheduled target is unavailable'), { statusCode }); },
      onScheduledTaskResult: (_task, status) => results.push(status),
    });
    await runtime.enqueue(SESSION, DIRECTORY, scheduled());
    await runtime.enqueue(SESSION, DIRECTORY, item({ text: 'ordinary' }));
    await settle();
    expect(results).toEqual(['failed']);
    expect(openCode.state.sent[0].body.text).toBe('ordinary');
    runtime.stop();
    await runtime.flush();
  });

  it.each([
    { operation: 'prompt', status: 500 },
    { operation: 'model', status: 500 },
    { operation: 'model', status: 404 },
    { operation: 'model', status: 409 },
    { operation: 'target lookup', status: 503 },
  ])('uses the ordinary retry policy for scheduled $operation failure $status', async ({ operation, status }) => {
    const results = [];
    let checks = 0;
    const { runtime, openCode, emit } = createRuntime({
      retryDelayMs: () => 100,
      beforeScheduledTaskSend: async () => {
        checks += 1;
        if (operation === 'target lookup' && checks === 1) throw Object.assign(new Error('upstream unavailable'), { statusCode: 503 });
      },
      onScheduledTaskResult: (_task, status) => results.push(status),
    });
    runtime.start();
    openCode.state.failStatus = status;
    if (operation === 'prompt') openCode.state.failNext = /\/prompt$/;
    if (operation === 'model') openCode.state.failNext = /\/model$/;
    await runtime.enqueue(SESSION, DIRECTORY, operation === 'model'
      ? scheduled('project-1', { sendConfig: { providerID: 'openai', modelID: 'chosen' } })
      : scheduled());
    await runtime.enqueue(SESSION, DIRECTORY, item({ text: 'ordinary' }));
    await settle();
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(2);
    expect(results).toEqual([]);
    expect(openCode.state.sent).toEqual([]);
    await expect(runtime.enqueue(SESSION, DIRECTORY, scheduled())).rejects.toMatchObject({ status: 409 });
    await settle(130);
    expect(checks).toBe(2);
    expect(results).toEqual(['sent']);
    expect(openCode.state.sent.map((entry) => entry.body.text)).toEqual(['follow up']);
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent.map((entry) => entry.body.text)).toEqual(['follow up', 'ordinary']);
    runtime.stop();
    await runtime.flush();
  });

  it('rejects scheduled takes, leaves them in bulk take, and allows reorder and remove', async () => {
    const results = [];
    const { runtime, openCode } = createRuntime({ onScheduledTaskResult: (task, status) => results.push({ task, status }) });
    openCode.state.active = { [SESSION]: { type: 'running' } };
    const first = await runtime.enqueue(SESSION, DIRECTORY, scheduled());
    const ordinary = await runtime.enqueue(SESSION, DIRECTORY, item());
    const second = await runtime.enqueue(SESSION, DIRECTORY, scheduled('project-1', { scheduledTask: { projectId: 'project-1', taskId: 'task-2' } }));
    await runtime.reorder(SESSION, [second.itemId, ordinary.itemId, first.itemId]);
    await expect(runtime.take(SESSION, first.itemId)).rejects.toMatchObject({ status: 409 });
    expect((await runtime.takeAll(SESSION)).items.map((entry) => entry.id)).toEqual([ordinary.itemId]);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.id)).toEqual([second.itemId, first.itemId]);
    expect(results).toEqual([]);
    await runtime.remove(SESSION, second.itemId);
    expect(results).toEqual([{ task: { projectId: 'project-1', taskId: 'task-2' }, status: 'cancelled' }]);
    runtime.stop();
    await runtime.flush();
  });

  it('ignores creation-only policy fields on stored scheduled provenance', () => {
    const parsed = parseQueuedItemInput(scheduled('project-1', {
      scheduledTask: { projectId: 'project-1', taskId: 'task-1', goalEnabled: true, goalTokenBudget: 5000, permissionAutoAccept: true },
    }));
    expect(parsed.scheduledTask).toEqual({ projectId: 'project-1', taskId: 'task-1' });
  });

  it('cancels only the requested task and survives a restart with provenance', async () => {
    const results = [];
    const first = createRuntime({ onScheduledTaskResult: (_task, status) => results.push(status) });
    first.openCode.state.active = { [SESSION]: { type: 'running' } };
    await first.runtime.enqueue(SESSION, DIRECTORY, scheduled());
    await first.runtime.enqueue(SESSION, DIRECTORY, item());
    first.runtime.stop();
    await first.runtime.flush();
    const second = createRuntime({ dataDir: first.dataDir, onScheduledTaskResult: (_task, status) => results.push(status) });
    await second.runtime.load();
    expect(second.runtime.sessionSnapshot(SESSION).items[0].scheduledTask).toEqual({ projectId: 'project-1', taskId: 'task-1' });
    await second.runtime.cancelScheduledTask('project-1', 'task-1');
    expect(second.runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    expect(results).toEqual(['cancelled']);
    second.runtime.stop();
    await second.runtime.flush();
  });
});

describe('auto routing', () => {
  it('switches a queued prompt and a queued command onto the routed model and agent', async () => {
    const resolveAutoSelection = vi.fn(async ({ model }) => (model?.id === 'auto'
      ? { model: { providerID: 'openai', id: 'gpt-6-astra' }, agent: 'plan', decision: {} }
      : null));
    const { runtime, openCode, emit } = createRuntime({ resolveAutoSelection });
    runtime.start();
    openCode.state.statuses = { [SESSION]: { type: 'busy' } };
    openCode.state.commands = [{ name: 'review', template: 'Review $ARGUMENTS' }];
    const auto = { providerID: 'openchamber', modelID: 'auto', agent: 'build' };
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain', sendConfig: auto }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '/review src', text: '/review src', sendConfig: auto }));

    openCode.state.statuses = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    // v2 carries no model in a prompt body: the session is switched first.
    const switched = openCode.state.switched.filter((entry) => entry.path.endsWith('/model'));
    expect(switched.map((entry) => entry.body.model)).toEqual([
      { providerID: 'openai', id: 'gpt-6-astra' },
      { providerID: 'openai', id: 'gpt-6-astra' },
    ]);
    expect(openCode.state.switched.filter((entry) => entry.path.endsWith('/agent')).map((entry) => entry.body.agent))
      .toEqual(['plan', 'plan']);
    expect(resolveAutoSelection).toHaveBeenCalledTimes(2);
    expect(resolveAutoSelection.mock.calls[0][0]).toMatchObject({ sessionId: SESSION, directory: DIRECTORY, requestText: 'plain' });
  });

  it('tells the classifier about an image attached to a queued send', async () => {
    const resolveAutoSelection = vi.fn(async () => null);
    const { runtime, openCode, emit } = createRuntime({ resolveAutoSelection });
    runtime.start();
    openCode.state.statuses = { [SESSION]: { type: 'busy' } };
    const auto = { providerID: 'openchamber', modelID: 'auto', agent: 'build' };
    const image = { id: 'a', filename: 'shot.png', mimeType: 'image/png', size: 1, source: 'local', dataUrl: 'data:image/png;base64,AAAA' };
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: "what's wrong?", text: "what's wrong?", attachments: [image], sendConfig: auto }));

    openCode.state.statuses = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(resolveAutoSelection.mock.calls[0][0].requestText).toBe("what's wrong?\n\n[The user attached an image: shot.png]");
  });
});

describe('parseQueuedItemInput', () => {
  it('rejects an item the server could not deliver later', () => {
    expect(() => parseQueuedItemInput({ content: 'x' })).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ content: '', text: '' }))).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ attachments: [{ filename: 'a.png' }] }))).toThrow(TypeError);
  });

  it('keeps delivery fields and trims blank edges of the content', () => {
    const parsed = parseQueuedItemInput(item({ content: '\n\nhello\n', text: 'hello', agentMention: 'reviewer' }));
    expect(parsed).toEqual({
      content: 'hello',
      text: 'hello',
      agentMention: 'reviewer',
      attachments: [],
      context: [],
      sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'build' },
    });
  });

  it('keeps captured context and rejects a malformed part', () => {
    const context = [
      { kind: 'context', text: 'Comment on `a.ts`', metadata: { openchamberContext: { kind: 'code-comment' } }, instructions: '' },
      { kind: 'instruction', text: 'use the skill' },
      { kind: 'synthetic', text: 'conflict payload' },
    ];
    expect(parseQueuedItemInput(item({ context })).context).toEqual([
      { kind: 'context', text: 'Comment on `a.ts`', metadata: { openchamberContext: { kind: 'code-comment' } } },
      { kind: 'instruction', text: 'use the skill' },
      { kind: 'synthetic', text: 'conflict payload' },
    ]);
    expect(() => parseQueuedItemInput(item({ context: [{ kind: 'context', text: 'no metadata' }] }))).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ context: [{ kind: 'other', text: 'x' }] }))).toThrow(TypeError);
  });

  it('accepts an item that is only context', () => {
    const parsed = parseQueuedItemInput(item({ content: '', text: '', context: [{ kind: 'synthetic', text: 'just context' }] }));
    expect(parsed.text).toBe('');
    expect(parsed.context).toHaveLength(1);
  });
});

describe('message queue runtime', () => {
  it('delivers the head of the queue when the session goes idle, in order', async () => {
    const { runtime, openCode, emit, promptSent, broadcasts } = createRuntime();
    runtime.start();
    openCode.state.active = { [SESSION]: { type: 'running' } };

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first' }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'second', text: 'second' }));
    await settle();
    expect(openCode.state.sent).toHaveLength(0);

    openCode.state.active = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].path).toBe(`/api/session/${SESSION}/prompt`);
    // v2 selects model and agent on the session, so the prompt carries text
    // and attachments only.
    expect(openCode.state.sent[0].body).toEqual({ text: 'first' });
    expect(promptSent).toEqual([SESSION]);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['second']);
    // Clients learned about the in-flight item and then the removal.
    expect(broadcasts.at(-1)).toMatchObject({
      type: 'openchamber:message-queue.updated',
      properties: { session: { sessionId: SESSION, sendingId: null } },
    });

    // The next turn: busy, then idle again — the second message goes out.
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'busy' } } });
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(2);
    expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
  });

  it('waits for a background subagent before sending the queued message', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    // The parent paused: it is idle while its background subagent works.
    openCode.state.children = { [SESSION]: ['ses_child'] };
    openCode.state.active = { ses_child: { type: 'running' } };

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'next', text: 'next' }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);

    // The subagent finished and OpenCode ran the parent again with its result.
    openCode.state.active = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'busy' } } });
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].body).toEqual({ text: 'next' });
  });

  it('keeps queued messages until a nested background subagent finishes', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.children = { [SESSION]: ['ses_child'], ses_child: ['ses_grandchild'] };
    openCode.state.active = { ses_grandchild: { type: 'running' } };
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first' }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'second', text: 'second' }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(2);

    openCode.state.active = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent.map((entry) => entry.body.text)).toEqual(['first']);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'busy' } } });
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent.map((entry) => entry.body.text)).toEqual(['first', 'second']);
    runtime.stop();
  });

  it('keeps the queue intact when a nested lineage read fails', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.children = { [SESSION]: ['ses_child'], ses_child: ['ses_grandchild'] };
    openCode.state.active = { ses_grandchild: { type: 'running' } };
    openCode.state.failNext = /\/api\/session\/ses_child$/;
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    openCode.state.active = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
    runtime.stop();
  });

  it('does not send into a running turn even when the status event says idle', async () => {
    const { runtime, openCode, emit } = createRuntime({ now: () => 10_000 });
    runtime.start();
    // Live unfinished turn: created after this runtime started.
    openCode.state.tail = [{ type: 'assistant', time: { created: 10_001 } }];
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);

    // The reply completes: that alone drains the queue (a missed idle event
    // must not strand it).
    openCode.state.tail = [{ type: 'assistant', time: { created: 10_001, completed: 10_002 } }];
    emit({ type: 'message.updated', properties: { info: { role: 'assistant', sessionID: SESSION, time: { created: 10_001, completed: 10_002 } } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('rechecks session activity after the build gate and releases a lease when another turn started', async () => {
    let started = false;
    const { runtime, openCode, emit } = createRuntime({
      checkBuildGit: async () => {
        if (!started) {
          started = true;
          openCode.state.active = { [SESSION]: { type: 'running' } };
        }
        return null;
      },
    });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'build', text: 'build', buildQueue: true }));
    await settle(40);

    expect(openCode.state.sent).toHaveLength(0);
    expect(openCode.state.switched).toHaveLength(0);
    expect(runtime.buildSnapshot().active).toHaveLength(0);
    expect(runtime.buildSnapshot().queued.map(entry => entry.content)).toEqual(['build']);

    openCode.state.active = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(40);
    expect(openCode.state.sent.at(-1).body.text).toBe('build');
    runtime.stop();
    await runtime.flush();
  });

  it('delivers past an unfinished tail that predates this runtime (dead pre-restart run)', async () => {
    const { runtime, openCode, emit } = createRuntime({ now: () => 10_000 });
    runtime.start();
    // Assistant reply interrupted by a server restart: unfinished, but older
    // than this runtime — no completion event will ever arrive for it, so it
    // must not block a restored queue forever.
    openCode.state.tail = [{ type: 'assistant', time: { created: 1 } }];
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].path).toBe(`/api/session/${SESSION}/prompt`);
  });

  it('treats an unreachable OpenCode as unknown, not idle', async () => {
    const { runtime, openCode, emit } = createRuntime({ retryDelayMs: () => 10 });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    openCode.state.failNext = /\/api\/session\/active$/;
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(5);
    expect(openCode.state.sent).toHaveLength(0);
    // Retried after the status fetch recovers.
    await settle(40);
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('keeps a failed item and retries with backoff', async () => {
    const { runtime, openCode, emit, broadcasts } = createRuntime({ retryDelayMs: () => 20 });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    openCode.state.failNext = /\/prompt$/;
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(10);
    expect(openCode.state.sent).toHaveLength(0);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    expect(runtime.sessionSnapshot(SESSION).sendingId).toBeNull();
    expect(broadcasts.at(-1).properties.session.sendingId).toBeNull();
    await settle(40);
    expect(openCode.state.sent).toHaveLength(1);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(0);
  });

  it('keeps a queued prompt when the runtime returns an HTML app shell', async () => {
    const { runtime, openCode, emit, promptSent } = createRuntime({ retryDelayMs: () => 1_000 });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    openCode.state.htmlNext = /prompt$/;
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent).toHaveLength(0);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    expect(promptSent).toEqual([]);
    runtime.stop();
  });

  it('keeps a queued command when the runtime returns an HTML app shell', async () => {
    const { runtime, openCode, emit, promptSent } = createRuntime({ retryDelayMs: () => 1_000 });
    runtime.start();
    openCode.state.commands = [{ name: 'review' }];
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '/review src', text: '/review src' }));
    openCode.state.htmlNext = /command$/;
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent).toHaveLength(0);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    expect(promptSent).toEqual([]);
    runtime.stop();
  });

  it('holds delivery briefly after a user abort', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    // v2 reports a user abort as `session.execution.interrupted`, which the
    // translator turns into an aborted `session.idle`.
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    emit({ type: 'session.idle', properties: { sessionID: SESSION, aborted: true, reason: 'user' } });
    await settle(10);
    expect(openCode.state.sent).toHaveLength(0);
    await settle(80);
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('honors a hold until it is released', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    runtime.setHold(SESSION, true, 60_000);
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);

    runtime.setHold(SESSION, false);
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('wakes delivery at the renewed hold expiry instead of waiting for another event', async () => {
    const { runtime, openCode } = createRuntime();
    runtime.setHold(SESSION, true, 80);
    await runtime.enqueue(SESSION, DIRECTORY, item());
    await settle(30);
    runtime.setHold(SESSION, true, 160);
    await settle(70);
    expect(openCode.state.sent).toHaveLength(0);

    await settle(120);
    expect(openCode.state.sent).toHaveLength(1);
    runtime.stop();
    await runtime.flush();
  });

  it('survives a restart and delivers once OpenCode reconnects', async () => {
    const dataDir = makeDataDir();
    const first = createRuntime({ dataDir });
    first.runtime.start();
    first.openCode.state.active = { [SESSION]: { type: 'running' } };
    await first.runtime.enqueue(SESSION, DIRECTORY, item({ content: 'persisted', text: 'persisted', contextPreview: 'Saved context preview' }));
    await first.runtime.flush();
    first.runtime.stop();

    const second = createRuntime({ dataDir });
    second.runtime.start();
    await second.runtime.load();
    expect(second.runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['persisted']);
    expect(second.runtime.sessionSnapshot(SESSION).items[0].contextPreview).toBe('Saved context preview');
    second.connect();
    await settle();
    expect(second.openCode.state.sent).toHaveLength(1);
    expect(second.openCode.state.sent[0].body).toEqual({ text: 'persisted' });
  });

  it('moves an unreadable queue file aside instead of treating it as empty', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'message-queue.json'), '{ not json');
    const { runtime } = createRuntime({ dataDir });
    await runtime.load();
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith('message-queue.json.corrupt-'))).toBe(true);
  });

  it('refuses to remove or take the item currently being sent', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    let release;
    // Initial and final activity probes, then session selection and the send.
    openCode.fetchImpl.mockImplementationOnce(async () => Response.json({ location: {}, data: {} }))
      .mockImplementationOnce(async () => Response.json({ data: [], cursor: {} }))
      .mockImplementationOnce(async () => Response.json({ data: {} }))
      .mockImplementationOnce(async () => Response.json({ location: {}, data: {} }))
      .mockImplementationOnce(async () => Response.json({ data: [], cursor: {} }))
      .mockImplementationOnce(async () => Response.json({ data: {} }))
      .mockImplementationOnce(async () => new Response(null, { status: 204 }))
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(new Response(null, { status: 204 })); }));
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(runtime.sessionSnapshot(SESSION).sendingId).toBe(itemId);

    await expect(runtime.remove(SESSION, itemId)).rejects.toMatchObject({ status: 409 });
    await expect(runtime.take(SESSION, itemId)).rejects.toMatchObject({ status: 409 });
    const taken = await runtime.takeAll(SESSION);
    expect(taken.items).toEqual([]);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);

    release();
    await settle();
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(0);
  });

  it('take hands back the full payload and leaves the rest queued', async () => {
    const { runtime } = createRuntime();
    runtime.start();
    const attachment = { id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 3, source: 'local', dataUrl: 'data:image/png;base64,AAA=' };
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'with image', attachments: [attachment] }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain' }));

    expect(runtime.sessionSnapshot(SESSION).items[0].attachments[0]).not.toHaveProperty('dataUrl');
    const taken = await runtime.take(SESSION, first.itemId);
    expect(taken.item.attachments[0].dataUrl).toBe(attachment.dataUrl);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['plain']);

    const all = await runtime.takeAll(SESSION);
    expect(all.items.map((entry) => entry.content)).toEqual(['plain']);
    expect(runtime.snapshot().sessions).toEqual([]);
  });

  it('retains a bounded context preview in snapshots and broadcasts without exposing the full payload', async () => {
    const { runtime, broadcasts } = createRuntime();
    runtime.start();
    const context = [{ kind: 'context', text: 'Full quoted content', metadata: { openchamberContext: { kind: 'chat-quote', quote: 'Original answer', text: 'Explain this' } } }];
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item({ content: '', text: '', context, contextPreview: 'Explain this' }));
    const projected = runtime.sessionSnapshot(SESSION).items[0];
    expect(projected.contextPreview).toBe('Explain this');
    expect(projected.content).toBe('');
    expect(projected.text).toBe('');
    expect(projected).not.toHaveProperty('context');
    expect(broadcasts.at(-1).properties.session.items[0].contextPreview).toBe('Explain this');
    const taken = await runtime.take(SESSION, itemId);
    expect(taken.item.context).toEqual(context);
    expect(taken.item.content).toBe('');

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '', text: '', context, contextPreview: 'a'.repeat(5000) }));
    expect(runtime.sessionSnapshot(SESSION).items[0].contextPreview).toBe('a'.repeat(100) + '...');
  });

  it('derives a preview for older queued annotations without a saved summary', async () => {
    const { runtime } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '', text: '', context: [
      { kind: 'instruction', text: 'Use the skill' },
      { kind: 'context', text: 'Model-facing wrapper', metadata: { openchamberContext: { kind: 'browser-annotation', text: 'Fix the button\nMore detail' } } },
    ] }));
    expect(runtime.sessionSnapshot(SESSION).items[0].contextPreview).toBe('Fix the button...');
  });

  it('names the directory in the broadcast that empties a queue', async () => {
    // The UI keys its projection by directory; without it the client cannot
    // tell which queue just delivered its last message and keeps showing it.
    const { runtime, emit, broadcasts, openCode } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    openCode.state.active = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent).toHaveLength(1);
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(broadcasts.at(-1).properties.session).toEqual({ sessionId: SESSION, directory: DIRECTORY, items: [], sendingId: null });
  });

  it('reorders only with a complete permutation', async () => {
    const { runtime } = createRuntime();
    runtime.start();
    const a = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'a' }));
    const b = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'b' }));
    await expect(runtime.reorder(SESSION, [b.itemId])).rejects.toThrow(TypeError);
    await runtime.reorder(SESSION, [b.itemId, a.itemId]);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['b', 'a']);
  });

  it('drops the queue of a deleted session', async () => {
    const { runtime, emit, broadcasts } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.deleted', properties: { info: { id: SESSION } } });
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(broadcasts.at(-1).properties.session).toMatchObject({ sessionId: SESSION, items: [] });
  });

  it('dispatches a queued slash command through the command endpoint', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.commands = [{ name: 'review' }];
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '/review src', text: '/review src', sendConfig: { providerID: 'p', modelID: 'm', agent: 'build', variant: 'max' } }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].path).toBe(`/api/session/${SESSION}/command`);
    // v2's command route takes `text`, and the selection lives on the session.
    expect(openCode.state.sent[0].body).toEqual({ name: 'review', text: 'src' });
  });

  it('delivers captured context as synthetic messages, instructions first, before project knowledge', async () => {
    const knowledge = {
      resolvePendingForSession: async () => ({ text: 'pinned notes', signature: 'sig-1' }),
      recordDelivered: async () => {},
    };
    const { runtime, openCode, emit } = createRuntime({ knowledge });
    runtime.start();
    const metadata = { openchamberContext: { kind: 'github-pr', number: 7, title: 'PR', url: 'https://x/pr/7' } };
    await runtime.enqueue(SESSION, DIRECTORY, item({
      agentMention: 'reviewer',
      attachments: [{ id: 'a', filename: 'f.txt', mimeType: 'text/plain', size: 1, source: 'local', dataUrl: 'data:text/plain,hi' }],
      context: [
        { kind: 'context', text: 'the diff', metadata, instructions: 'how to read it' },
        { kind: 'synthetic', text: 'conflict payload' },
        { kind: 'instruction', text: 'use the skill' },
      ],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    // v2 has no inline synthetic parts: everything attached to the message is
    // admitted as its own synthetic message, before the prompt.
    expect(openCode.state.sent.map((entry) => entry.path)).toEqual([
      `/api/session/${SESSION}/synthetic`,
      `/api/session/${SESSION}/synthetic`,
      `/api/session/${SESSION}/synthetic`,
      `/api/session/${SESSION}/synthetic`,
      `/api/session/${SESSION}/synthetic`,
      `/api/session/${SESSION}/prompt`,
    ]);
    expect(openCode.state.sent.slice(0, 5).map((entry) => entry.body)).toEqual([
      { text: 'how to read it', resume: false },
      { text: 'the diff', resume: false, metadata },
      { text: 'conflict payload', resume: false },
      { text: 'use the skill', resume: false },
      { text: 'pinned notes', resume: false },
    ]);
    expect(openCode.state.sent.at(-1).body).toEqual({
      text: 'follow up',
      files: [{ uri: 'data:text/plain,hi', name: 'f.txt' }],
      agents: [{ name: 'reviewer' }],
    });
  });

  it('keeps files on the command route, which is all that route accepts', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.commands = [{ name: 'review' }];
    await runtime.enqueue(SESSION, DIRECTORY, item({
      content: '/review',
      text: '/review',
      attachments: [{ id: 'a', filename: 'f.txt', mimeType: 'text/plain', size: 1, source: 'local', dataUrl: 'data:text/plain,hi' }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent[0].path).toBe(`/api/session/${SESSION}/command`);
    expect(openCode.state.sent[0].body).toEqual({
      name: 'review',
      text: '',
      files: [{ uri: 'data:text/plain,hi', name: 'f.txt' }],
    });
  });

  it('admits captured context as synthetic messages and still runs a queued command through the command route', async () => {
    // The command route takes attachments only, so the context goes ahead as
    // synthetic messages; the command itself keeps its route, because sending
    // "/review ..." as a prompt would skip the template OpenCode expands there.
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.commands = [{ name: 'review', description: 'Review' }];
    const metadata = { openchamberContext: { kind: 'chat-quote', quote: 'q', text: 'why?' } };
    await runtime.enqueue(SESSION, DIRECTORY, item({
      content: '/review src "error handling"',
      text: '/review src "error handling"',
      context: [{ kind: 'context', text: 'quoted', metadata }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent.map((entry) => entry.path)).toEqual([
      `/api/session/${SESSION}/synthetic`,
      `/api/session/${SESSION}/command`,
    ]);
    expect(openCode.state.sent[0].body).toEqual({ text: 'quoted', resume: false, metadata });
    expect(openCode.state.sent[1].body).toEqual({ name: 'review', text: 'src "error handling"' });
  });

  it('delivers pending project knowledge ahead of a queued command and records it', async () => {
    const recorded = [];
    const knowledge = {
      resolvePendingForSession: async () => ({ text: 'pinned notes', signature: 'sig-1' }),
      recordDelivered: async (sessionId, directory, signature) => { recorded.push({ sessionId, directory, signature }); },
    };
    const { runtime, openCode, emit } = createRuntime({ knowledge });
    runtime.start();
    openCode.state.commands = [{ name: 'review' }];
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '/review', text: '/review' }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent.map((entry) => entry.path)).toEqual([
      `/api/session/${SESSION}/synthetic`,
      `/api/session/${SESSION}/command`,
    ]);
    expect(openCode.state.sent[0].body).toEqual({ text: 'pinned notes', resume: false });
    expect(recorded).toEqual([{ sessionId: SESSION, directory: DIRECTORY, signature: 'sig-1' }]);
  });

  it('admits nothing when the command lookup fails, so a retry cannot duplicate the context', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.failNext = /^\/api\/command$/;
    await runtime.enqueue(SESSION, DIRECTORY, item({
      content: '/review',
      text: '/review',
      context: [{ kind: 'context', text: 'quoted', metadata: {} }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent).toEqual([]);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
  });

  it('keeps captured context out of snapshots and broadcasts, and hands it back on take', async () => {
    const { runtime, broadcasts } = createRuntime();
    runtime.start();
    const context = [{ kind: 'synthetic', text: 'a large diff' }];
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item({ context }));
    expect(runtime.sessionSnapshot(SESSION).items[0]).not.toHaveProperty('context');
    expect(runtime.sessionSnapshot(SESSION).items[0].text).toBe('follow up');
    expect(broadcasts.at(-1).properties.session.items[0]).not.toHaveProperty('context');
    const taken = await runtime.take(SESSION, itemId);
    expect(taken.item.context).toEqual(context);
  });

  it('attaches pending project knowledge and records its delivery', async () => {
    const recorded = [];
    const knowledge = {
      resolvePendingForSession: async () => ({ text: 'pinned notes', signature: 'sig-1' }),
      recordDelivered: async (sessionId, directory, signature) => { recorded.push({ sessionId, directory, signature }); },
    };
    const { runtime, openCode, emit } = createRuntime({ knowledge });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ agentMention: 'reviewer', attachments: [{ id: 'a', filename: 'f.txt', mimeType: 'text/plain', size: 1, source: 'local', dataUrl: 'data:text/plain,hi' }] }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    // Knowledge is admitted as a synthetic message ahead of the prompt.
    expect(openCode.state.sent[0].path).toBe(`/api/session/${SESSION}/synthetic`);
    expect(openCode.state.sent[0].body).toEqual({ text: 'pinned notes', resume: false });
    expect(openCode.state.sent[1].path).toBe(`/api/session/${SESSION}/prompt`);
    expect(openCode.state.sent[1].body).toEqual({
      text: 'follow up',
      files: [{ uri: 'data:text/plain,hi', name: 'f.txt' }],
      agents: [{ name: 'reviewer' }],
    });
    expect(recorded).toEqual([{ sessionId: SESSION, directory: DIRECTORY, signature: 'sig-1' }]);
  });
});

describe('project-wide build queue', () => {
  it('announces the build queue the moment a build is enqueued', async () => {
    // The queue pane and the work board read this snapshot. Without the
    // broadcast, a queued build only appeared on the next poll.
    const { runtime, broadcasts } = createRuntime({ settingsFilePath: path.join(makeDataDir(), 'settings.json') });
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    expect(broadcasts).toContainEqual({ type: 'openchamber:build-queue.updated', properties: { directory: DIRECTORY } });
    // An ordinary message is not project build work and does not announce it.
    const before = broadcasts.length;
    await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'plain', text: 'plain' }));
    expect(broadcasts.slice(before).some(event => event.type === 'openchamber:build-queue.updated')).toBe(false);
    runtime.stop();
    await runtime.flush();
  });

  it('ignores an item flagged as a build by a non-Build session', async () => {
    // A Plan session whose prompt was flagged before the composer gated on the
    // session's own agent must not surface as a project build.
    const { runtime, openCode } = createRuntime({ settingsFilePath: path.join(makeDataDir(), 'settings.json') });
    await runtime.enqueue(SESSION, DIRECTORY, item({
      buildQueue: true,
      sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'plan' },
    }));
    await settle(80);

    // Absent from the build queue, and never sent the build preamble, though it
    // still dispatches as the ordinary queued message it is.
    expect(runtime.buildSnapshot().queued).toHaveLength(0);
    expect(openCode.state.sent.some(call => call.path.endsWith('/synthetic'))).toBe(false);
    expect(openCode.state.sent.some(call => call.path.endsWith('/prompt'))).toBe(true);

    runtime.stop();
    await runtime.flush();
  });

  it('treats a build flagged by a non-Build session as an ordinary message', async () => {
    // The same item must be takeable, and must not hold the session's own
    // reorder, which only managed builds do.
    const { runtime } = createRuntime({ settingsFilePath: path.join(makeDataDir(), 'settings.json') });
    await runtime.enqueue(SESSION, DIRECTORY, item({
      buildQueue: true,
      sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'plan' },
    }));
    await runtime.setHold(SESSION, true);

    await runtime.reorder(SESSION, [runtime.sessionSnapshot(SESSION).items[0].id]);
    const taken = await runtime.take(SESSION, runtime.sessionSnapshot(SESSION).items[0].id);
    expect(taken.item.content).toBe('follow up');

    runtime.stop();
    await runtime.flush();
  });

  it('uses the explicit continue policy even when the legacy requirement is on', async () => {
    const settingsFilePath = path.join(makeDataDir(), 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueGitPolicy: 'continue', buildQueueRequireCleanGit: true }));
    const checkBuildGit = vi.fn(async () => 'Dirty');
    const prepareBuildCommit = vi.fn();
    const { runtime, openCode } = createRuntime({ settingsFilePath, checkBuildGit, prepareBuildCommit });
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await settle(80);
    expect(checkBuildGit).not.toHaveBeenCalled();
    expect(prepareBuildCommit).not.toHaveBeenCalled();
    expect(openCode.state.sent.some(call => call.path.endsWith('/prompt'))).toBe(true);
    runtime.stop();
    await runtime.flush();
  });

  it('rechecks session activity after automatic preparation', async () => {
    const settingsFilePath = path.join(makeDataDir(), 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueGitPolicy: 'commit' }));
    const openCode = createOpenCode();
    const { runtime } = createRuntime({ settingsFilePath, openCode, prepareBuildCommit: async () => {
      openCode.state.active[SESSION] = { type: 'running' };
      return null;
    } });
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await settle(80);
    expect(openCode.state.sent).toHaveLength(0);
    expect(runtime.buildSnapshot().queued).toHaveLength(1);
    expect(runtime.buildSnapshot().active).toHaveLength(0);
    runtime.stop();
    await runtime.flush();
  });
  it('prepares one automatic commit at a time and exposes progress and result', async () => {
    const settingsFilePath = path.join(makeDataDir(), 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueGitPolicy: 'commit' }));
    let finish;
    const preparation = new Promise(resolve => { finish = resolve; });
    const prepareBuildCommit = vi.fn(async (_directory, options) => {
      options.onProgress('generating');
      await preparation;
      return { hash: 'abc123', subject: 'Save changes' };
    });
    const { runtime, openCode } = createRuntime({ settingsFilePath, prepareBuildCommit });
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await runtime.enqueue('ses_queue_test_2', DIRECTORY, item({ buildQueue: true }));
    await settle(80);
    expect(prepareBuildCommit).toHaveBeenCalledTimes(1);
    expect(runtime.buildSnapshot().preparation).toEqual([{ directory: DIRECTORY, phase: 'generating' }]);
    expect(openCode.state.sent).toHaveLength(0);
    finish();
    await settle(80);
    expect(runtime.buildSnapshot().commits).toEqual([{ directory: DIRECTORY, hash: 'abc123', subject: 'Save changes' }]);
    expect(runtime.buildSnapshot().active).toHaveLength(1);
    runtime.stop();
    await runtime.flush();
  });

  it('holds failed preparation without repeated model calls until retry', async () => {
    const settingsFilePath = path.join(makeDataDir(), 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueGitPolicy: 'commit' }));
    const prepareBuildCommit = vi.fn().mockRejectedValue(new Error('Model unavailable'));
    const { runtime, openCode } = createRuntime({ settingsFilePath, prepareBuildCommit, buildRecheckMs: 20 });
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await settle(100);
    expect(prepareBuildCommit).toHaveBeenCalledTimes(1);
    expect(runtime.buildSnapshot().queued).toHaveLength(1);
    expect(runtime.buildSnapshot().issues[0].issue).toBe('Model unavailable');
    prepareBuildCommit.mockResolvedValue(null);
    await runtime.resolveBuild(DIRECTORY, 'retry');
    await settle(80);
    expect(prepareBuildCommit).toHaveBeenCalledTimes(2);
    expect(openCode.state.sent.some(call => call.path.endsWith('/prompt'))).toBe(true);
    runtime.stop();
    await runtime.flush();
  });
  const SECOND = 'ses_queue_test_2';
  const promptCalls = (openCode) => openCode.state.sent.filter(entry => entry.path.endsWith('/prompt'));

  it('enforces FIFO across sessions until the first Build turn finishes', async () => {
    const harness = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 150, buildRecheckMs: 30 });
    const { runtime, openCode } = harness;
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
    await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'second', text: 'second', buildQueue: true }));
    await settle(80);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);
    expect(runtime.buildSnapshot().active).toHaveLength(1);
    expect(runtime.buildSnapshot().queued.map(entry => entry.sessionId)).toEqual([SECOND]);
    openCode.state.active[SESSION] = { type: 'running' };
    await settle(230);
    expect(promptCalls(openCode)).toHaveLength(1);
    delete openCode.state.active[SESSION];
    openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
    await settle(160);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'second']);
    runtime.stop();
    await runtime.flush();
  });

  it('starts a forced build outside the lease and skips the serialized instruction', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 40, buildRecheckMs: 20 });
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
    await settle(60);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);
    expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).toEqual([SESSION]);
    // The second build waits behind the lease and must not run yet.
    const waiting = await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'second', text: 'second', buildQueue: true }));
    await settle(30);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);

    await runtime.forceDispatch(DIRECTORY, SECOND, waiting.itemId);

    // It ran now, left the queue, and did not touch the running lease.
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'second']);
    expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).toEqual([SESSION]);
    expect(runtime.buildSnapshot().queued).toHaveLength(0);
    expect(runtime.buildSnapshot().forced.map(entry => entry.sessionId)).toEqual([SECOND]);
    // The forced prompt is outside the queue, so it carries no serialized-build
    // instruction; the leased build that does stays untouched.
    const forcedSynthetics = openCode.state.sent.filter(entry => entry.path.includes(SECOND) && entry.path.endsWith('/synthetic'));
    expect(forcedSynthetics.some(entry => entry.body.text.includes('serialized with other builds'))).toBe(false);
    const leaseSynthetics = openCode.state.sent.filter(entry => entry.path.includes(SESSION) && entry.path.endsWith('/synthetic'));
    expect(leaseSynthetics.some(entry => entry.body.text.includes('serialized with other builds'))).toBe(true);
    runtime.stop();
    await runtime.flush();
  });

  it('clears a forced build once its own turn completes', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
    await settle(40);
    const waiting = await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'second', text: 'second', buildQueue: true }));
    await runtime.forceDispatch(DIRECTORY, SECOND, waiting.itemId);
    expect(runtime.buildSnapshot().forced.map(entry => entry.sessionId)).toEqual([SECOND]);

    // The forced session's own turn finishes, so the marker goes away.
    openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
    await settle(80);
    expect(runtime.buildSnapshot().forced).toHaveLength(0);
    runtime.stop();
    await runtime.flush();
  });

  it('refuses to force a build whose session is busy and keeps it queued', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null });
    openCode.state.active[SECOND] = { type: 'running' };
    const queued = await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'waiting', text: 'waiting', buildQueue: true }));
    await expect(runtime.forceDispatch(DIRECTORY, SECOND, queued.itemId)).rejects.toThrow(/busy/);
    expect(runtime.buildSnapshot().queued.map(entry => entry.sessionId)).toEqual([SECOND]);
    expect(runtime.buildSnapshot().forced).toHaveLength(0);
    runtime.stop();
    await runtime.flush();
  });

  it('rejects force for an unknown build and for a non-build item', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null });
    // Keep both sessions busy so the tick cannot dispatch and remove an item
    // out from under the assertions below.
    openCode.state.active[SESSION] = { type: 'running' };
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'build', text: 'build', buildQueue: true }));
    await expect(runtime.forceDispatch(DIRECTORY, SESSION, 'queued-missing')).rejects.toThrow(/no longer queued/);
    await expect(runtime.forceDispatch(DIRECTORY, 'ses_queue_test_other', 'queued-missing')).rejects.toThrow(/not found in this project/);
    const plain = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));
    await expect(runtime.forceDispatch(DIRECTORY, SESSION, plain.itemId)).rejects.toThrow(/Only a queued build/);
    runtime.stop();
    await runtime.flush();
  });

  it('appends a further build prompt into the session\'s single lane slot', async () => {
    const harness = createRuntime();
    const { runtime, openCode } = harness;
    openCode.state.active[SESSION] = { type: 'running' };
    openCode.state.active[SECOND] = { type: 'running' };
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
    const waiting = await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'second', text: 'second', buildQueue: true }));
    await runtime.setBuildPaused(SESSION, first.itemId, true);
    const merged = await runtime.enqueue(SESSION, DIRECTORY, item({
      content: 'more',
      text: 'more',
      buildQueue: true,
      sendConfig: { providerID: 'anthropic', modelID: 'other-model', agent: 'build' },
      attachments: [{
        id: 'attach-1', filename: 'notes.txt', mimeType: 'text/plain', size: 3, source: 'local', dataUrl: 'data:text/plain,hi',
      }],
      context: [{ kind: 'synthetic', text: 'attached context' }],
    }));
    await runtime.flush();

    // The prompt joins the item the session already holds: same id, one row,
    // still ahead of the project's second build, and still paused.
    expect(merged.itemId).toBe(first.itemId);
    expect(runtime.buildSnapshot().queued.map(entry => [entry.sessionId, entry.id, entry.paused]))
      .toEqual([[SESSION, first.itemId, true], [SECOND, waiting.itemId, false]]);
    // Text, attachments and context ride that slot; its captured selection and
    // its place in the order stay as the user first set them.
    const stored = JSON.parse(fs.readFileSync(path.join(harness.dataDir, 'message-queue.json'), 'utf8'));
    const items = stored.sessions[SESSION].items;
    expect(items).toHaveLength(1);
    expect(items[0].content).toBe('first\n\nmore');
    expect(items[0].text).toBe('first\n\nmore');
    expect(items[0].attachments.map(entry => entry.filename)).toEqual(['notes.txt']);
    expect(items[0].context).toEqual([{ kind: 'synthetic', text: 'attached context' }]);
    expect(items[0].sendConfig).toEqual({ providerID: 'anthropic', modelID: 'claude', agent: 'build' });
    runtime.stop();
  });

  it('gives the lane owner\'s next build prompt to its own queue, not a second slot', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 40, buildRecheckMs: 20 });
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
    await settle(60);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);
    expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).toEqual([SESSION]);

    // The session owns the lane, so the next prompt is just a message to it.
    openCode.state.active[SESSION] = { type: 'running' };
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'more', text: 'more', buildQueue: true }));
    expect(runtime.buildSnapshot().queued).toHaveLength(0);
    const queued = runtime.sessionSnapshot(SESSION).items;
    expect(queued).toHaveLength(1);
    expect(queued[0].buildQueue).toBeUndefined();
    runtime.stop();
    await runtime.flush();
  });

  it('keeps the lane with the session until its own queue drains', async () => {
    const { runtime, openCode, emit } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    runtime.start();
    try {
      await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
      await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'second', text: 'second', buildQueue: true }));
      await settle(50);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);

      // A follow-up reaches the owner while its Build turn runs. The session's
      // own queue holds it; here a UI hold stands in for the running turn.
      await runtime.setHold(SESSION, true);
      await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'follow-up', text: 'follow-up', buildQueue: true }));
      expect(runtime.buildSnapshot().queued.map(entry => entry.sessionId)).toEqual([SECOND]);

      // The Build turn ends with a completed reply, and a build for another
      // session is next in the project order.
      openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
      emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
      await settle(60);
      expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).toEqual([SESSION]);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);

      // Once that queue drains, the lane moves on to the project's next build.
      await runtime.setHold(SESSION, false);
      await settle(150);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'follow-up', 'second']);
      expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).toEqual([SECOND]);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('pauses dirty repositories without making commits or dropping queued builds', async () => {
    let dirty = true;
    const { runtime, openCode } = createRuntime({
      checkBuildGit: async () => dirty ? 'Uncommitted changes' : null,
      buildMonitorDelayMs: 100,
      buildRecheckMs: 30,
    });
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await settle(70);
    expect(promptCalls(openCode)).toHaveLength(0);
    expect(runtime.buildSnapshot().issues[0]?.issue).toBe('Uncommitted changes');
    expect(runtime.buildSnapshot().queued).toHaveLength(1);
    dirty = false;
    await settle(130);
    expect(promptCalls(openCode)).toHaveLength(1);
    expect(openCode.state.sent.find(call => call.path.endsWith('/synthetic'))?.body.text).toMatch(/commit only your own changes/i);
    runtime.stop();
    await runtime.flush();
  });

  it('runs a build without a Git check when the clean-tree requirement is off', async () => {
    const settingsFilePath = path.join(makeDataDir(), 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueRequireCleanGit: false }));
    // No `checkBuildGit` seam and no real Git repository here: only skipping the
    // check lets the build start.
    const { runtime, openCode } = createRuntime({ buildMonitorDelayMs: 50, settingsFilePath });
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await settle(80);
    expect(promptCalls(openCode)).toHaveLength(1);
    expect(runtime.buildSnapshot().issues).toHaveLength(0);
    runtime.stop();
    await runtime.flush();
  });

  it('holds a build in a non-repository directory while the clean-tree requirement is on', async () => {
    const settingsFilePath = path.join(makeDataDir(), 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueRequireCleanGit: true }));
    const { runtime, openCode } = createRuntime({ buildMonitorDelayMs: 50, buildRecheckMs: 30, settingsFilePath });
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await settle(80);
    expect(promptCalls(openCode)).toHaveLength(0);
    expect(runtime.buildSnapshot().issues[0]?.issue).toMatch(/Cannot verify the Git working tree/i);
    runtime.stop();
    await runtime.flush();
  });

  it('does not allow the ordinary queue take endpoints to bypass queued builds', async () => {
    const { runtime, openCode } = createRuntime();
    openCode.state.active[SESSION] = { type: 'running' };
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    const queued = runtime.sessionSnapshot(SESSION).items[0];
    await expect(runtime.take(SESSION, queued.id)).rejects.toMatchObject({ status: 409 });
    expect((await runtime.takeAll(SESSION)).items).toHaveLength(0);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    runtime.stop();
    await runtime.flush();
  });

  it('persists cross-session order and leases on disk', async () => {
    const first = createRuntime({ checkBuildGit: async () => null });
    first.openCode.state.active[SESSION] = { type: 'running' };
    first.openCode.state.active[SECOND] = { type: 'running' };
    await first.runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true, text: 'one' }));
    await first.runtime.enqueue(SECOND, DIRECTORY, item({ buildQueue: true, text: 'two' }));
    const order = first.runtime.buildSnapshot().queued.map(entry => entry.id).reverse();
    await first.runtime.reorderBuilds(DIRECTORY, order);
    expect(first.runtime.buildSnapshot().queued.map(entry => entry.id)).toEqual(order);
    first.runtime.stop();
    await first.runtime.flush();
    const second = createRuntime({ dataDir: first.dataDir, checkBuildGit: async () => null });
    await second.runtime.load();
    expect(second.runtime.buildSnapshot().queued.map(entry => entry.id)).toEqual(order);
    second.runtime.stop();
    await second.runtime.flush();
  });

  it('skips a paused build for other sessions and resumes it in its original order', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 200 });
    openCode.state.active[SESSION] = { type: 'running' };
    openCode.state.active[SECOND] = { type: 'running' };
    await runtime.enqueue(SESSION, DIRECTORY, item({ text: 'paused first', buildQueue: true }));
    await runtime.enqueue(SECOND, DIRECTORY, item({ text: 'second', buildQueue: true }));
    const [first, second] = runtime.buildSnapshot().queued;
    await runtime.setBuildPaused(first.sessionId, first.id, true);
    expect(runtime.buildSnapshot().queued.find(entry => entry.id === first.id).paused).toBe(true);

    delete openCode.state.active[SECOND];
    await settle(60);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['second']);
    await runtime.setBuildPaused(first.sessionId, first.id, false);
    expect(runtime.buildSnapshot().queued.map(entry => entry.id)).toEqual([first.id]);
    expect(runtime.buildSnapshot().queued[0].paused).toBe(false);
    runtime.stop();
    await runtime.flush();
  });

  it('persists per-item pause state across restart and rejects pausing an active build', async () => {
    const first = createRuntime({ checkBuildGit: async () => null });
    first.openCode.state.active[SESSION] = { type: 'running' };
    await first.runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    const entry = first.runtime.buildSnapshot().queued[0];
    await first.runtime.setBuildPaused(SESSION, entry.id, true);
    await first.runtime.flush();
    first.runtime.stop();

    const second = createRuntime({ dataDir: first.dataDir, checkBuildGit: async () => null });
    await second.runtime.load();
    expect(second.runtime.buildSnapshot().queued[0].paused).toBe(true);
    await second.runtime.setBuildPaused(SESSION, entry.id, false);
    await settle(50);
    expect(second.runtime.buildSnapshot().active[0]?.itemId).toBe(entry.id);
    await expect(second.runtime.setBuildPaused(SESSION, entry.id, true)).rejects.toMatchObject({ status: 409 });
    second.runtime.stop();
    await second.runtime.flush();
  });

  it('rejects within-session reversal that would deadlock dispatch', async () => {
    // A queue file from a version that let one session hold two lane slots.
    const first = createRuntime({ checkBuildGit: async () => null });
    first.openCode.state.active[SESSION] = { type: 'running' };
    await first.runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
    await first.runtime.flush();
    const file = path.join(first.dataDir, 'message-queue.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    const held = stored.sessions[SESSION].items[0];
    stored.sessions[SESSION].items = [held, { ...held, id: 'queued-legacy-second', buildOrder: (held.buildOrder ?? 1) + 1 }];
    fs.writeFileSync(file, JSON.stringify(stored));
    first.runtime.stop();

    const second = createRuntime({ dataDir: first.dataDir, checkBuildGit: async () => null });
    await second.runtime.load();
    const ids = second.runtime.buildSnapshot().queued.map(entry => entry.id);
    expect(ids).toHaveLength(2);
    await expect(second.runtime.reorderBuilds(DIRECTORY, ids.slice().reverse())).rejects.toMatchObject({ status: 409 });
    expect(second.runtime.buildSnapshot().queued.map(entry => entry.id)).toEqual(ids);
    second.runtime.stop();
    await second.runtime.flush();
  });

  it('cancellation wakes the next project build', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 100 });
    openCode.state.active[SESSION] = { type: 'running' };
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'cancel me', text: 'cancel me', buildQueue: true }));
    await runtime.enqueue('ses_other', DIRECTORY, item({ content: 'start me', text: 'start me', buildQueue: true }));
    await settle(50);
    expect(promptCalls(openCode)).toHaveLength(0);
    await runtime.remove(SESSION, runtime.buildSnapshot().queued[0].id);
    await settle(80);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['start me']);
    runtime.stop();
    await runtime.flush();
  });

  it('removing an item hands its full payload back so the composer can restore it', async () => {
    const { runtime } = createRuntime();
    const context = [{ kind: 'context', text: 'linked issue', metadata: { openchamberContext: { kind: 'repository-issue', number: 7, title: 'Bug', url: 'https://x/7' } } }];
    const queued = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'planned task', text: 'planned task', context }));
    const removed = await runtime.remove(SESSION, queued.itemId);
    expect(removed.item).toMatchObject({ id: queued.itemId, content: 'planned task', text: 'planned task' });
    expect(removed.item.context).toEqual(context);
    expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
    runtime.stop();
    await runtime.flush();
  });

  it('holds an uncertain dispatch after restart until the owner resolves it', async () => {
    const first = createRuntime({ checkBuildGit: async () => null });
    first.openCode.state.active[SESSION] = { type: 'running' };
    await first.runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    // Persist an in-flight lease and its pending item, as after a crash
    // following admission but before the send acknowledgement.
    const file = path.join(first.dataDir, 'message-queue.json');
    await first.runtime.flush();
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const originalItem = first.runtime.sessionSnapshot(SESSION).items[0];
    data.activeBuilds = { [DIRECTORY]: { sessionId: SESSION, itemId: originalItem.id, startedAt: Date.now(), phase: 'dispatching' } };
    fs.writeFileSync(file, JSON.stringify(data));
    first.runtime.stop();
    const second = createRuntime({ dataDir: first.dataDir, checkBuildGit: async () => null });
    await second.runtime.load();
    expect(second.runtime.buildSnapshot().active[0].needsReview).toBe(true);
    expect(second.runtime.buildSnapshot().active[0].retryAvailable).toBe(true);
    second.runtime.start();
    await settle(75);
    expect(promptCalls(second.openCode)).toHaveLength(0);
    await second.runtime.resolveBuild(DIRECTORY, 'retry');
    await settle(65);
    expect(promptCalls(second.openCode)).toHaveLength(1);
    second.runtime.stop();
    await second.runtime.flush();
  });

  it('resumes the project lane when the lease-holding session is sent another build', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, retryDelayMs: () => 10 });
    openCode.state.failNext = /\/prompt$/;
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'frozen', text: 'frozen', buildQueue: true }));
    await settle(80);
    expect(runtime.buildSnapshot().active[0]).toMatchObject({ needsReview: true, reviewReason: 'dispatch-failed' });

    // The chat the error belongs to is where the user fixes it: a new Build
    // prompt releases the lease and takes the frozen item's place.
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'replacement', text: 'replacement', buildQueue: true }));
    expect(runtime.buildSnapshot().active).toHaveLength(0);
    await settle(80);
    // The frozen item is dropped, not resumed: only the replacement is sent.
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['replacement']);
    runtime.stop();
    await runtime.flush();
  });

  it('leaves another session unable to unfreeze the lease holder', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, retryDelayMs: () => 10 });
    openCode.state.failNext = /\/prompt$/;
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'frozen', text: 'frozen', buildQueue: true }));
    await settle(80);
    expect(runtime.buildSnapshot().active[0].needsReview).toBe(true);

    await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'other project work', text: 'other project work', buildQueue: true }));
    expect(runtime.buildSnapshot().active[0]).toMatchObject({ sessionId: SESSION, needsReview: true });
    await settle(80);
    expect(promptCalls(openCode)).toHaveLength(0);
    runtime.stop();
    await runtime.flush();
  });

  it('does not unfreeze on a plain message to the lease-holding session', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, retryDelayMs: () => 10 });
    openCode.state.failNext = /\/prompt$/;
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'frozen', text: 'frozen', buildQueue: true }));
    await settle(80);
    expect(runtime.buildSnapshot().active[0].needsReview).toBe(true);

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'what did it do?', text: 'what did it do?' }));
    expect(runtime.buildSnapshot().active[0]).toMatchObject({ sessionId: SESSION, needsReview: true });
    await settle(80);
    expect(promptCalls(openCode)).toHaveLength(0);
    runtime.stop();
    await runtime.flush();
  });

  it('rejects a new build for a storage-failed review without changing the frozen item', async () => {
    // This flag comes from the queue file failing to write at dispatch, so drive
    // that instead of seeding the reason: a restart rewrites it to
    // restart-during-dispatch. Reads stay valid; every write fails because the
    // temp file it renames into place is a directory.
    const dataDir = makeDataDir();
    const { runtime } = createRuntime({ dataDir, checkBuildGit: async () => null, retryDelayMs: () => 10 });
    const tmpPath = path.join(dataDir, `message-queue.json.${process.pid}.tmp`);
    fs.mkdirSync(tmpPath);
    try {
      await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'frozen', text: 'frozen', buildQueue: true }));
      await settle(80);
      expect(runtime.buildSnapshot().active[0]).toMatchObject({ needsReview: true, reviewReason: 'persistence-failed' });

      // The frozen item cannot safely absorb a new prompt because Continue drops
      // it. Reject while storage is broken and leave the original item intact.
      await expect(runtime.enqueue(SESSION, DIRECTORY, item({ content: 'replacement', text: 'replacement', buildQueue: true })))
        .rejects.toMatchObject({ status: 503 });
      expect(runtime.buildSnapshot().active[0]).toMatchObject({ sessionId: SESSION, needsReview: true });
      expect(runtime.buildSnapshot().queued).toHaveLength(1);
      expect(runtime.buildSnapshot().queued[0].content).toBe('frozen');
    } finally {
      fs.rmSync(tmpPath, { recursive: true, force: true });
      runtime.stop();
      await runtime.flush();
    }
  });

  it('waits for the running turn when the unfrozen build finds the session busy', async () => {
    const { runtime, openCode, emit } = createRuntime({ checkBuildGit: async () => null, retryDelayMs: () => 10, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    runtime.start();
    openCode.state.failNext = /\/prompt$/;
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'frozen', text: 'frozen', buildQueue: true }));
    await settle(80);
    expect(runtime.buildSnapshot().active[0].needsReview).toBe(true);

    // The ambiguous dispatch really did start: the session is mid-turn. The lane
    // is released, but the new build must not steer into that turn.
    openCode.state.active[SESSION] = { type: 'running' };
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'replacement', text: 'replacement', buildQueue: true }));
    expect(runtime.buildSnapshot().active).toHaveLength(0);
    expect(runtime.buildSnapshot().queued.map(entry => entry.content)).toEqual(['replacement']);
    await settle(80);
    expect(promptCalls(openCode)).toHaveLength(0);

    delete openCode.state.active[SESSION];
    await settle(30);
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(120);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['replacement']);
    runtime.stop();
    await runtime.flush();
  });

  it('rejects a project directory change in an existing queue', async () => {
    const { runtime, openCode } = createRuntime();
    openCode.state.active[SESSION] = { type: 'running' };
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await expect(runtime.enqueue(SESSION, '/other-repo', item({ buildQueue: true }))).rejects.toMatchObject({ status: 409 });
    runtime.stop();
    await runtime.flush();
  });

  it('pauses instead of retrying when an OpenCode build prompt errors ambiguously', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, retryDelayMs: () => 10 });
    openCode.state.failNext = /\/prompt$/;
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await settle(80);
    expect(promptCalls(openCode)).toHaveLength(0);
    expect(runtime.buildSnapshot().active[0]?.needsReview).toBe(true);
    expect(runtime.buildSnapshot().active[0]?.reviewReason).toBe('dispatch-failed');
    await settle(80);
    expect(promptCalls(openCode)).toHaveLength(0);
    expect(runtime.buildSnapshot().queued).toHaveLength(1);
    runtime.stop();
    await runtime.flush();
  });

  it('does not release a restored running lease on an idle snapshot without a completed reply', async () => {
    const first = createRuntime({ checkBuildGit: async () => null });
    first.openCode.state.active[SECOND] = { type: 'running' };
    await first.runtime.enqueue(SECOND, DIRECTORY, item({ buildQueue: true, text: 'after restart' }));
    await first.runtime.flush();
    const file = path.join(first.dataDir, 'message-queue.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.activeBuilds = {
      [DIRECTORY]: { sessionId: SESSION, itemId: 'previous-dispatched', startedAt: Date.now() - 10000, phase: 'running' },
    };
    fs.writeFileSync(file, JSON.stringify(stored));
    first.runtime.stop();

    const second = createRuntime({ dataDir: first.dataDir, checkBuildGit: async () => null, buildMonitorDelayMs: 25, buildRecheckMs: 20 });
    await second.runtime.load();
    expect(second.runtime.buildSnapshot().active[0].needsReview).not.toBe(true);
    second.runtime.start();
    await settle(120);
    expect(second.runtime.buildSnapshot().active[0].needsReview).toBe(true);
    expect(promptCalls(second.openCode)).toHaveLength(0);
    expect(second.runtime.buildSnapshot().queued).toHaveLength(1);
    second.runtime.stop();
    await second.runtime.flush();
  });

  it('releases a restored lease only after the original turn has a completed assistant reply', async () => {
    const first = createRuntime({ checkBuildGit: async () => null });
    first.openCode.state.active[SECOND] = { type: 'running' };
    await first.runtime.enqueue(SECOND, DIRECTORY, item({ buildQueue: true, text: 'safe successor' }));
    await first.runtime.flush();
    const file = path.join(first.dataDir, 'message-queue.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.activeBuilds = {
      [DIRECTORY]: { sessionId: SESSION, itemId: 'previous-dispatched', startedAt: Date.now() - 10000, phase: 'running' },
    };
    fs.writeFileSync(file, JSON.stringify(stored));
    first.runtime.stop();

    const second = createRuntime({ dataDir: first.dataDir, checkBuildGit: async () => null, buildMonitorDelayMs: 25, buildRecheckMs: 20 });
    second.openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
    second.runtime.start();
    await settle(120);
    expect(promptCalls(second.openCode).map(call => call.body.text)).toEqual(['safe successor']);
    second.runtime.stop();
    await second.runtime.flush();
  });

  it('offers manual recovery when a live lease stays idle without a completed reply', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null,
      buildMonitorDelayMs: 20, buildRecheckMs: 10, buildCompletionGraceMs: 40 });
    try {
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true, text: 'first' }));
      await runtime.enqueue(SECOND, DIRECTORY, item({ buildQueue: true, text: 'second' }));
      await settle(140);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);
      expect(runtime.buildSnapshot().active[0]).toMatchObject({ needsReview: true, reviewReason: 'completion-unconfirmed' });
      await runtime.resolveBuild(DIRECTORY, 'skip');
      await settle(30);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'second']);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('allows delayed startup and completion during the grace period', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null,
      buildMonitorDelayMs: 20, buildRecheckMs: 10, buildCompletionGraceMs: 200 });
    try {
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
      await runtime.enqueue(SECOND, DIRECTORY, item({ buildQueue: true }));
      await settle(45);
      expect(runtime.buildSnapshot().active[0].needsReview).not.toBe(true);
      openCode.state.active[SESSION] = { type: 'running' };
      await settle(30);
      delete openCode.state.active[SESSION];
      openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
      await settle(45);
      expect(promptCalls(openCode)).toHaveLength(2);
      expect(runtime.buildSnapshot().active.every(lease => !lease.needsReview)).toBe(true);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('does not count failed activity reads as idle time for manual recovery', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null,
      buildMonitorDelayMs: 20, buildRecheckMs: 10, buildCompletionGraceMs: 80 });
    try {
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
      await settle(35);
      openCode.state.failMessages = true;
      await settle(120);
      expect(runtime.buildSnapshot().active[0].needsReview).not.toBe(true);
      openCode.state.failMessages = false;
      await settle(35);
      expect(runtime.buildSnapshot().active[0].needsReview).not.toBe(true);
      await settle(110);
      expect(runtime.buildSnapshot().active[0].needsReview).toBe(true);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('returns 404 when attempting to pause a nonexistent build', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.setBuildPaused(SESSION, 'queued-unknown', true)).rejects.toMatchObject({ status: 404 });
    runtime.stop();
  });

  it('can bulk-take and clear a legacy Plan message flagged as a Build', async () => {
    const flagged = item({
      buildQueue: true, sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'plan' },
    });
    const { runtime, openCode } = createRuntime();
    openCode.state.active[SESSION] = { type: 'running' };
    await runtime.enqueue(SESSION, DIRECTORY, flagged);
    const result = await runtime.takeAll(SESSION);
    expect(result.items).toHaveLength(1);
    await runtime.enqueue(SESSION, DIRECTORY, flagged);
    await runtime.clear(SESSION);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(0);
    runtime.stop();
    await runtime.flush();
  });


  it('rejects To-Do parking for queued builds without dispatch', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null });
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true, text: 'Build a widget' }));
    await expect(runtime.parkSession(SESSION, DIRECTORY, async () => ({ id: 'saved-card' }))).rejects.toMatchObject({ status: 409 });
    expect(runtime.buildSnapshot().queued).toHaveLength(1);
    expect(promptCalls(openCode)).toHaveLength(0);
    runtime.stop();
    await runtime.flush();
  });

  it('rejects parking a running session and retains its queued build', async () => {
    const { runtime, openCode } = createRuntime();
    openCode.state.active[SESSION] = { type: 'running' };
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await expect(runtime.parkSession(SESSION, DIRECTORY, async () => ({ id: 'wrong' }))).rejects.toMatchObject({ status: 409 });
    expect(runtime.buildSnapshot().queued).toHaveLength(1);
    runtime.stop();
    await runtime.flush();
  });

  it('saves an idle session and propagates a failing board write', async () => {
    const { runtime } = createRuntime();
    const card = await runtime.parkSession(SESSION, DIRECTORY, async queued => {
      expect(queued).toHaveLength(0);
      return { id: 'saved' };
    });
    expect(card.id).toBe('saved');
    await expect(runtime.parkSession(SESSION, DIRECTORY, async () => { throw new Error('disk full'); })).rejects.toThrow('disk full');
    runtime.stop();
    await runtime.flush();
  });

  it('does not strand a build lease when a later turn of its session is aborted', async () => {
    // The build turn runs and completes; the operator then asks a follow-up in
    // the same chat and stops that one. The abort names the session twice over,
    // but it is not the lease's turn, so the project's build lane must flow on.
    const { runtime, openCode, emit } = createRuntime({ checkBuildGit: async () => null,
      buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    runtime.start();
    try {
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true, text: 'first' }));
      await runtime.enqueue(SECOND, DIRECTORY, item({ buildQueue: true, text: 'second' }));
      await settle(60);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);
      expect(runtime.buildSnapshot().active[0].needsReview).not.toBe(true);

      // The lease's own turn has a completed reply; a Stop now belongs to what
      // came after it.
      openCode.state.tail = [
        { type: 'idle', outcome: 'succeeded', time: { created: Date.now() } },
        { type: 'assistant', time: { completed: Date.now() } },
      ];
      emit({ type: 'session.idle', properties: { sessionID: SESSION, aborted: true, reason: 'user' } });
      await settle(60);

      expect(runtime.buildSnapshot().active[0]?.reviewReason).not.toBe('aborted');
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'second']);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('parks a build lease whose own turn is aborted before it completes', async () => {
    // A genuine interrupt: the only completed reply in the session predates
    // this lease's turn, so the lane stops. A human can still release it, and
    // doing so lets the queued successor run.
    const { runtime, openCode, emit } = createRuntime({ checkBuildGit: async () => null,
      buildMonitorDelayMs: 20, buildRecheckMs: 10, buildCompletionGraceMs: 10_000 });
    runtime.start();
    try {
      // An older, unrelated finished turn: evidence exists, but not for the lease.
      openCode.state.tail = [{ type: 'assistant', time: { completed: 1 } }];
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true, text: 'first' }));
      await runtime.enqueue(SECOND, DIRECTORY, item({ buildQueue: true, text: 'second' }));
      await settle(60);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);
      expect(runtime.buildSnapshot().active[0].needsReview).not.toBe(true);

      openCode.state.active[SESSION] = { type: 'running' };
      // Completed tool steps are not successful turn completion evidence.
      openCode.state.tail = [{ type: 'assistant', time: { created: Date.now(), completed: Date.now() } }];
      emit({ type: 'session.idle', properties: { sessionID: SESSION, aborted: true, reason: 'user' } });
      await settle(60);

      expect(runtime.buildSnapshot().active[0]).toMatchObject({ needsReview: true, reviewReason: 'aborted' });
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);

      // A busy session no longer blocks the release: the live turn is adopted as
      // this lane's active build, and the queued successor waits for it.
      const adopted = await runtime.resolveBuild(DIRECTORY, 'skip');
      expect(adopted.active[0]).toMatchObject({ sessionId: SESSION });
      expect(adopted.active[0].needsReview).not.toBe(true);
      delete openCode.state.active[SESSION];
      await expect(runtime.resolveBuild(DIRECTORY, 'skip', 'stale-item')).rejects.toMatchObject({ status: 409 });
      openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
      await settle(80);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'second']);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('finds a successful build turn on an older message page after a later interruption', async () => {
    const { runtime, openCode, emit } = createRuntime({ checkBuildGit: async () => null,
      buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    runtime.start();
    try {
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
      await settle(60);
      openCode.state.active[SESSION] = { type: 'running' };
      const succeededAt = Date.now();
      const originalFetch = openCode.fetchImpl.getMockImplementation();
      openCode.fetchImpl.mockImplementation((url, init) => {
        const parsed = new URL(url);
        if (parsed.pathname.endsWith('/message') && parsed.searchParams.get('limit') === '50') {
          if (parsed.searchParams.get('cursor') === 'older') {
            return Promise.resolve(Response.json({ data: [
              { type: 'idle', outcome: 'succeeded', time: { created: succeededAt } },
            ], cursor: {} }));
          }
          return Promise.resolve(Response.json({ data: [
            { type: 'idle', outcome: 'interrupted', time: { created: succeededAt + 1 } },
          ], cursor: { next: 'older' } }));
        }
        return originalFetch(url, init);
      });
      emit({ type: 'session.idle', properties: { sessionID: SESSION, aborted: true } });
      await settle(60);
      expect(runtime.buildSnapshot().active[0].needsReview).not.toBe(true);
      expect(openCode.fetchImpl.mock.calls.some(([url]) => new URL(url).searchParams.get('cursor') === 'older')).toBe(true);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('keeps an interrupted build paused when history cannot be read', async () => {
    const { runtime, openCode, emit } = createRuntime({ checkBuildGit: async () => null,
      buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    runtime.start();
    try {
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
      await settle(60);
      openCode.state.failMessages = true;
      emit({ type: 'session.idle', properties: { sessionID: SESSION, aborted: true } });
      await settle(60);
      expect(runtime.buildSnapshot().active[0]).toMatchObject({ needsReview: true, reviewReason: 'aborted' });
      await expect(runtime.resolveBuild(DIRECTORY, 'skip')).rejects.toMatchObject({ status: 409 });
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('holds the session queue while its lane waits for review, then delivers on resolve', async () => {
    // A frozen lane must stop delivery into its own session. Delivering there is
    // what kept the session busy and made Continue impossible to satisfy.
    const { runtime, openCode, emit } = createRuntime({ checkBuildGit: async () => null,
      buildMonitorDelayMs: 20, buildRecheckMs: 10, buildCompletionGraceMs: 10_000 });
    runtime.start();
    try {
      // An older, unrelated finished turn: evidence exists, but not for the lease.
      openCode.state.tail = [{ type: 'assistant', time: { completed: 1 } }];
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true, text: 'first' }));
      await settle(60);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);

      // The build's own turn is interrupted (the Stop), with no completion: the
      // lane parks and stays parked until a human resolves it.
      const interruptedAt = Date.now();
      openCode.state.active[SESSION] = { type: 'running' };
      openCode.state.tail = [{ type: 'idle', outcome: 'interrupted', time: { created: interruptedAt } }];
      emit({ type: 'session.idle', properties: { sessionID: SESSION, aborted: true, reason: 'user' } });
      await settle(60);
      expect(runtime.buildSnapshot().active[0]).toMatchObject({ needsReview: true, reviewReason: 'aborted' });

      // An ordinary follow-up in that session must wait, not be delivered into a
      // lane the user is being asked about.
      delete openCode.state.active[SESSION];
      await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'follow up', text: 'follow up' }));
      await settle(80);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);
      expect(runtime.sessionSnapshot(SESSION).items.map(entry => entry.content)).toEqual(['follow up']);

      // Resolving the lane releases the message that was waiting behind it.
      await runtime.resolveBuild(DIRECTORY, 'skip');
      await settle(80);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'follow up']);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('adopts a running turn on resolve instead of refusing while the session is busy', async () => {
    // The reported deadlock: a Stop parks the lane, a later message keeps the
    // session busy, and Continue then refused with "may still be running". The
    // gate asks about the lease's own turn, so the live turn is adopted.
    const { runtime, openCode, emit } = createRuntime({ checkBuildGit: async () => null,
      buildMonitorDelayMs: 20, buildRecheckMs: 10, buildCompletionGraceMs: 10_000 });
    runtime.start();
    try {
      openCode.state.tail = [{ type: 'assistant', time: { completed: 1 } }];
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true, text: 'first' }));
      await runtime.enqueue(SECOND, DIRECTORY, item({ buildQueue: true, text: 'second' }));
      await settle(60);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);

      const interruptedAt = Date.now();
      openCode.state.active[SESSION] = { type: 'running' };
      openCode.state.tail = [{ type: 'idle', outcome: 'interrupted', time: { created: interruptedAt } }];
      emit({ type: 'session.idle', properties: { sessionID: SESSION, aborted: true, reason: 'user' } });
      await settle(60);
      expect(runtime.buildSnapshot().active[0]).toMatchObject({ needsReview: true, reviewReason: 'aborted' });

      // A later turn is now running in that same session. It is not the lease's
      // turn, but it is what the user is watching, so Continue adopts it. The
      // interrupted record for the lease's own turn stays in history.
      openCode.state.tail = [
        { type: 'assistant', time: { created: interruptedAt + 1 } },
        { type: 'idle', outcome: 'interrupted', time: { created: interruptedAt } },
      ];

      const snap = await runtime.resolveBuild(DIRECTORY, 'skip', runtime.buildSnapshot().active[0].itemId);
      expect(snap.active[0]).toMatchObject({ sessionId: SESSION, phase: 'running' });
      expect(snap.active[0].needsReview).not.toBe(true);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);

      // The adopted turn finishes; the lane releases and the successor runs.
      delete openCode.state.active[SESSION];
      openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
      await settle(80);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'second']);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('releases a flagged lane whose session has since gone quietly idle', async () => {
    // The stale lease seen live: parked for review, but the session is idle with
    // a completed turn, so the lane has no reason to stay held.
    const { runtime, openCode, emit } = createRuntime({ checkBuildGit: async () => null,
      buildMonitorDelayMs: 20, buildRecheckMs: 10, buildCompletionGraceMs: 10_000 });
    runtime.start();
    try {
      openCode.state.tail = [{ type: 'assistant', time: { completed: 1 } }];
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true, text: 'first' }));
      await runtime.enqueue(SECOND, DIRECTORY, item({ buildQueue: true, text: 'second' }));
      await settle(60);

      const interruptedAt = Date.now();
      openCode.state.active[SESSION] = { type: 'running' };
      openCode.state.tail = [{ type: 'idle', outcome: 'interrupted', time: { created: interruptedAt } }];
      emit({ type: 'session.idle', properties: { sessionID: SESSION, aborted: true, reason: 'user' } });
      await settle(60);
      expect(runtime.buildSnapshot().active[0]).toMatchObject({ needsReview: true, reviewReason: 'aborted' });

      // The turn actually finished after all: the flag is stale and the monitor
      // clears it without a human. The successor then takes the lane.
      delete openCode.state.active[SESSION];
      openCode.state.tail = [{ type: 'assistant', time: { created: interruptedAt + 1, completed: Date.now() } }];
      await settle(120);
      expect(runtime.buildSnapshot().active.every(lease => lease.sessionId !== SESSION)).toBe(true);
      expect(runtime.buildSnapshot().active).toHaveLength(1);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'second']);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('keeps a persistence-failed lane parked even when the session is idle', async () => {
    // The one review reason whose flag must not self-clear: storage is the fix,
    // so the stale-flag sweep leaves it alone until a human acts.
    const dataDir = makeDataDir();
    const { runtime, openCode } = createRuntime({ dataDir, checkBuildGit: async () => null,
      buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    const tmpPath = path.join(dataDir, `message-queue.json.${process.pid}.tmp`);
    fs.mkdirSync(tmpPath);
    runtime.start();
    try {
      await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'frozen', text: 'frozen', buildQueue: true }));
      await settle(80);
      expect(runtime.buildSnapshot().active[0]).toMatchObject({ needsReview: true, reviewReason: 'persistence-failed' });

      // A completed turn and an idle session do not release this lane: only
      // repairing storage does, so the flag survives the sweep untouched.
      openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
      await settle(80);
      expect(runtime.buildSnapshot().active[0]).toMatchObject({ needsReview: true, reviewReason: 'persistence-failed' });
    } finally {
      fs.rmSync(tmpPath, { recursive: true, force: true });
      runtime.stop();
      await runtime.flush();
    }
  });

  it('persists project queue enablement and applies it to stale mobile inbox submissions', async () => {
    const first = createRuntime({ checkBuildGit: async () => null });
    const { runtime, openCode } = first;
    openCode.state.active[SESSION] = { type: 'running' };
    try {
      const enabled = await runtime.setProjectQueueEnabled(DIRECTORY, true);
      expect(enabled.projectQueueEnabled[DIRECTORY]).toBe(true);
      await runtime.enqueue(SESSION, DIRECTORY, item({
        content: 'mobile build', text: 'mobile build', buildQueue: false,
      }));
      expect(runtime.buildSnapshot().queued.map(entry => entry.content)).toEqual(['mobile build']);
      await runtime.flush();
      const saved = JSON.parse(fs.readFileSync(path.join(first.dataDir, 'message-queue.json'), 'utf8'));
      expect(saved.projectQueueEnabled[DIRECTORY]).toBe(true);
      const second = createRuntime({ dataDir: first.dataDir, checkBuildGit: async () => null });
      second.openCode.state.active[SESSION] = { type: 'running' };
      await second.runtime.load();
      expect(second.runtime.buildSnapshot().projectQueueEnabled[DIRECTORY]).toBe(true);
      expect(second.runtime.buildSnapshot().queued).toHaveLength(1);
      await second.runtime.setProjectQueueEnabled(DIRECTORY, false);
      expect(second.runtime.buildSnapshot().projectQueueEnabled[DIRECTORY]).toBe(false);
      second.openCode.state.active[SECOND] = { type: 'running' };
      await second.runtime.enqueue(SECOND, DIRECTORY, item({
        content: 'stale client', text: 'stale client', buildQueue: true,
      }));
      expect(second.runtime.buildSnapshot().queued.map(entry => entry.content)).toEqual(['mobile build']);
      second.runtime.stop();
      await second.runtime.flush();
    } finally {
      runtime.stop();
      await runtime.flush();
    }
  });

  it('does not promote Plan-agent messages into the server-enabled Build queue', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null });
    openCode.state.active[SESSION] = { type: 'running' };
    try {
      await runtime.setProjectQueueEnabled(DIRECTORY, true);
      await runtime.enqueue(SESSION, DIRECTORY, item({
        text: 'plan freely', content: 'plan freely', buildQueue: false,
        sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'plan' },
      }));
      expect(runtime.buildSnapshot().queued).toEqual([]);
      expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    } finally {
      runtime.stop();
      await runtime.flush();
    }
  });

});
