import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageQueueRuntime, parseQueuedItemInput, registerMessageQueueRoutes } from './runtime.js';
import { admitPrompt, createAdmissionFacts } from './admission.js';
import { createProjectIdFromPath } from '../projects/project-id.js';

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
    // Top-level sessions of a directory, as the header-scoped list returns them.
    sessions: [],
    tail: [],
    commands: [],
    // Background shell jobs per directory, as `GET /api/shell` lists them.
    shells: [],
    failShells: false,
    sent: [],
    switched: [],
    selection: { agent: 'build', model: { providerID: 'anthropic', id: 'claude' } },
    failNext: null,
    failMessages: false,
    // Keeps the directory-scoped session list failing while true, so a test can
    // observe the queue waiting rather than dispatching on an unknown answer.
    failList: false,
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
      if (parentID) return Response.json({ data: (state.children[parentID] ?? []).map((id) => ({ id, parentID })), cursor: {} });
      if (state.failList) return new Response('unavailable', { status: 503 });
      // The directory-scoped top-level list `findLiveBuild` reads: only sent
      // with the `x-opencode-directory` header, like the real server.
      const header = init.headers?.['x-opencode-directory'];
      if (!header) return Response.json({ data: [], cursor: {} });
      const directory = decodeURIComponent(header);
      return Response.json({ data: state.sessions.filter(session => session.location?.directory === directory), cursor: {} });
    }
    if (/^\/api\/session\/[^/]+$/.test(pathname) && method === 'GET') {
      const id = decodeURIComponent(pathname.split('/').at(-1));
      const parentID = Object.keys(state.children).find((parent) => state.children[parent].includes(id));
      return wrapped({ id, parentID, ...state.selection });
    }
    if (pathname.endsWith('/message')) return state.failMessages
      ? new Response('unavailable', { status: 503 }) : Response.json({ data: state.tail, cursor: {} });
    if (pathname === '/api/command') return wrapped(state.commands);
    if (pathname === '/api/shell') {
      if (state.failShells) return new Response('unavailable', { status: 503 });
      // Directory-scoped by the encoded header, like the real route.
      const header = init.headers?.['x-opencode-directory'];
      const directory = header ? decodeURIComponent(header) : DIRECTORY;
      return wrapped(state.shells.filter(shell => shell.directory === directory));
    }
    if (method === 'POST' && (pathname.endsWith('/model') || pathname.endsWith('/agent'))) {
      // Kept apart from `sent`: switching the session is not a message.
      state.switched.push({ path: pathname, body: JSON.parse(init.body) });
      Object.assign(state.selection, JSON.parse(init.body));
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

const createRuntime = ({ dataDir = makeDataDir(), openCode = createOpenCode(), knowledge = null, tree = { describe: async () => 'Build starts from commit `123456789` on "main". Working tree clean.', settle: async () => {} }, retryDelayMs, resolveAutoSelection, now, beforeScheduledTaskSend, onScheduledTaskResult, persistSessionGoal, checkBuildGit, prepareBuildCommit, resolveRepositoryRoot, buildMonitorDelayMs, buildRecheckMs, buildCompletionGraceMs, settingsFilePath, projectConfigRuntime, resolveProjectIdentity } = {}) => {
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
    sessionTreeRuntime: tree,
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
  if (resolveRepositoryRoot) options.resolveRepositoryRoot = resolveRepositoryRoot;
  if (buildMonitorDelayMs !== undefined) options.buildMonitorDelayMs = buildMonitorDelayMs;
  if (buildRecheckMs !== undefined) options.buildRecheckMs = buildRecheckMs;
  if (buildCompletionGraceMs !== undefined) options.buildCompletionGraceMs = buildCompletionGraceMs;
  if (settingsFilePath !== undefined) options.settingsFilePath = settingsFilePath;
  if (projectConfigRuntime !== undefined) options.projectConfigRuntime = projectConfigRuntime;
  if (resolveProjectIdentity !== undefined) options.resolveProjectIdentity = resolveProjectIdentity;
  if (persistSessionGoal) options.persistSessionGoal = persistSessionGoal;
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

  it('keeps a goal captured with the message and rejects one it could not start', () => {
    expect(parseQueuedItemInput(item({ goal: { tokenBudget: null } })).goal).toEqual({ tokenBudget: null });
    expect(parseQueuedItemInput(item({ goal: { objective: ' the plan ', tokenBudget: 5000 } })).goal)
      .toEqual({ objective: 'the plan', tokenBudget: 5000 });
    expect(parseQueuedItemInput(item()).goal).toBeUndefined();
    expect(() => parseQueuedItemInput(item({ goal: { tokenBudget: -1 } }))).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ goal: 'yes' }))).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ content: '', text: '', context: [{ kind: 'synthetic', text: 'x' }], goal: { tokenBudget: null } }))).toThrow(TypeError);
  });
});

describe('a message queued as a goal', () => {
  const previousDataDir = process.env.OPENCHAMBER_DATA_DIR;
  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.OPENCHAMBER_DATA_DIR;
    else process.env.OPENCHAMBER_DATA_DIR = previousDataDir;
  });

  it('starts the goal when that message goes out, not with the message before it', async () => {
    const goalsDataDir = makeDataDir();
    process.env.OPENCHAMBER_DATA_DIR = goalsDataDir;
    const persisted = [];
    const { runtime, openCode, emit } = createRuntime({
      persistSessionGoal: async (sessionID, directory, goal) => {
        persisted.push({ sessionID, directory, goal, sentBefore: openCode.state.sent.length });
      },
    });
    runtime.start();
    openCode.state.active = { [SESSION]: { type: 'running' } };
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain first', text: 'plain first' }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'build the parser', text: 'build the parser', goal: { tokenBudget: 5000 } }));
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.goal)).toEqual([undefined, { tokenBudget: 5000 }]);

    openCode.state.active = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent.map((entry) => entry.body.text)).toEqual(['plain first']);
    expect(persisted).toEqual([]);

    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'busy' } } });
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      sessionID: SESSION,
      directory: DIRECTORY,
      goal: { status: 'active', objectiveFile: true, tokenBudget: 5000 },
      sentBefore: 1,
    });
    expect(fs.readFileSync(path.join(goalsDataDir, 'goals', `${SESSION}.md`), 'utf8')).toBe('build the parser');
    // The briefing goes ahead of the message, as for a scheduled goal.
    expect(openCode.state.sent.slice(1).map((entry) => [entry.path, entry.body])).toEqual([
      [`/api/session/${SESSION}/synthetic`, { text: expect.stringContaining('Goal mode is active'), resume: false }],
      [`/api/session/${SESSION}/prompt`, { text: 'build the parser' }],
    ]);
    expect(openCode.state.sent[1].body.text).toContain('A token budget of 5000 tokens');
  });

  it('admits nothing when the goal cannot be saved, so a retry cannot duplicate the context', async () => {
    process.env.OPENCHAMBER_DATA_DIR = makeDataDir();
    const { runtime, openCode, emit } = createRuntime({
      retryDelayMs: () => 60_000,
      persistSessionGoal: async () => { throw new Error('metadata store down'); },
    });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ context: [{ kind: 'synthetic', text: 'attached' }], goal: { tokenBudget: null } }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toEqual([]);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
  });

  it('uses the objective the arming flow supplied', async () => {
    process.env.OPENCHAMBER_DATA_DIR = makeDataDir();
    const persisted = [];
    const { runtime, emit } = createRuntime({
      persistSessionGoal: async (_sessionID, _directory, goal) => { persisted.push(goal); },
    });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'Implement this plan: X', text: 'Implement this plan: X', goal: { objective: 'the whole plan', tokenBudget: null } }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(persisted).toHaveLength(1);
    expect(fs.readFileSync(path.join(process.env.OPENCHAMBER_DATA_DIR, 'goals', `${SESSION}.md`), 'utf8')).toBe('the whole plan');
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
    // A session seen busy re-arms a recheck on the real clock before it
    // delivers; the recheck is what keeps a job-held session from waiting on an
    // event that never comes.
    await new Promise(resolve => setTimeout(resolve, 5100));
    await settle(50);
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
    // Initial and final activity probes — the active map, the pre-boot message
    // tail and the session's shell list each — then session selection and the
    // send.
    const idleProbe = () => [
      async () => Response.json({ location: {}, data: {} }),
      async () => Response.json({ data: [], cursor: {} }),
      async () => Response.json({ location: { directory: DIRECTORY }, data: [] }),
      async () => Response.json({ data: {} }),
    ];
    // Two activity probes, each followed by the descendant walk's own shell
    // list read.
    for (const probe of [...idleProbe(), idleProbe()[2], ...idleProbe(), idleProbe()[2]]) openCode.fetchImpl.mockImplementationOnce(probe);
    openCode.fetchImpl.mockImplementationOnce(async () => new Response(null, { status: 204 }))
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

  it('delivers captured context as synthetic messages, instructions first', async () => {
    const { runtime, openCode, emit } = createRuntime();
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
      `/api/session/${SESSION}/prompt`,
    ]);
    expect(openCode.state.sent.slice(0, 4).map((entry) => entry.body)).toEqual([
      { text: 'how to read it', resume: false },
      { text: 'the diff', resume: false, metadata },
      { text: 'conflict payload', resume: false },
      { text: 'use the skill', resume: false },
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

  it('writes the project knowledge into the session before a queued command', async () => {
    const openCode = createOpenCode();
    const knowledge = {
      sync: async (sessionId, directory) => { openCode.state.sent.push({ path: 'knowledge', body: { sessionId, directory } }); },
    };
    const { runtime, emit } = createRuntime({ openCode, knowledge });
    runtime.start();
    openCode.state.commands = [{ name: 'review' }];
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '/review', text: '/review' }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent).toEqual([
      { path: 'knowledge', body: { sessionId: SESSION, directory: DIRECTORY } },
      expect.objectContaining({ path: `/api/session/${SESSION}/command` }),
    ]);
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

  it('writes the project knowledge into the session before the prompt, and sends anyway when that fails', async () => {
    const openCode = createOpenCode();
    const knowledge = {
      // `sync` reports failure by resolving false; it never throws.
      sync: async (sessionId, directory) => { openCode.state.sent.push({ path: 'knowledge', body: { sessionId, directory } }); return false; },
    };
    const { runtime, emit } = createRuntime({ openCode, knowledge });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ context: [{ kind: 'context', text: 'quoted', metadata: {} }] }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent.map((entry) => entry.path)).toEqual([
      'knowledge',
      `/api/session/${SESSION}/synthetic`,
      `/api/session/${SESSION}/prompt`,
    ]);
    expect(openCode.state.sent[0].body).toEqual({ sessionId: SESSION, directory: DIRECTORY });
  });
});

describe('project-wide build queue', () => {
  it('announces the build queue the moment a build is enqueued', async () => {
    // The work board and the chat's compact indicator read this snapshot. Without the
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

  it('reads startup context only at dispatch, after preparation, without a queue sentence for an immediate start', async () => {
    const settingsFilePath = path.join(makeDataDir(), 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueGitPolicy: 'commit' }));
    let head = 'before';
    const tree = { settle: vi.fn(async () => {}), describe: vi.fn(async () => `Build starts from commit ${head}. Working tree clean.`) };
    const { runtime, openCode } = createRuntime({ settingsFilePath, tree, prepareBuildCommit: async () => {
      expect(tree.settle).toHaveBeenCalledWith(SESSION, DIRECTORY);
      head = 'after-preparation';
      return null;
    } });
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    expect(tree.describe).not.toHaveBeenCalled();
    expect(openCode.state.sent).toEqual([]);
    await settle(80);
    expect(openCode.state.sent[0].body.text).toBe('Build starts from commit after-preparation. Working tree clean.');
    expect(openCode.state.sent[1].path).toContain('/prompt');
    runtime.stop();
    await runtime.flush();
  });

  it('combines fresh tree facts and the short queue sentence after a real wait, including a restart', async () => {
    const dataDir = makeDataDir();
    const settingsFilePath = path.join(dataDir, 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueGitPolicy: 'continue' }));
    const first = createRuntime({ dataDir, settingsFilePath });
    await first.runtime.setQueuePaused(DIRECTORY, true);
    await first.runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await settle(50);
    expect(first.openCode.state.sent).toEqual([]);
    first.runtime.stop();
    await first.runtime.flush();
    const tree = { settle: async () => {}, describe: vi.fn(async () => 'Build starts from commit fresh. Working tree clean.') };
    const second = createRuntime({ dataDir, settingsFilePath, tree });
    await second.runtime.setQueuePaused(DIRECTORY, false);
    await settle(100);
    expect(second.openCode.state.sent[0].body.text).toBe('Build starts from commit fresh. Working tree clean.\n\nThis build is serialized with other builds in this repository.');
    expect(second.openCode.state.sent.filter(call => call.path.endsWith('/synthetic'))).toHaveLength(1);
    second.runtime.stop();
    await second.runtime.flush();
  });

  it('does not re-read the checkout for the session that held the last build lease', async () => {
    // A build that exited, was stopped or was reprompted knows the tree it left.
    const dataDir = makeDataDir();
    const settingsFilePath = path.join(dataDir, 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueGitPolicy: 'continue' }));
    const first = createRuntime({ dataDir, settingsFilePath });
    await first.runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await settle(80);
    expect(first.openCode.state.sent.some(call => call.path.endsWith('/prompt'))).toBe(true);
    first.runtime.stop();
    await first.runtime.flush();
    // The turn finished with its lease held; a restart restores it as the owner.
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'message-queue.json'), 'utf8')).lastBuildOwners)
      .toEqual({ [DIRECTORY]: SESSION });

    const tree = { settle: async () => {}, describe: vi.fn(async () => 'Build starts from commit fresh. Working tree clean.') };
    const second = createRuntime({ dataDir, settingsFilePath, tree });
    await second.runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await settle(200);
    expect(tree.describe).not.toHaveBeenCalled();
    expect(second.openCode.state.sent.filter(call => call.path.endsWith('/synthetic'))).toEqual([]);
    expect(second.openCode.state.sent.some(call => call.path.endsWith('/prompt'))).toBe(true);
    second.runtime.stop();
    await second.runtime.flush();
  });

  it('records the owner only when the build claims the lease, and keeps the queue sentence', async () => {
    const dataDir = makeDataDir();
    const settingsFilePath = path.join(dataDir, 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueGitPolicy: 'continue' }));
    const tree = { settle: async () => {}, describe: vi.fn(async () => 'Build starts from commit fresh. Working tree clean.') };
    const { runtime, openCode } = createRuntime({ dataDir, settingsFilePath, tree });
    await runtime.setQueuePaused(DIRECTORY, true);
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    const stored = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'message-queue.json'), 'utf8'));
    expect(stored().lastBuildOwners).toEqual({});
    await runtime.setQueuePaused(DIRECTORY, false);
    await settle(100);
    expect(stored().lastBuildOwners).toEqual({ [DIRECTORY]: SESSION });
    // The tree facts were read once for the first holder; the wait is still stated.
    expect(openCode.state.sent[0].body.text).toBe('Build starts from commit fresh. Working tree clean.\n\nThis build is serialized with other builds in this repository.');
    runtime.stop();
    await runtime.flush();
  });

  it('does inject the checkout when another session held the last build lease', async () => {
    const dataDir = makeDataDir();
    const settingsFilePath = path.join(dataDir, 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueGitPolicy: 'continue' }));
    fs.writeFileSync(path.join(dataDir, 'message-queue.json'), JSON.stringify({
      version: 2, revision: 4, nextBuildOrder: 3, pausedDirectories: [],
      activeBuilds: {}, forceReservations: {}, lastBuildOwners: { [DIRECTORY]: 'ses_previous_owner' }, sessions: {},
    }));
    const tree = { settle: async () => {}, describe: vi.fn(async () => 'Build starts from commit fresh. Working tree clean.') };
    const { runtime, openCode } = createRuntime({ dataDir, settingsFilePath, tree });
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await settle(80);
    expect(tree.describe).toHaveBeenCalledWith(SESSION, DIRECTORY);
    expect(openCode.state.sent[0].body.text).toBe('Build starts from commit fresh. Working tree clean.');
    expect(openCode.state.sent[1].path).toContain('/prompt');
    runtime.stop();
    await runtime.flush();
  });

  it('still sends the user prompt when tree context fails', async () => {
    const settingsFilePath = path.join(makeDataDir(), 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueGitPolicy: 'continue' }));
    const { runtime, openCode } = createRuntime({ settingsFilePath, tree: { settle: async () => {}, describe: async () => { throw new Error('Git unavailable'); } } });
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await settle(80);
    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].path).toContain('/prompt');
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
  const THIRD = 'ses_queue_test_3';
  const promptCalls = (openCode) => openCode.state.sent.filter(entry => entry.path.endsWith('/prompt'));
  const runningShell = (sessionID, directory = DIRECTORY, startedAt = Date.now()) => ({
    id: `sh_${sessionID}`, status: 'running', directory, metadata: { sessionID }, time: { started: startedAt },
  });

  it('releases a build whose turn finishes with no background job', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
    await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'second', text: 'second', buildQueue: true }));
    await settle(80);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);
    delete openCode.state.active[SESSION];
    openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
    await settle(200);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'second']);
    runtime.stop();
    await runtime.flush();
  });

  it('holds a build whose own session still has a background job', async () => {
    // A build that ran a helper with `background: true` has a finished turn and
    // no subagent, but OpenCode resumes the session when the job exits. The
    // dispatch lease must not be released, and the lane must not park either.
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
    await settle(80);
    openCode.state.shells = [runningShell(SESSION, DIRECTORY, Date.now() - 5000)];
    delete openCode.state.active[SESSION];
    openCode.state.tail = [{ type: 'assistant', time: { created: Date.now(), completed: Date.now() } }];
    await settle(200);
    expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).toEqual([SESSION]);
    expect(runtime.buildSnapshot().issues).toHaveLength(0);

    // The job exits: the turn really is over and the lane lets go.
    openCode.state.shells = [];
    await new Promise(resolve => setTimeout(resolve, 5100));
    await settle(100);
    expect(runtime.buildSnapshot().active).toHaveLength(0);
    runtime.stop();
    await runtime.flush();
  });

  it('keeps the lane when the shell list cannot be read', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    // A second session already runs a Build turn in this project, and the list
    // that would say whether it survives cannot be read: the lane must not be
    // released onto that uncertainty, nor parked for review.
    const live = 'ses_queue_test_live';
    openCode.state.active[live] = { type: 'running' };
    openCode.state.sessions = [{ id: live, agent: 'build', location: { directory: DIRECTORY } }];
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
    await settle(80);
    expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).toEqual([live]);

    openCode.state.failShells = true;
    delete openCode.state.active[live];
    openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
    await settle(100);
    expect(promptCalls(openCode)).toHaveLength(0);
    expect(runtime.buildSnapshot().active).toHaveLength(1);
    expect(runtime.buildSnapshot().issues).toHaveLength(0);

    openCode.state.failShells = false;
    await settle(100);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);
    runtime.stop();
    await runtime.flush();
  });

  it('does not deliver into a session that still has a background job', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    openCode.state.shells = [runningShell(SESSION, DIRECTORY, Date.now() - 5000)];

    // A queued follow-up waits: OpenCode resumes the session when the job
    // exits, so the message belongs after that resumed turn.
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'follow up', text: 'follow up' }));
    await settle(150);
    expect(promptCalls(openCode)).toHaveLength(0);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);

    // The session was seen busy, so the queue rechecks on the real clock before
    // it delivers.
    openCode.state.shells = [];
    await new Promise(resolve => setTimeout(resolve, 5100));
    await settle(50);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['follow up']);
    runtime.stop();
    await runtime.flush();
  });

  it('adopts a build session that is idle but still running a background job', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 30, buildRecheckMs: 10, buildCompletionGraceMs: 60 });
    const live = 'ses_queue_test_live';
    openCode.state.sessions = [{ id: live, agent: 'build', location: { directory: DIRECTORY } }];
    openCode.state.shells = [runningShell(live, DIRECTORY, Date.now() - 5000)];
    openCode.state.tail = [{ type: 'assistant', time: { created: Date.now() - 6000, completed: Date.now() - 5000 } }];

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'queued', text: 'queued', buildQueue: true }));
    await settle(80);
    expect(promptCalls(openCode)).toHaveLength(0);
    expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).toEqual([live]);
    expect(runtime.buildSnapshot().queued.map(entry => entry.sessionId)).toEqual([SESSION]);

    // The job exits, the adopted lane lets go, and the queued build starts.
    openCode.state.shells = [];
    await settle(400);
    expect(promptCalls(openCode).map(call => call.body.text)).toContain('queued');
    runtime.stop();
    await runtime.flush();
  });

  it('waits for a background job in a subagent of the build', async () => {
    // The child's job resumes the child, which reruns the parent: the lane must
    // not let go while a descendant job runs, even with the parent idle.
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    const child = 'ses_queue_test_child';
    openCode.state.children[SESSION] = [child];
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'held', text: 'held', buildQueue: true }));
    await settle(80);
    openCode.state.shells = [runningShell(child, DIRECTORY, Date.now() - 5000)];
    delete openCode.state.active[SESSION];
    openCode.state.tail = [{ type: 'assistant', time: { created: Date.now(), completed: Date.now() } }];
    await settle(200);
    expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).toEqual([SESSION]);
    expect(runtime.buildSnapshot().issues).toHaveLength(0);

    openCode.state.shells = [];
    await new Promise(resolve => setTimeout(resolve, 5100));
    await settle(100);
    expect(runtime.buildSnapshot().active).toHaveLength(0);
    runtime.stop();
    await runtime.flush();
  });


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

  it('names the submitted model and the build message on the queue card', async () => {
    const { runtime } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 40 });
    await runtime.enqueue(SESSION, DIRECTORY, item({
      content: 'first task\n\nsecond task', text: 'first task\n\nsecond task', buildQueue: true,
      sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'build' },
    }));
    // Waiting: the row carries the model it was submitted with.
    expect(runtime.buildSnapshot().queued[0].model).toEqual({ providerID: 'anthropic', id: 'claude' });

    await settle(60);
    // Running: the lease keeps the message and the model after the item leaves.
    const [lease] = runtime.buildSnapshot().active;
    expect(lease.content).toBe('first task\n\nsecond task');
    expect(lease.model).toEqual({ providerID: 'anthropic', id: 'claude' });
    expect(runtime.buildSnapshot().queued).toHaveLength(0);
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
    await runtime.setQueuePaused(DIRECTORY, true);
    const waiting = await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'second', text: 'second', buildQueue: true }));
    await settle(30);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);

    await runtime.forceDispatch(DIRECTORY, SECOND, waiting.itemId);

    // It ran now, left the queue, and did not touch the running lease.
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'second']);
    expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).toEqual([SESSION]);
    expect(runtime.buildSnapshot().queued).toHaveLength(0);
    expect(runtime.buildSnapshot().forced.map(entry => entry.sessionId)).toEqual([SECOND]);
    expect(runtime.buildSnapshot().pausedDirectories).toEqual([DIRECTORY]);
    // The card still names the build's message and submitted model after the
    // item leaves the queue.
    expect(runtime.buildSnapshot().forced[0].content).toBe('second');
    expect(runtime.buildSnapshot().forced[0].model).toEqual({ providerID: 'anthropic', id: 'claude' });
    // The forced prompt is outside the queue, so it carries no serialized-build
    // instruction; the leased build that does stays untouched.
    const forcedSynthetics = openCode.state.sent.filter(entry => entry.path.includes(SECOND) && entry.path.endsWith('/synthetic'));
    expect(forcedSynthetics.some(entry => entry.body.text.includes('serialized with other builds'))).toBe(false);
    const leaseSynthetics = openCode.state.sent.filter(entry => entry.path.includes(SESSION) && entry.path.endsWith('/synthetic'));
    expect(leaseSynthetics.some(entry => entry.body.text.includes('serialized with other builds'))).toBe(false);
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

  it('counts a build forced into the queue, so the queue waits for it', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 40, buildRecheckMs: 20 });
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
    await settle(60);
    const waiting = await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'second', text: 'second', buildQueue: true }));
    await runtime.enqueue(THIRD, DIRECTORY, item({ content: 'third', text: 'third', buildQueue: true }));
    await settle(30);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);

    // The second build starts now, beside the one already running, and it
    // counts towards the queue.
    await runtime.forceDispatch(DIRECTORY, SECOND, waiting.itemId, 'queue');
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'second']);
    expect(runtime.buildSnapshot().forced[0].counts).toBe(true);

    // The forced build is still working, and the lease ends.
    openCode.state.active[SECOND] = { type: 'running' };
    openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
    await settle(200);
    // The queue waits for the build it counts, so the third one has not started.
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'second']);
    expect(runtime.buildSnapshot().active).toHaveLength(0);

    // The forced build's own turn ends, and the queue moves on.
    delete openCode.state.active[SECOND];
    openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
    await settle(200);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'second', 'third']);
    runtime.stop();
    await runtime.flush();
  });

  it('leaves the queue alone when a build is forced outside it', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 40, buildRecheckMs: 20 });
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
    await settle(60);
    const waiting = await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'second', text: 'second', buildQueue: true }));
    await runtime.enqueue(THIRD, DIRECTORY, item({ content: 'third', text: 'third', buildQueue: true }));
    await settle(30);

    await runtime.forceDispatch(DIRECTORY, SECOND, waiting.itemId);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'second']);
    expect(runtime.buildSnapshot().forced[0].counts).toBe(false);

    // The forced build is still working when the lease ends, and the queue does
    // not wait for it.
    openCode.state.active[SECOND] = { type: 'running' };
    openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
    await settle(200);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first', 'second', 'third']);
    runtime.stop();
    await runtime.flush();
  });

  it('refuses a force whose mode it does not know', async () => {
    const { runtime } = createRuntime({ checkBuildGit: async () => null });
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
    const waiting = await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'second', text: 'second', buildQueue: true }));
    await expect(runtime.forceDispatch(DIRECTORY, SECOND, waiting.itemId, 'beside')).rejects.toThrow(/mode/);
    runtime.stop();
    await runtime.flush();
  });

  it('adopts a Build turn already running in the project instead of starting beside it', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 30, buildRecheckMs: 10 });
    // A build started before this project's queue was on: busy, in this
    // directory, running the build agent, holding no lease.
    const live = 'ses_queue_test_live';
    openCode.state.active[live] = { type: 'running' };
    openCode.state.sessions = [{ id: live, agent: 'build', location: { directory: DIRECTORY } }];

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'queued', text: 'queued', buildQueue: true }));
    await settle(60);

    // The queued build must not have started; the live turn is the active build.
    expect(promptCalls(openCode)).toHaveLength(0);
    expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).toEqual([live]);
    expect(runtime.buildSnapshot().queued.map(entry => entry.sessionId)).toEqual([SESSION]);

    runtime.stop();
    await runtime.flush();
  });

  it('releases an adopted lane when its own turn finishes', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    const live = 'ses_queue_test_live';
    openCode.state.active[live] = { type: 'running' };
    openCode.state.sessions = [{ id: live, agent: 'build', location: { directory: DIRECTORY } }];
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'queued', text: 'queued', buildQueue: true }));
    await settle(50);
    expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).toEqual([live]);

    // The adopted turn ends: its session goes idle with a completed reply.
    delete openCode.state.active[live];
    openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
    await settle(80);
    // The adopted lease is what ends here; the queued build then dispatches and
    // takes its own lane, so the live session is no longer the active build.
    expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).not.toContain(live);
    expect(promptCalls(openCode).map(call => call.body.text)).toContain('queued');

    runtime.stop();
    await runtime.flush();
  });

  it('does not adopt a forced build or a Plan session', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    // Force needs an idle session to start; it runs outside the queue by design.
    const forced = 'ses_queue_test_forced';
    await runtime.enqueue(forced, DIRECTORY, item({ content: 'force me', text: 'force me', buildQueue: true }));
    const forcedId = (await runtime.snapshot()).sessions.find(entry => entry.sessionId === forced).items[0].id;
    await runtime.forceDispatch(DIRECTORY, forced, forcedId);
    expect(runtime.buildSnapshot().forced.map(entry => entry.sessionId)).toEqual([forced]);
    // The forced turn is running now, and it is a Build session of this project,
    // so only its exclusion from adoption keeps the lane free.
    openCode.state.active[forced] = { type: 'running' };
    // A Plan session running in the same directory is not build work either.
    const plan = 'ses_queue_test_plan';
    openCode.state.active[plan] = { type: 'running' };
    openCode.state.sessions = [
      { id: forced, agent: 'build', location: { directory: DIRECTORY } },
      { id: plan, agent: 'plan', location: { directory: DIRECTORY } },
    ];
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'queued', text: 'queued', buildQueue: true }));
    await settle(60);
    // Neither the forced build nor the Plan turn holds the lane, so the queued
    // build ran rather than waiting for either.
    expect(promptCalls(openCode).map(call => call.body.text)).toContain('queued');
    expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).toEqual([SESSION]);
    runtime.stop();
    await runtime.flush();
  });

  it('does not adopt a forced build that is held only by its background job', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10, buildCompletionGraceMs: 60 });
    // The force's own turn is over, but the job it started still runs, so the
    // outside-queue marker stays on it. It is a Build session of this project,
    // and only its exclusion keeps the lane free for the newly queued build.
    const forced = 'ses_queue_test_forced';
    await runtime.enqueue(forced, DIRECTORY, item({ content: 'force me', text: 'force me', buildQueue: true }));
    const forcedId = (await runtime.snapshot()).sessions.find(entry => entry.sessionId === forced).items[0].id;
    await runtime.forceDispatch(DIRECTORY, forced, forcedId);
    openCode.state.sessions = [{ id: forced, agent: 'build', location: { directory: DIRECTORY } }];
    openCode.state.shells = [runningShell(forced, DIRECTORY, Date.now() - 5000)];
    openCode.state.tail = [{ type: 'assistant', time: { created: Date.now() - 6000, completed: Date.now() - 5000 } }];

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'queued', text: 'queued', buildQueue: true }));
    await settle(80);
    // The force is one row outside the queue, not a second active build: the
    // queued build starts instead of waiting behind the job.
    expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).toEqual([SESSION]);
    expect(runtime.buildSnapshot().forced.map(entry => entry.sessionId)).toEqual([forced]);
    expect(promptCalls(openCode).map(call => call.body.text)).toContain('queued');

    runtime.stop();
    await runtime.flush();
  });

  it('waits while the live build list is unreadable, and dispatches once it reads', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    // Something is running in this project, and the directory list that would
    // say whether it is a Build keeps failing: a live build cannot be ruled out,
    // so the queued build must wait rather than start beside it.
    openCode.state.active.ses_queue_test_other = { type: 'running' };
    openCode.state.failList = true;
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'queued', text: 'queued', buildQueue: true }));
    await settle(60);
    expect(promptCalls(openCode)).toHaveLength(0);
    expect(runtime.buildSnapshot().active).toHaveLength(0);

    // The list reads again and names no Build of this directory, so the queued
    // build runs as before.
    openCode.state.failList = false;
    delete openCode.state.active.ses_queue_test_other;
    await settle(60);
    expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['queued']);
    runtime.stop();
    await runtime.flush();
  });

  it('does not persist an adopted lane across a restart', async () => {
    const { runtime, openCode, dataDir } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    const live = 'ses_queue_test_live';
    openCode.state.active[live] = { type: 'running' };
    openCode.state.sessions = [{ id: live, agent: 'build', location: { directory: DIRECTORY } }];
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'queued', text: 'queued', buildQueue: true }));
    await settle(50);
    expect(runtime.buildSnapshot().active.map(lease => lease.sessionId)).toEqual([live]);
    runtime.stop();
    await runtime.flush();

    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'message-queue.json'), 'utf8'));
    expect(stored.activeBuilds).toEqual({});
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

  it('holds an ambiguous force durably and refuses a second force of the same item', async () => {
    const { runtime, openCode, dataDir } = createRuntime({ checkBuildGit: async () => null });
    const queued = await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'force me', text: 'force me', buildQueue: true }));
    // Paused keeps the dispatch tick off the item, so only the Force can send it.
    await runtime.setBuildPaused(SECOND, queued.itemId, true);
    // The idle probes pass; the prompt itself fails ambiguously.
    openCode.state.failNext = /\/prompt$/;
    const result = await runtime.forceDispatch(DIRECTORY, SECOND, queued.itemId);
    expect(result.warning).toContain('not confirmed');
    // The item stays queued, the uncertain force is visible as a recovery, and
    // a second force of the same item cannot dispatch it again.
    expect(runtime.buildSnapshot().queued.map(entry => entry.id)).toEqual([queued.itemId]);
    const forced = runtime.buildSnapshot().forced;
    expect(forced).toHaveLength(1);
    expect(forced[0]).toMatchObject({ sessionId: SECOND, itemId: queued.itemId, needsReview: true });
    await expect(runtime.forceDispatch(DIRECTORY, SECOND, queued.itemId)).rejects.toThrow(/already being sent/);
    // The reservation is durable: it was written before the prompt.
    await runtime.flush();
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'message-queue.json'), 'utf8'));
    expect(persisted.forceReservations?.[SECOND]?.itemId).toBe(queued.itemId);
    // The user resolves it: the marker clears and the item stays queued.
    await runtime.resolveBuild(DIRECTORY, 'skip', queued.itemId);
    expect(runtime.buildSnapshot().forced).toHaveLength(0);
    expect(runtime.buildSnapshot().queued.map(entry => entry.id)).toEqual([queued.itemId]);
    runtime.stop();
    await runtime.flush();
  });

  it('restores an unresolved force reservation on restart, without re-sending it', async () => {
    const { runtime, openCode, dataDir } = createRuntime({ checkBuildGit: async () => null });
    const queued = await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'force me', text: 'force me', buildQueue: true }));
    await runtime.setBuildPaused(SECOND, queued.itemId, true);
    openCode.state.failNext = /\/prompt$/;
    await runtime.forceDispatch(DIRECTORY, SECOND, queued.itemId);
    runtime.stop();
    await runtime.flush();

    const restarted = createRuntime({ checkBuildGit: async () => null, dataDir });
    await restarted.runtime.load();
    const forced = restarted.runtime.buildSnapshot().forced;
    expect(forced).toHaveLength(1);
    expect(forced[0]).toMatchObject({ sessionId: SECOND, itemId: queued.itemId, needsReview: true });
    // Nothing was dispatched again while the state is uncertain.
    expect(promptCalls(restarted.openCode)).toHaveLength(0);
    await restarted.runtime.resolveBuild(DIRECTORY, 'skip', queued.itemId);
    expect(restarted.runtime.buildSnapshot().forced).toHaveLength(0);
    restarted.runtime.stop();
    await restarted.runtime.flush();
  });

  it('keeps a reviewed lease parked while its build is still queued', async () => {
    const first = createRuntime({ checkBuildGit: async () => null });
    // The session stays busy so the build stays queued, then a restored
    // dispatching lease points at it, as after a crash mid-dispatch.
    first.openCode.state.active[SESSION] = { type: 'running' };
    await first.runtime.enqueue(SESSION, DIRECTORY, item({ content: 'uncertain', text: 'uncertain', buildQueue: true }));
    await first.runtime.flush();
    const queuedItem = first.runtime.sessionSnapshot(SESSION).items[0];
    const file = path.join(first.dataDir, 'message-queue.json');
    const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
    stored.activeBuilds = { [DIRECTORY]: { sessionId: SESSION, itemId: queuedItem.id, startedAt: Date.now() - 10000, phase: 'dispatching' } };
    fs.writeFileSync(file, JSON.stringify(stored));
    first.runtime.stop();

    const second = createRuntime({ dataDir: first.dataDir, checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    // The turn verifiably completed, which used to release the lane and re-send
    // the item it still holds.
    second.openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
    second.runtime.start();
    await settle(120);
    expect(second.runtime.buildSnapshot().active[0]?.needsReview).toBe(true);
    expect(second.runtime.buildSnapshot().queued).toHaveLength(1);
    expect(promptCalls(second.openCode)).toHaveLength(0);
    second.runtime.stop();
    await second.runtime.flush();
  });

  it('does not dispatch a reserved force when its project lane frees', async () => {
    const { runtime, openCode, emit } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    runtime.start();
    try {
      // SESSION holds the project lane; SECOND's build waits behind it.
      await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
      const waiting = await runtime.enqueue(SECOND, DIRECTORY, item({ content: 'second', text: 'second', buildQueue: true }));
      await settle(60);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);

      // Forcing SECOND fails after the prompt may have been accepted.
      openCode.state.failNext = /\/prompt$/;
      const result = await runtime.forceDispatch(DIRECTORY, SECOND, waiting.itemId);
      expect(result.warning).toContain('not confirmed');

      // The lane frees: the queue must not send the reserved item again.
      openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
      delete openCode.state.active[SESSION];
      emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
      await settle(120);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['first']);
      expect(runtime.buildSnapshot().forced.some(entry => entry.itemId === waiting.itemId && entry.needsReview)).toBe(true);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('does not dispatch a reserved force after a restart', async () => {
    const first = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    first.runtime.start();
    await first.runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
    const waiting = await first.runtime.enqueue(SECOND, DIRECTORY, item({ content: 'second', text: 'second', buildQueue: true }));
    await settle(60);
    first.openCode.state.failNext = /\/prompt$/;
    await first.runtime.forceDispatch(DIRECTORY, SECOND, waiting.itemId);
    first.runtime.stop();
    await first.runtime.flush();

    const second = createRuntime({ dataDir: first.dataDir, checkBuildGit: async () => null, buildMonitorDelayMs: 20, buildRecheckMs: 10 });
    second.openCode.state.tail = [{ type: 'assistant', time: { completed: Date.now() } }];
    second.runtime.start();
    await settle(120);
    expect(promptCalls(second.openCode)).toHaveLength(0);
    expect(second.runtime.buildSnapshot().forced.some(entry => entry.itemId === waiting.itemId && entry.needsReview)).toBe(true);
    second.runtime.stop();
    await second.runtime.flush();
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
    expect(openCode.state.sent.find(call => call.path.endsWith('/synthetic'))?.body.text).toContain('Build starts from commit');
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

  it('holds new admissions and merged prompts during queue pause without losing their order or payloads', async () => {
    const { runtime, openCode, broadcasts } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 200 });
    try {
      await runtime.setQueuePaused(DIRECTORY + '/', true);
      await runtime.admitSubmission({ sessionId: SESSION, directory: DIRECTORY, item: item({ messageId: 'msg_paused_1', content: 'First prompt', text: 'First prompt' }) });
      const firstId = runtime.buildSnapshot().queued[0].id;
      await runtime.admitSubmission({ sessionId: SECOND, directory: DIRECTORY, item: item({ messageId: 'msg_paused_2', content: 'Second prompt', text: 'Second prompt' }) });
      await runtime.admitSubmission({ sessionId: SESSION, directory: DIRECTORY, item: item({ messageId: 'msg_paused_3', content: 'More context', text: 'More context' }) });
      await runtime.setBuildPaused(SESSION, firstId, true);
      await runtime.setBuildPaused(SESSION, firstId, false);
      await settle(60);
      expect(promptCalls(openCode)).toEqual([]);
      expect(runtime.buildSnapshot().queued.map(entry => [entry.sessionId, entry.content])).toEqual([
        [SESSION, 'First prompt\n\nMore context'], [SECOND, 'Second prompt'],
      ]);
      expect(runtime.buildSnapshot().queued[0].id).toBe(firstId);
      expect(runtime.buildSnapshot().pausedDirectories).toEqual([DIRECTORY]);
      expect(broadcasts.some(event => event.type === 'openchamber:build-queue.updated' && event.properties.directory === DIRECTORY)).toBe(true);
      await runtime.setQueuePaused(DIRECTORY + '/', false);
      await settle(60);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['First prompt\n\nMore context']);
      expect(runtime.buildSnapshot().queued.map(entry => entry.sessionId)).toEqual([SECOND]);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('persists an empty queue pause across restart and preserves individual pauses on queue resume', async () => {
    const first = createRuntime({ checkBuildGit: async () => null });
    await first.runtime.setQueuePaused(DIRECTORY, true);
    first.runtime.stop();
    await first.runtime.flush();
    const { runtime, openCode } = createRuntime({ dataDir: first.dataDir, checkBuildGit: async () => null, buildMonitorDelayMs: 200 });
    try {
      await runtime.load();
      expect(runtime.buildSnapshot().pausedDirectories).toEqual([DIRECTORY]);
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true, text: 'Stay paused' }));
      const firstId = runtime.buildSnapshot().queued[0].id;
      await runtime.setBuildPaused(SESSION, firstId, true);
      await runtime.enqueue(SECOND, DIRECTORY, item({ buildQueue: true, text: 'Run after resume' }));
      await settle(40);
      expect(promptCalls(openCode)).toEqual([]);
      await runtime.setQueuePaused(DIRECTORY, false);
      await settle(60);
      expect(promptCalls(openCode).map(call => call.body.text)).toEqual(['Run after resume']);
      expect(runtime.buildSnapshot().queued).toMatchObject([{ id: firstId, paused: true }]);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('keeps queue pause separate from individual pauses and from other directories and ordinary messages', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null });
    try {
      openCode.state.active[SESSION] = { type: 'running' };
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
      await runtime.setBuildPaused(SESSION, runtime.buildSnapshot().queued[0].id, true);
      expect(runtime.buildSnapshot().pausedDirectories).toEqual([]);
      await runtime.setQueuePaused(DIRECTORY, true);
      await runtime.enqueue(SECOND, '/other', item({ buildQueue: true, text: 'Other directory' }));
      await runtime.enqueue('ses_ordinary', DIRECTORY, item({ text: 'Ordinary message' }));
      await settle(60);
      expect(promptCalls(openCode).map(call => call.body.text).sort()).toEqual(['Ordinary message', 'Other directory']);
      expect(runtime.buildSnapshot().queued.map(entry => entry.sessionId)).toEqual([SESSION]);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('stops dispatch when the queue is paused during Git checks', async () => {
    let finishCheck;
    const checking = new Promise(resolve => { finishCheck = resolve; });
    let started;
    const startedCheck = new Promise(resolve => { started = resolve; });
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => { started(); await checking; return null; } });
    try {
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
      await startedCheck;
      await runtime.setQueuePaused(DIRECTORY, true);
      finishCheck();
      await settle(40);
      expect(promptCalls(openCode)).toEqual([]);
      expect(runtime.buildSnapshot().active).toEqual([]);
      expect(runtime.buildSnapshot().queued).toHaveLength(1);
      await runtime.setQueuePaused(DIRECTORY, false);
      await settle(60);
      expect(promptCalls(openCode)).toHaveLength(1);
    } finally { finishCheck(); runtime.stop(); await runtime.flush(); }
  });

  it('releases an unsent lease when pause arrives during the final activity check', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null });
    const fetchImpl = openCode.fetchImpl.getMockImplementation();
    let pauseTriggered = false;
    openCode.fetchImpl.mockImplementation(async (url, init) => {
      if (!pauseTriggered && new URL(url).pathname === '/api/session/active'
        && runtime.buildSnapshot().active.some(lease => lease.phase === 'dispatching')) {
        pauseTriggered = true;
        await runtime.setQueuePaused(DIRECTORY, true);
      }
      return fetchImpl(url, init);
    });
    try {
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
      await settle(60);
      expect(pauseTriggered).toBe(true);
      expect(promptCalls(openCode)).toEqual([]);
      expect(openCode.state.switched).toEqual([]);
      expect(runtime.buildSnapshot().active).toEqual([]);
      expect(runtime.buildSnapshot().queued).toHaveLength(1);
      await runtime.setQueuePaused(DIRECTORY, false);
      await settle(60);
      expect(promptCalls(openCode)).toHaveLength(1);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('cancels commit preparation on pause without requiring a retry on resume', async () => {
    const settingsFilePath = path.join(makeDataDir(), 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueGitPolicy: 'commit' }));
    let finishPreparation;
    const preparing = new Promise(resolve => { finishPreparation = resolve; });
    let started;
    const startedPreparation = new Promise(resolve => { started = resolve; });
    const prepareBuildCommit = vi.fn(async (_directory, { isCurrent }) => {
      started();
      await preparing;
      if (!isCurrent()) throw new Error('Preparation cancelled');
      return null;
    });
    const { runtime, openCode } = createRuntime({ settingsFilePath, prepareBuildCommit });
    try {
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
      await startedPreparation;
      await runtime.setQueuePaused(DIRECTORY, true);
      finishPreparation();
      await settle(40);
      expect(promptCalls(openCode)).toEqual([]);
      expect(runtime.buildSnapshot().issues).toEqual([]);
      expect(runtime.buildSnapshot().preparation).toEqual([]);
      await runtime.setQueuePaused(DIRECTORY, false);
      await settle(60);
      expect(promptCalls(openCode)).toHaveLength(1);
      expect(prepareBuildCommit).toHaveBeenCalledTimes(2);
    } finally { finishPreparation(); runtime.stop(); await runtime.flush(); }
  });

  it('refuses a failed resume write and keeps dispatch paused', async () => {
    const { runtime, openCode, dataDir } = createRuntime({ checkBuildGit: async () => null });
    const rename = fs.promises.rename;
    let renameSpy;
    try {
      await runtime.setQueuePaused(DIRECTORY, true);
      await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
      await runtime.flush();
      // Make atomic replacement fail without changing the stored pause.
      const file = path.join(dataDir, 'message-queue.json');
      fs.renameSync(file, file + '.saved');
      fs.mkdirSync(file);
      renameSpy = vi.spyOn(fs.promises, 'rename').mockImplementation(async (...args) => {
        await settle(100);
        return rename(...args);
      });
      const failedResume = expect(runtime.setQueuePaused(DIRECTORY, false)).rejects.toMatchObject({ status: 503 });
      await runtime.setBuildPaused(SESSION, runtime.buildSnapshot().queued[0].id, false);
      await settle(40);
      expect(promptCalls(openCode)).toEqual([]);
      await failedResume;
      expect(runtime.buildSnapshot().pausedDirectories).toEqual([DIRECTORY]);
    } finally { renameSpy?.mockRestore(); runtime.stop(); await runtime.flush(); }
  });

  it.each([null, 'paused', ['/repo', 42]])('refuses malformed persisted queue pause state %j without overwriting it', async pausedDirectories => {
    const dataDir = makeDataDir();
    const file = path.join(dataDir, 'message-queue.json');
    const stored = JSON.stringify({ sessions: {}, pausedDirectories });
    fs.writeFileSync(file, stored);
    const { runtime } = createRuntime({ dataDir });
    try {
      await expect(runtime.load()).rejects.toThrow('Invalid persisted build queue pause state');
      await expect(runtime.setQueuePaused(DIRECTORY, false)).rejects.toThrow();
      expect(fs.readFileSync(file, 'utf8')).toBe(stored);
    } finally { runtime.stop(); await runtime.flush(); }
  });

  it('routes a queue pause and validates its body', async () => {
    const { runtime } = createRuntime();
    const app = express();
    app.use(express.json());
    registerMessageQueueRoutes(app, runtime);
    try {
      const paused = await request(app).put('/api/build-queue/pause').send({ directory: DIRECTORY, paused: true }).expect(200);
      expect(paused.body.pausedDirectories).toEqual([DIRECTORY]);
      await request(app).put('/api/build-queue/pause').send({ directory: DIRECTORY, paused: 'yes' }).expect(400);
      await request(app).put('/api/build-queue/pause').send({ paused: true }).expect(400);
      const resumed = await request(app).put('/api/build-queue/pause').send({ directory: DIRECTORY, paused: false }).expect(200);
      expect(resumed.body.pausedDirectories).toEqual([]);
    } finally { runtime.stop(); await runtime.flush(); }
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

});

describe('queue settings', () => {
  const settingsRuntime = ({ enabled = null, repository = null, policy = null } = {}) => {
    const state = { enabled, repository, policy, written: [], writtenPolicy: [] };
    return {
      state,
      readBuildQueueEnabled: async () => state.enabled,
      setBuildQueueEnabled: async (_projectId, value) => { state.written.push(value); state.enabled = value; return state.enabled; },
      readBuildQueueRepository: async () => state.repository,
      setBuildQueueRepository: async (_projectId, value) => { state.repository = value; return value; },
      readBuildQueueGitPolicy: async () => state.policy,
      setBuildQueueGitPolicy: async (_projectId, value) => { state.writtenPolicy.push(value); state.policy = value; return value; },
      readProjectSetup: async () => ({}),
      updateProjectSetup: async () => ({}),
      resolveProjectConfigPath: () => '/tmp/none.json',
    };
  };
  const identityOf = (input) => ({ directory: input.directory, projectId: input.directory ? 'project-1' : null });
  const registeredOnly = (input) => (String(input.directory).startsWith('/repo')
    ? { directory: input.directory, projectId: 'project-1' }
    : { directory: null, projectId: null });
  const SECOND = 'ses_queue_settings_2';

  it('answers enabled by default, and off only after an explicit off', async () => {
    const projectConfigRuntime = settingsRuntime();
    const { runtime } = createRuntime({ projectConfigRuntime, resolveProjectIdentity: identityOf });
    expect(await runtime.readQueueSettings({ directory: DIRECTORY })).toEqual({ enabled: true, override: null, policy: 'pause', policyOverride: null, repository: null, effectiveRepository: null });
    await runtime.writeQueueSettings({ directory: DIRECTORY }, false);
    expect(await runtime.readQueueSettings({ directory: DIRECTORY })).toEqual({ enabled: false, override: false, policy: 'pause', policyOverride: null, repository: null, effectiveRepository: null });
    await runtime.writeQueueSettings({ directory: DIRECTORY }, true);
    expect(await runtime.readQueueSettings({ directory: DIRECTORY })).toEqual({ enabled: true, override: true, policy: 'pause', policyOverride: null, repository: null, effectiveRepository: null });
    // Null clears the project's choice; it follows the instance default again.
    await runtime.writeQueueSettings({ directory: DIRECTORY }, null);
    expect(await runtime.readQueueSettings({ directory: DIRECTORY })).toEqual({ enabled: true, override: null, policy: 'pause', policyOverride: null, repository: null, effectiveRepository: null });
    expect(projectConfigRuntime.state.written).toEqual([false, true, null]);
    runtime.stop();
    await runtime.flush();
  });

  it('reports a directory it cannot place in a project as a client error', async () => {
    const { runtime } = createRuntime({ projectConfigRuntime: settingsRuntime(), resolveProjectIdentity: registeredOnly });
    await expect(runtime.readQueueSettings({ directory: '/nowhere' })).rejects.toMatchObject({ status: 400 });
    runtime.stop();
    await runtime.flush();
  });

  it('rejects a non-boolean enabled value', async () => {
    const { runtime } = createRuntime({ projectConfigRuntime: settingsRuntime(), resolveProjectIdentity: identityOf });
    await expect(runtime.writeQueueSettings({ directory: DIRECTORY }, 'yes')).rejects.toThrow(TypeError);
    runtime.stop();
    await runtime.flush();
  });

  it('answers enabled when the setting cannot be stored at all', async () => {
    const { runtime } = createRuntime({ resolveProjectIdentity: identityOf });
    expect(await runtime.readQueueSettings({ directory: DIRECTORY })).toEqual({ enabled: true, override: null, policy: 'pause', policyOverride: null, repository: null, effectiveRepository: null });
    runtime.stop();
    await runtime.flush();
  });

  it('a project that never chose follows the instance default', async () => {
    const settingsFilePath = path.join(makeDataDir(), 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueDefaultEnabled: false }));
    const { runtime } = createRuntime({ settingsFilePath, projectConfigRuntime: settingsRuntime(), resolveProjectIdentity: identityOf });
    // No stored choice, so the project reads the default, which is off here.
    expect(await runtime.readQueueSettings({ directory: DIRECTORY })).toEqual({ enabled: false, override: null, policy: 'pause', policyOverride: null, repository: null, effectiveRepository: null });
    // An explicit on beats the default and is kept as the project's own choice.
    await runtime.writeQueueSettings({ directory: DIRECTORY }, true);
    expect(await runtime.readQueueSettings({ directory: DIRECTORY })).toEqual({ enabled: true, override: true, policy: 'pause', policyOverride: null, repository: null, effectiveRepository: null });
    runtime.stop();
    await runtime.flush();
  });

  it('lets a project override the instance policy and clear it', async () => {
    const settingsFilePath = path.join(makeDataDir(), 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueGitPolicy: 'continue' }));
    const projectConfigRuntime = settingsRuntime();
    const { runtime } = createRuntime({ settingsFilePath, projectConfigRuntime, resolveProjectIdentity: identityOf });
    // No project choice: the instance policy stands.
    expect(await runtime.readQueueSettings({ directory: DIRECTORY }))
      .toEqual({ enabled: true, override: null, policy: 'continue', policyOverride: null, repository: null, effectiveRepository: null });
    await expect(runtime.writeQueuePolicy({ directory: DIRECTORY }, 'pause'))
      .resolves.toEqual({ policy: 'pause', policyOverride: 'pause' });
    expect(await runtime.readQueueSettings({ directory: DIRECTORY }))
      .toEqual({ enabled: true, override: null, policy: 'pause', policyOverride: 'pause', repository: null, effectiveRepository: null });
    // Null clears the project's choice back to the instance policy.
    await expect(runtime.writeQueuePolicy({ directory: DIRECTORY }, null))
      .resolves.toEqual({ policy: 'continue', policyOverride: null });
    expect(projectConfigRuntime.state.writtenPolicy).toEqual(['pause', null]);
    runtime.stop();
    await runtime.flush();
  });

  it('rejects a policy that is not one of the three', async () => {
    const { runtime } = createRuntime({ projectConfigRuntime: settingsRuntime(), resolveProjectIdentity: identityOf });
    await expect(runtime.writeQueuePolicy({ directory: DIRECTORY }, 'automatic')).rejects.toThrow(TypeError);
    runtime.stop();
    await runtime.flush();
  });

  it('dispatches with the project policy even when the instance policy differs', async () => {
    const settingsFilePath = path.join(makeDataDir(), 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueGitPolicy: 'continue' }));
    const checkBuildGit = vi.fn(async () => 'Dirty');
    // The project chose Pause, which runs the Git check the instance policy skips.
    const { runtime } = createRuntime({
      settingsFilePath,
      projectConfigRuntime: settingsRuntime({ policy: 'pause' }),
      resolveProjectIdentity: identityOf,
      checkBuildGit,
    });
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await settle(80);
    expect(checkBuildGit).toHaveBeenCalled();
    runtime.stop();
    await runtime.flush();
  });

  it('refuses to turn the queue off while a build is running or waiting', async () => {
    const { runtime, openCode } = createRuntime({
      projectConfigRuntime: settingsRuntime(),
      resolveProjectIdentity: identityOf,
      checkBuildGit: async () => null,
      buildMonitorDelayMs: 60,
    });
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await settle(80);
    expect(runtime.buildSnapshot().active).toHaveLength(1);
    await expect(runtime.writeQueueSettings({ directory: DIRECTORY }, false)).rejects.toMatchObject({ status: 409 });

    const waiting = await runtime.enqueue(SECOND, DIRECTORY, item({ buildQueue: true }));
    await expect(runtime.writeQueueSettings({ directory: DIRECTORY }, false)).rejects.toMatchObject({ status: 409 });
    expect(waiting.itemId).toBeTruthy();
    expect(runtime.buildSnapshot().queued).toHaveLength(1);
    runtime.stop();
    await runtime.flush();
  });
});

describe('queue repository choice', () => {
  const makeProject = () => {
    const root = fs.realpathSync(makeDataDir());
    const nested = path.join(root, 'packages', 'app');
    fs.mkdirSync(path.join(nested, '.git'), { recursive: true });
    return { root, nested };
  };
  const projectConfigRuntime = (repository = null) => {
    const state = { repository };
    return {
      state,
      readBuildQueueEnabled: async () => null,
      setBuildQueueEnabled: async () => null,
      readBuildQueueRepository: async () => state.repository,
      setBuildQueueRepository: async (_projectId, value) => { state.repository = value; return value; },
      readBuildQueueGitPolicy: async () => null,
      setBuildQueueGitPolicy: async () => null,
      readProjectSetup: async () => ({}),
      updateProjectSetup: async () => ({}),
      resolveProjectConfigPath: () => '/tmp/none.json',
    };
  };

  it('stores the canonical path of a repository inside the project, and clears it', async () => {
    const { root, nested } = makeProject();
    const settings = projectConfigRuntime();
    const { runtime } = createRuntime({
      projectConfigRuntime: settings,
      resolveProjectIdentity: () => ({ directory: root, projectId: createProjectIdFromPath(root) }),
    });
    // A path with a redundant segment canonicalises to the repository itself.
    await expect(runtime.writeQueueRepository({ directory: root }, path.join(root, '.', 'packages', 'app')))
      .resolves.toEqual({ repository: nested });
    expect(await runtime.readQueueSettings({ directory: root })).toMatchObject({ repository: nested });
    await expect(runtime.writeQueueRepository({ directory: root }, null)).resolves.toEqual({ repository: null });
    expect(await runtime.readQueueSettings({ directory: root })).toMatchObject({ repository: null });
    runtime.stop();
    await runtime.flush();
  });

  it('shows and uses the resolved checkout when a workspace contains a nested repository', async () => {
    const { root, nested } = makeProject();
    const { runtime } = createRuntime({
      projectConfigRuntime: projectConfigRuntime(),
      resolveProjectIdentity: () => ({ directory: root, projectId: createProjectIdFromPath(root) }),
      resolveRepositoryRoot: async directory => directory === root ? nested : null,
    });
    await expect(runtime.queueRepositoryFor(root)).resolves.toBe(nested);
    await expect(runtime.readQueueSettings({ directory: root })).resolves.toMatchObject({
      repository: null,
      effectiveRepository: nested,
    });
    runtime.stop();
    await runtime.flush();
  });

  it('refuses a repository outside the project and a folder that is not a checkout', async () => {
    const { root } = makeProject();
    const other = fs.realpathSync(makeDataDir());
    fs.mkdirSync(path.join(other, '.git'), { recursive: true });
    const plain = path.join(root, 'docs');
    fs.mkdirSync(plain, { recursive: true });
    const settings = projectConfigRuntime();
    const { runtime } = createRuntime({
      projectConfigRuntime: settings,
      resolveProjectIdentity: () => ({ directory: root, projectId: createProjectIdFromPath(root) }),
    });
    await expect(runtime.writeQueueRepository({ directory: root }, other)).rejects.toMatchObject({ status: 400 });
    await expect(runtime.writeQueueRepository({ directory: root }, plain)).rejects.toMatchObject({ status: 400 });
    // Nothing was stored by a refused write.
    expect(settings.state.repository).toBeNull();
    runtime.stop();
    await runtime.flush();
  });

  it('checks the chosen repository instead of the dispatching directory', async () => {
    const { root, nested } = makeProject();
    const checked = [];
    const { runtime } = createRuntime({
      projectConfigRuntime: projectConfigRuntime(nested),
      resolveProjectIdentity: () => ({ directory: root, projectId: createProjectIdFromPath(root) }),
      checkBuildGit: async (directory) => { checked.push(directory); return null; },
    });
    await runtime.enqueue(SESSION, root, item({ buildQueue: true }));
    await settle(80);
    expect(checked).toContain(nested);
    expect(checked).not.toContain(root);
    runtime.stop();
    await runtime.flush();
  });

  it('prepares the automatic commit in the chosen repository', async () => {
    const { root, nested } = makeProject();
    const settingsFilePath = path.join(makeDataDir(), 'settings.json');
    fs.writeFileSync(settingsFilePath, JSON.stringify({ buildQueueGitPolicy: 'commit' }));
    const prepareBuildCommit = vi.fn(async () => null);
    const { runtime } = createRuntime({
      settingsFilePath,
      projectConfigRuntime: projectConfigRuntime(nested),
      resolveProjectIdentity: () => ({ directory: root, projectId: createProjectIdFromPath(root) }),
      prepareBuildCommit,
    });
    await runtime.enqueue(SESSION, root, item({ buildQueue: true }));
    await settle(80);
    expect(prepareBuildCommit).toHaveBeenCalledWith(root, expect.objectContaining({ repository: nested }));
    runtime.stop();
    await runtime.flush();
  });

  it('keeps a worktree on its own repository', async () => {
    const { root, nested } = makeProject();
    const worktree = fs.realpathSync(makeDataDir());
    const checked = [];
    const { runtime } = createRuntime({
      projectConfigRuntime: projectConfigRuntime(nested),
      // A worktree shares its project's id while sitting outside its folder.
      resolveProjectIdentity: ({ directory }) => ({ directory, projectId: createProjectIdFromPath(root) }),
      checkBuildGit: async (directory) => { checked.push(directory); return null; },
    });
    await runtime.enqueue(SESSION, worktree, item({ buildQueue: true }));
    await settle(80);
    expect(checked).toContain(worktree);
    expect(checked).not.toContain(nested);
    runtime.stop();
    await runtime.flush();
  });
});

describe('prompt admission', () => {
  const admitWire = (runtime, openCode, body, kind = 'prompt') => admitPrompt({
    req: { get: () => 'admit' }, body, kind, sessionId: SESSION, directory: DIRECTORY,
    facts: createAdmissionFacts({
      buildOpenCodeUrl: route => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}), fetchImpl: openCode.fetchImpl,
    }),
    readEnabled: runtime.queueEnabledStateFor,
    resolveIdentity: runtime.resolveProjectIdentity,
    enqueue: (sessionId, directory, item) => runtime.admitSubmission({ sessionId, directory, item }),
  });

  it.each([
    { kind: 'command', text: '', args: '' },
    { kind: 'command', text: 'src now', args: 'src now' },
    { kind: 'prompt', text: '/ship src now', args: 'src now' },
  ])('admits and dispatches $kind with text $text through the command route', async ({ kind, text, args }) => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null });
    openCode.state.commands = [{ name: 'ship', agent: 'build' }];
    const body = kind === 'command' ? { name: 'ship', text } : { id: 'msg_command', text };
    const result = await admitWire(runtime, openCode, body, kind);
    expect(result.action).toBe('queued');
    await settle(100);
    expect(openCode.state.sent.filter(entry => entry.path.endsWith('/command')).map(entry => entry.body))
      .toEqual([{ name: 'ship', text: args }]);
    expect(openCode.state.sent.filter(entry => entry.path.endsWith('/prompt'))).toEqual([]);
    runtime.stop();
    await runtime.flush();
  });

  it('restores the admitted model, variant and agent after the session selection changes', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null });
    openCode.state.active[SESSION] = { type: 'running' };
    openCode.state.selection.model.variant = 'high';
    await admitWire(runtime, openCode, { id: 'msg_selection', text: 'build it' });
    openCode.state.selection = { agent: 'plan', model: { providerID: 'different', id: 'other' } };
    delete openCode.state.active[SESSION];
    await runtime.setHold(SESSION, true);
    await runtime.setHold(SESSION, false);
    await settle(100);
    expect(openCode.state.selection).toEqual({ agent: 'build', model: { providerID: 'anthropic', id: 'claude', variant: 'high' } });
    expect(openCode.state.sent.some(entry => entry.body.id === 'msg_selection')).toBe(true);
    runtime.stop();
    await runtime.flush();
  });

  it('keeps each merged prompt\'s own files, including an attachment-free prompt, across restart', async () => {
    const first = createRuntime();
    first.openCode.state.active[SESSION] = { type: 'running' };
    const files = [{ uri: 'file:///a.png', name: 'a.png' }, { uri: 'file:///b.png', name: 'b.png' }];
    for (const [index, file] of [...files, null].entries()) {
      await admitWire(first.runtime, first.openCode, { id: `msg_file_${index}`, text: `prompt ${index}`, ...(file ? { files: [file] } : {}) });
    }
    first.runtime.stop();
    await first.runtime.flush();
    const second = createRuntime({ dataDir: first.dataDir, checkBuildGit: async () => null });
    second.runtime.start();
    await settle(120);
    const prompts = second.openCode.state.sent.filter(entry => entry.path.endsWith('/prompt'));
    expect(prompts.map(entry => entry.body.files ?? [])).toEqual([[files[0]], [files[1]], []]);
    expect(prompts.map(entry => entry.body.id)).toEqual(['msg_file_0', 'msg_file_1', 'msg_file_2']);
    second.runtime.stop();
    await second.runtime.flush();
  });

  // A prompt as the admission module builds it: the accepted entry carries the
  // text that arrived with that prompt, so a merged slot dispatches each one
  // with its own words.
  const admittedItem = (messageId, overrides = {}) => {
    const text = overrides.text ?? 'ship it';
    const admission = {
      sessionId: SESSION, directory: DIRECTORY, kind: 'prompt', text,
      agents: [{ name: 'build' }], skills: [], leading: [],
    };
    return {
      ...overrides,
      content: text,
      text,
      attachments: overrides.attachments ?? [],
      context: overrides.context ?? [],
      sendConfig: overrides.sendConfig ?? {},
      buildQueue: true,
      messageId,
      admission,
      acceptedPrompts: [{ messageId, admission }],
    };
  };

  it('exposes the wire id on the public item and merges several into one lane slot', async () => {
    const { runtime, openCode } = createRuntime();
    openCode.state.active[SESSION] = { type: 'running' };
    await runtime.enqueue(SESSION, DIRECTORY, admittedItem('msg_a'));
    const merged = await runtime.enqueue(SESSION, DIRECTORY, admittedItem('msg_b', { content: 'and this', text: 'and this' }));

    // One lane slot, one row, but both wire ids acknowledged.
    expect(runtime.buildSnapshot().queued).toHaveLength(1);
    const publicItem = runtime.sessionSnapshot(SESSION).items[0];
    expect(publicItem.messageId).toBe('msg_a');
    expect(publicItem.messageIds).toEqual(['msg_a', 'msg_b']);
    expect(merged.itemId).toBe(publicItem.id);
    runtime.stop();
    await runtime.flush();
  });

  it('dispatches every accepted prompt in one lane slot with its own id', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 40 });
    openCode.state.active[SESSION] = { type: 'running' };
    await runtime.enqueue(SESSION, DIRECTORY, admittedItem('msg_a'));
    await runtime.enqueue(SESSION, DIRECTORY, admittedItem('msg_b', { content: 'second', text: 'second' }));
    delete openCode.state.active[SESSION];
    // Arm dispatch explicitly: nothing else signals idleness here.
    openCode.state.tail = [];
    await runtime.setHold(SESSION, true);
    await runtime.setHold(SESSION, false);
    await settle(120);

    const prompts = openCode.state.sent.filter((entry) => entry.path.endsWith('/prompt'));
    expect(prompts.map((entry) => entry.body.id)).toEqual(['msg_a', 'msg_b']);
    expect(prompts.map((entry) => entry.body.text)).toEqual(['ship it', 'second']);
    // Each accepted prompt keeps its own agents payload.
    expect(prompts[0].body.agents).toEqual([{ name: 'build' }]);
    runtime.stop();
    await runtime.flush();
  });

  it('does not admit the same prompt id twice', async () => {
    const { runtime, openCode } = createRuntime();
    openCode.state.active[SESSION] = { type: 'running' };
    const first = await runtime.admitBuildPrompt({ sessionId: SESSION, directory: DIRECTORY, item: admittedItem('msg_a') });
    expect(first).toMatchObject({ admitted: true, settled: false });
    const again = await runtime.admitBuildPrompt({ sessionId: SESSION, directory: DIRECTORY, item: admittedItem('msg_a') });
    expect(again).toMatchObject({ admitted: false, settled: false, itemId: first.itemId });
    // The repeat appended nothing: still one row and one text.
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    expect(runtime.sessionSnapshot(SESSION).items[0].text).toBe('ship it');
    runtime.stop();
    await runtime.flush();
  });

  it('refuses a replay of a prompt that was already dispatched', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 30 });
    const admitted = await runtime.admitBuildPrompt({ sessionId: SESSION, directory: DIRECTORY, item: admittedItem('msg_a') });
    expect(admitted.admitted).toBe(true);
    await settle(80);
    // It went out and left the queue.
    expect(openCode.state.sent.some((entry) => entry.path.endsWith('/prompt'))).toBe(true);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(0);

    const replay = await runtime.admitBuildPrompt({ sessionId: SESSION, directory: DIRECTORY, item: admittedItem('msg_a') });
    expect(replay).toMatchObject({ admitted: false, settled: true });
    runtime.stop();
    await runtime.flush();
  });

  it('keeps an admitted prompt and its wire identity across a restart', async () => {
    const first = createRuntime();
    first.openCode.state.active[SESSION] = { type: 'running' };
    await first.runtime.admitBuildPrompt({ sessionId: SESSION, directory: DIRECTORY, item: admittedItem('msg_a') });
    await first.runtime.enqueue(SESSION, DIRECTORY, admittedItem('msg_b', { content: 'more', text: 'more' }));
    first.runtime.stop();
    await first.runtime.flush();

    const second = createRuntime({ dataDir: first.dataDir });
    await second.runtime.load();
    const publicItem = second.runtime.sessionSnapshot(SESSION).items[0];
    expect(publicItem.messageIds).toEqual(['msg_a', 'msg_b']);
    // The reloaded slot is still recognized as project build work.
    expect(second.runtime.buildSnapshot().queued).toHaveLength(1);
    second.runtime.stop();
    await second.runtime.flush();
  });

  it('rejects an admitted prompt with no messageId', async () => {
    const { runtime } = createRuntime();
    await expect(runtime.admitBuildPrompt({ sessionId: SESSION, directory: DIRECTORY, item: admittedItem(undefined) }))
      .rejects.toThrow(TypeError);
    runtime.stop();
    await runtime.flush();
  });

  it('stages the synthetics the prompt arrived behind, before it', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 30 });
    const withLeading = admittedItem('msg_a');
    withLeading.admission.leading = [{ text: 'standing context' }];
    withLeading.acceptedPrompts[0].admission.leading = [{ text: 'standing context' }];
    await runtime.admitBuildPrompt({ sessionId: SESSION, directory: DIRECTORY, item: withLeading });
    await settle(80);

    const synthetics = openCode.state.sent.filter((entry) => entry.path.endsWith('/synthetic'));
    expect(synthetics.map((entry) => entry.body.text)).toContain('standing context');
    const promptIndex = openCode.state.sent.findIndex((entry) => entry.path.endsWith('/prompt'));
    const leadingIndex = openCode.state.sent.findIndex((entry) => entry.body.text === 'standing context');
    expect(leadingIndex).toBeLessThan(promptIndex);
    runtime.stop();
    await runtime.flush();
  });

  it('ignores a client-supplied agent claim and keeps the build instruction', async () => {
    // The classification already ran server-side; a body claiming an agent
    // cannot drop the serialized-build instruction the lane adds.
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 30 });
    const spoofed = admittedItem('msg_a', { sendConfig: { agent: 'plan' } });
    spoofed.sendConfig = { agent: 'plan' };
    await runtime.admitBuildPrompt({ sessionId: SESSION, directory: DIRECTORY, item: spoofed });
    await settle(80);
    const synthetics = openCode.state.sent.filter((entry) => entry.path.endsWith('/synthetic'));
    expect(synthetics.some((entry) => entry.body.text.includes('Build starts from commit'))).toBe(true);
    runtime.stop();
    await runtime.flush();
  });
});

describe('per-session clear with project build work', () => {
  it('keeps a waiting Build item and drops the ordinary messages around it', async () => {
    // The chat's Clear all clears the conversation's own queue. A project build
    // belongs to the board, so the chat cannot cancel it by accident.
    const { runtime, openCode } = createRuntime();
    openCode.state.active[SESSION] = { type: 'running' };
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'build', text: 'build', buildQueue: true }));
    const plain = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));
    const result = await runtime.clear(SESSION);
    expect(result.session.items.map((entry) => entry.text)).toEqual(['build']);
    expect(runtime.buildSnapshot().queued.map((entry) => entry.id)).toHaveLength(1);
    expect(plain.itemId).not.toBe(runtime.buildSnapshot().queued[0].id);
    runtime.stop();
    await runtime.flush();
  });

  it('keeps an in-flight item as before, alongside the Build item', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const openCode = createOpenCode();
    const baseFetch = openCode.fetchImpl;
    openCode.fetchImpl = vi.fn(async (url, init = {}) => {
      if (init.method === 'POST' && new URL(url).pathname.endsWith('/prompt')) {
        await gate;
      }
      return baseFetch(url, init);
    });
    const { runtime } = createRuntime({ openCode });
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'build', text: 'build', buildQueue: true }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));
    await settle(40);
    // The plain message is the head and is mid-send when the chat clears.
    await runtime.clear(SESSION);
    release();
    await settle(40);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.text)).toEqual(['build']);
    runtime.stop();
    await runtime.flush();
  });

  it('keeps an admitted build prompt and its wire id, so the queue can still dispatch it', async () => {
    const { runtime, openCode } = createRuntime();
    openCode.state.active[SESSION] = { type: 'running' };
    const admitted = {
      content: 'ship it', text: 'ship it', attachments: [], context: [], sendConfig: {}, buildQueue: true,
      messageId: 'msg_a',
      admission: { sessionId: SESSION, directory: DIRECTORY, kind: 'prompt', text: 'ship it', agents: [], skills: [], leading: [] },
      acceptedPrompts: [{ messageId: 'msg_a', admission: { sessionId: SESSION, directory: DIRECTORY, kind: 'prompt', text: 'ship it', agents: [], skills: [], leading: [] } }],
    };
    await runtime.admitBuildPrompt({ sessionId: SESSION, directory: DIRECTORY, item: admitted });
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));
    await runtime.clear(SESSION);

    const remaining = runtime.sessionSnapshot(SESSION).items;
    expect(remaining).toHaveLength(1);
    expect(remaining[0].messageIds).toEqual(['msg_a']);
    expect(runtime.buildSnapshot().queued).toHaveLength(1);
    runtime.stop();
    await runtime.flush();
  });

  it('still removes a scheduled item from the chat clear, as before', async () => {
    const results = [];
    const { runtime, openCode } = createRuntime({ onScheduledTaskResult: (_task, status) => results.push(status) });
    openCode.state.active[SESSION] = { type: 'running' };
    await runtime.enqueue(SESSION, DIRECTORY, item({
      scheduledTask: { projectId: 'project-1', taskId: 'task-1' }, sendConfig: {},
    }));
    await runtime.clear(SESSION);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(0);
    expect(results).toEqual(['cancelled']);
    runtime.stop();
    await runtime.flush();
  });
});

describe('managed dispatch delivery', () => {
  it('sends a managed build prompt as the turn initiator, with no queue delivery', async () => {
    // Stating `queue` parked the prompt in the session inbox, so the turn ran
    // on the synthetic preamble alone and the user's request was left pending.
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 30 });
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first', buildQueue: true }));
    await settle(80);
    const prompts = openCode.state.sent.filter((entry) => entry.path.endsWith('/prompt'));
    expect(prompts).toHaveLength(1);
    expect(prompts[0].body.delivery).toBeUndefined();
    runtime.stop();
    await runtime.flush();
  });

  it('sends an admitted build prompt as the turn initiator and keeps its original id', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 30 });
    const admitted = {
      content: 'ship it', text: 'ship it', attachments: [], context: [], sendConfig: {}, buildQueue: true,
      messageId: 'msg_keep',
      admission: { sessionId: SESSION, directory: DIRECTORY, kind: 'prompt', text: 'ship it', agents: [], skills: [], leading: [] },
      acceptedPrompts: [{ messageId: 'msg_keep', admission: { sessionId: SESSION, directory: DIRECTORY, kind: 'prompt', text: 'ship it', agents: [], skills: [], leading: [] } }],
    };
    await runtime.admitBuildPrompt({ sessionId: SESSION, directory: DIRECTORY, item: admitted });
    await settle(80);
    const prompts = openCode.state.sent.filter((entry) => entry.path.endsWith('/prompt'));
    expect(prompts[0].body.id).toBe('msg_keep');
    expect(prompts[0].body.delivery).toBeUndefined();
    runtime.stop();
    await runtime.flush();
  });

  it('leaves the preamble context-only, so it never starts a turn of its own', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null, buildMonitorDelayMs: 30 });
    await runtime.enqueue(SESSION, DIRECTORY, item({ buildQueue: true }));
    await settle(80);
    const synthetics = openCode.state.sent.filter((entry) => entry.path.endsWith('/synthetic'));
    expect(synthetics.length).toBeGreaterThan(0);
    expect(synthetics.every((entry) => entry.body.resume === false)).toBe(true);
    runtime.stop();
    await runtime.flush();
  });

  it('does not add delivery to an ordinary queued message', async () => {
    const { runtime, openCode } = createRuntime({ checkBuildGit: async () => null });
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'hello', text: 'hello' }));
    await settle(80);
    const prompts = openCode.state.sent.filter((entry) => entry.path.endsWith('/prompt'));
    expect(prompts[0].body.delivery).toBeUndefined();
    runtime.stop();
    await runtime.flush();
  });
});
