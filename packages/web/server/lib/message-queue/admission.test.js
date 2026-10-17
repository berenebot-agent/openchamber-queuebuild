import { describe, expect, it, vi } from 'vitest';
import {
  classifySubmission,
  commandAgentOf,
  isBuildAgentName,
  resolveTurnAgent,
  slashCommandNameOf,
} from './build-classification.js';
import {
  admitPrompt,
  buildQueuedItemFromPrompt,
  createAdmissionFacts,
  escapesManagedOwnership,
  guardExecutionStart,
  isAdmitRequest,
  queuedPromptResponse,
  startsExecution,
} from './admission.js';
import { ADMIT_HEADER } from './admission.js';

const SESSION = 'ses_admit_test_1';
const DIRECTORY = '/repo';

const sessionRecord = (overrides = {}) => ({
  id: SESSION,
  projectID: 'project-1',
  location: { directory: DIRECTORY },
  ...overrides,
});

const request = ({ admit = true } = {}) => ({
  get: (name) => (name === ADMIT_HEADER && admit ? 'admit' : undefined),
});

describe('build classification', () => {
  it('reads the agent the session actually runs, falling back to the default', () => {
    expect(resolveTurnAgent({ session: sessionRecord({ agent: 'build' }) })).toBe('build');
    expect(resolveTurnAgent({ session: sessionRecord(), defaultAgent: 'plan' })).toBe('plan');
    expect(resolveTurnAgent({ session: sessionRecord() })).toBeNull();
  });

  it('treats the session agent as authoritative, case-insensitively', () => {
    expect(isBuildAgentName('Build')).toBe(true);
    expect(isBuildAgentName('BUILD')).toBe(true);
    expect(isBuildAgentName('plan')).toBe(false);
    expect(classifySubmission({ session: sessionRecord({ agent: 'Build' }), text: 'ship it' }))
      .toEqual({ build: true, reason: 'agent' });
    expect(classifySubmission({ session: sessionRecord({ agent: 'plan' }), text: 'ship it' }))
      .toEqual({ build: false, reason: 'agent-not-build' });
  });

  it('resolves a session with no recorded agent to the server default', () => {
    expect(classifySubmission({ session: sessionRecord(), defaultAgent: 'build', text: 'x' }))
      .toEqual({ build: true, reason: 'agent' });
    // No default known is not a licence to queue: the prompt goes through.
    expect(classifySubmission({ session: sessionRecord(), text: 'x' }))
      .toEqual({ build: false, reason: 'unknown-agent' });
  });

  it('refuses shell, steer and child sessions', () => {
    const build = sessionRecord({ agent: 'build' });
    expect(classifySubmission({ session: build, kind: 'shell', text: 'ls' }))
      .toEqual({ build: false, reason: 'shell' });
    expect(classifySubmission({ session: build, text: 'x', delivery: 'steer' }))
      .toEqual({ build: false, reason: 'steer' });
    // An idle session's forged steer is refused the same way: the queue never
    // takes a steer, so the session's own inbox stays the only owner of one.
    expect(classifySubmission({ session: build, text: 'x', delivery: 'queue' }))
      .toEqual({ build: false, reason: 'steer' });
    expect(classifySubmission({ session: sessionRecord({ agent: 'build', parentID: 'ses_parent_1' }), text: 'x' }))
      .toEqual({ build: false, reason: 'child-session' });
  });

  it('resolves a slash command from OpenCode\'s own command list', () => {
    const build = sessionRecord({ agent: 'plan' });
    expect(slashCommandNameOf('/ship src now')).toBe('ship');
    expect(commandAgentOf([{ name: 'ship', agent: 'build' }, { name: 'ask' }], 'ship')).toBe('build');
    expect(commandAgentOf([{ name: 'ask' }], 'ask')).toBe('');
    expect(commandAgentOf([{ name: 'ask' }], 'missing')).toBeNull();

    // A command that names Build is Build work even on a Plan session.
    expect(classifySubmission({ session: build, kind: 'command', text: '/ship', commandAgent: 'build', commandResolved: true }))
      .toEqual({ build: true, reason: 'command-build' });
    expect(classifySubmission({ session: sessionRecord({ agent: 'build' }), kind: 'command', text: '/ask', commandAgent: '', commandResolved: true }))
      .toEqual({ build: false, reason: 'command-not-build' });
    // An unknown command is not build work.
    expect(classifySubmission({ session: sessionRecord({ agent: 'build' }), kind: 'command', text: '/mystery', commandResolved: false }))
      .toEqual({ build: false, reason: 'unresolved-command' });
  });

  it('refuses a submission with no session', () => {
    expect(classifySubmission({ session: null, text: 'x' })).toEqual({ build: false, reason: 'no-session' });
  });
});

describe('admission facts', () => {
  const openCodeFetch = async (fetchPath) => {
    if (fetchPath === '/api/agent') return [{ id: 'plan' }, { id: 'build', default: true }];
    if (fetchPath === '/api/command') return [{ name: 'ship', agent: 'build' }];
    if (fetchPath === `/api/session/${SESSION}`) return sessionRecord({ agent: 'build' });
    return null;
  };

  it('reads the session, default agent and command list', async () => {
    const facts = createAdmissionFacts({ openCodeFetch });
    expect(await facts.sessionSummary(SESSION, DIRECTORY)).toMatchObject({ id: SESSION });
    expect(await facts.defaultAgent(DIRECTORY)).toBe('build');
    expect(await facts.commandList(DIRECTORY)).toEqual([{ name: 'ship', agent: 'build' }]);
  });

  it('answers null rather than throwing when a read fails', async () => {
    const facts = createAdmissionFacts({ openCodeFetch: async () => { throw new Error('unreachable'); } });
    expect(await facts.sessionSummary(SESSION, DIRECTORY)).toBeNull();
    expect(await facts.defaultAgent(DIRECTORY)).toBeNull();
    expect(await facts.commandList(DIRECTORY)).toBeNull();
  });

  it('falls back to build when no agent is marked default', async () => {
    const facts = createAdmissionFacts({ openCodeFetch: async () => [{ id: 'plan' }] });
    expect(await facts.defaultAgent(DIRECTORY)).toBe('build');
  });
});

describe('admitPrompt', () => {
  const facts = createAdmissionFacts({
    openCodeFetch: async (fetchPath) => {
      if (fetchPath === '/api/agent') return [{ id: 'build', default: true }];
      if (fetchPath === '/api/command') return [{ name: 'ship', agent: 'build' }];
      if (fetchPath === `/api/session/${SESSION}`) return sessionRecord({ agent: 'build' });
      return null;
    },
  });
  const identity = async () => ({ directory: DIRECTORY, projectId: 'project-1' });
  const admit = (options = {}) => admitPrompt({
    req: request(options.admit === undefined ? {} : { admit: options.admit }),
    body: { id: 'msg_1', text: 'ship it' },
    sessionId: SESSION,
    directory: DIRECTORY,
    facts,
    readEnabled: options.readEnabled ?? (async () => true),
    resolveIdentity: options.resolveIdentity ?? identity,
    enqueue: options.enqueue ?? (async () => ({ itemId: 'queued-1' })),
  });

  it('queues a Build prompt that was explicitly marked', async () => {
    expect(await admit()).toEqual({ action: 'queued', itemId: 'queued-1' });
  });

  it('passes an unmarked prompt straight through without reading anything', async () => {
    const enqueue = vi.fn();
    // An untrusted `buildQueue` flag on the body changes nothing.
    const result = await admitPrompt({
      req: request({ admit: false }),
      body: { id: 'msg_1', text: 'ship it', buildQueue: true },
      sessionId: SESSION,
      directory: DIRECTORY,
      facts,
      readEnabled: async () => true,
      resolveIdentity: identity,
      enqueue,
    });
    expect(result).toEqual({ action: 'pass' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('passes through when the project turned its queue off', async () => {
    const enqueue = vi.fn();
    expect(await admit({ readEnabled: async () => false, enqueue })).toEqual({ action: 'pass' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('passes a non-Build prompt through even when marked', async () => {
    const enqueue = vi.fn();
    const planFacts = createAdmissionFacts({ openCodeFetch: async (fetchPath) => (
      fetchPath === '/api/agent' ? [{ id: 'plan', default: true }] : sessionRecord({ agent: 'plan' })
    ) });
    const result = await admitPrompt({
      req: request(),
      body: { id: 'msg_1', text: 'explain this' },
      sessionId: SESSION,
      directory: DIRECTORY,
      facts: planFacts,
      readEnabled: async () => true,
      resolveIdentity: identity,
      enqueue,
    });
    expect(result).toEqual({ action: 'pass', reason: 'agent-not-build' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses a marked prompt when the session cannot be read', async () => {
    const enqueue = vi.fn();
    const failing = createAdmissionFacts({ openCodeFetch: async () => { throw new Error('down'); } });
    await expect(admitPrompt({
      req: request(),
      body: { id: 'msg_1', text: 'ship it' },
      sessionId: SESSION,
      directory: DIRECTORY,
      facts: failing,
      readEnabled: async () => true,
      resolveIdentity: identity,
      enqueue,
    })).rejects.toMatchObject({ status: 409 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('refuses a marked prompt when the project setting cannot be read', async () => {
    const enqueue = vi.fn();
    await expect(admitPrompt({
      req: request(),
      body: { id: 'msg_1', text: 'ship it' },
      sessionId: SESSION,
      directory: DIRECTORY,
      facts,
      readEnabled: async () => null,
      resolveIdentity: identity,
      enqueue,
    })).rejects.toMatchObject({ status: 503 });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('passes through when the directory cannot be placed in a project', async () => {
    const enqueue = vi.fn();
    const result = await admit({ resolveIdentity: async () => ({ directory: null, projectId: null }), enqueue });
    expect(result).toEqual({ action: 'pass' });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues a marked Build command resolved from the command list', async () => {
    const result = await admitPrompt({
      req: request(),
      body: { name: 'ship', text: '' },
      sessionId: SESSION,
      directory: DIRECTORY,
      kind: 'command',
      facts,
      readEnabled: async () => true,
      resolveIdentity: identity,
      enqueue: async () => ({ itemId: 'queued-2' }),
    });
    expect(result).toEqual({ action: 'queued', itemId: 'queued-2' });
  });
});

describe('queue admission shapes', () => {
  it('recognises only the explicit admit header', () => {
    expect(isAdmitRequest({ get: () => 'admit' })).toBe(true);
    expect(isAdmitRequest({ get: () => 'Admit' })).toBe(false);
    expect(isAdmitRequest({ get: () => undefined })).toBe(false);
    expect(isAdmitRequest(undefined)).toBe(false);
  });

  it('keeps the wire identity of the admitted prompt', () => {
    const item = buildQueuedItemFromPrompt({
      body: {
        id: 'msg_7',
        text: 'ship it',
        files: [{ uri: 'file:///a.png', name: 'a.png' }],
        agents: [{ name: 'build' }],
        skills: [{ id: 'skill-1' }],
        metadata: { source: 'composer' },
        delivery: 'queue',
      },
      directory: DIRECTORY,
      sessionId: SESSION,
      kind: 'prompt',
      leading: [{ text: 'standing context' }],
    });
    expect(item.messageId).toBe('msg_7');
    expect(item.sendConfig).toEqual({});
    expect(item.admission).toMatchObject({
      kind: 'prompt',
      delivery: 'queue',
      agents: [{ name: 'build' }],
      skills: [{ id: 'skill-1' }],
      metadata: { source: 'composer' },
      leading: [{ text: 'standing context' }],
    });
    expect(item.attachments[0].dataUrl).toBe('file:///a.png');
  });

  it('answers the full inbox record the SDK decodes, plus the queued flag', () => {
    const response = queuedPromptResponse({
      body: { id: 'msg_7', text: 'ship it', delivery: 'queue', agents: [{ name: 'build' }] },
      sessionId: SESSION,
      now: 1760000000000,
    });
    expect(response).toEqual({
      data: {
        id: 'msg_7',
        sessionID: SESSION,
        time: { created: 1760000000000 },
        type: 'user',
        payload: { text: 'ship it', agents: [{ name: 'build' }] },
        delivery: 'queue',
      },
    });
  });

  it('mints an id when the client sent none', () => {
    const response = queuedPromptResponse({ body: { text: 'x' }, sessionId: SESSION, now: 5 });
    expect(response.data.id).toBe('queued-5');
    expect(response.data.delivery).toBe('queue');
  });
});

describe('execution-start guard', () => {
  const buildFacts = createAdmissionFacts({
    openCodeFetch: async (fetchPath) => {
      if (fetchPath === '/api/agent') return [{ id: 'build', default: true }];
      if (fetchPath === `/api/session/${SESSION}`) return sessionRecord({ agent: 'build' });
      return null;
    },
  });
  const planFacts = createAdmissionFacts({
    openCodeFetch: async (fetchPath) => {
      if (fetchPath === '/api/agent') return [{ id: 'plan', default: true }];
      if (fetchPath === `/api/session/${SESSION}`) return sessionRecord({ agent: 'plan' });
      return null;
    },
  });
  const identity = async () => ({ directory: DIRECTORY, projectId: 'project-1' });
  const check = (options = {}) => guardExecutionStart({
    body: options.body ?? { text: 'ship it' },
    sessionId: SESSION,
    directory: DIRECTORY,
    kind: options.kind ?? 'prompt',
    facts: options.facts ?? buildFacts,
    readEnabled: options.readEnabled ?? (async () => true),
    resolveIdentity: options.resolveIdentity ?? identity,
  });

  it('knows which admissions start execution, reading the default as starting', () => {
    expect(startsExecution({ kind: 'prompt' })).toBe(true);
    expect(startsExecution({ kind: 'command' })).toBe(true);
    expect(startsExecution({ kind: 'synthetic', body: {} })).toBe(true);
    expect(startsExecution({ kind: 'synthetic', body: { resume: true } })).toBe(true);
    // The one suppressor.
    expect(startsExecution({ kind: 'synthetic', body: { resume: false } })).toBe(false);
  });

  it('refuses an unmarked prompt on a Build session in an enabled project', async () => {
    expect(await check({ admit: false })).toEqual({ allow: false, reason: 'build-session' });
  });

  it('refuses an execution-starting synthetic that would bypass the queue', async () => {
    expect(await check({ admit: false, kind: 'synthetic', body: { text: 'go', resume: true } }))
      .toEqual({ allow: false, reason: 'build-session' });
    // resume omitted defaults to starting execution.
    expect(await check({ admit: false, kind: 'synthetic', body: { text: 'go' } }))
      .toEqual({ allow: false, reason: 'build-session' });
  });

  it('always allows a context-only synthetic', async () => {
    expect(await check({ admit: false, kind: 'synthetic', body: { text: 'context', resume: false } }))
      .toEqual({ allow: true });
  });

  it('refuses a marked prompt on a Build session like an unmarked one', async () => {
    // The marker routes through `admitPrompt`, which is where a prompt is
    // judged; reaching the guard means the route the queue cannot take, so the
    // marker must not exempt it.
    expect(await check({ admit: true })).toEqual({ allow: false, reason: 'build-session' });
  });

  it('leaves a non-Build session alone', async () => {
    expect(await check({ admit: false, facts: planFacts })).toEqual({ allow: true });
  });

  it('leaves a child session alone', async () => {
    const childFacts = createAdmissionFacts({
      openCodeFetch: async (fetchPath) => (fetchPath === `/api/session/${SESSION}`
        ? sessionRecord({ agent: 'build', parentID: 'ses_parent_1' })
        : [{ id: 'build', default: true }]),
    });
    expect(await check({ admit: false, facts: childFacts })).toEqual({ allow: true });
  });

  it('leaves a project with the queue off alone', async () => {
    expect(await check({ admit: false, readEnabled: async () => false })).toEqual({ allow: true });
  });

  it('leaves a request with no project alone', async () => {
    expect(await check({ admit: false, resolveIdentity: async () => ({ directory: null, projectId: null }) }))
      .toEqual({ allow: true });
  });

  it('fails closed when the session cannot be read in an enabled project', async () => {
    const failing = createAdmissionFacts({ openCodeFetch: async () => { throw new Error('down'); } });
    expect(await check({ admit: false, facts: failing })).toEqual({ allow: false, reason: 'session-unreadable' });
  });

  it('fails closed when the setting cannot be read', async () => {
    expect(await check({ admit: false, readEnabled: async () => null }))
      .toEqual({ allow: false, reason: 'setting-unavailable' });
  });

  it('fails closed when the agent is unknown', async () => {
    // No session agent and no agent list to fall back on: the server cannot say
    // whether this is Build work, so an enabled project refuses.
    const noAgents = createAdmissionFacts({ openCodeFetch: async (fetchPath) => (fetchPath === `/api/session/${SESSION}` ? sessionRecord() : null) });
    expect(await check({ admit: false, facts: noAgents })).toEqual({ allow: false, reason: 'agent-unknown' });
  });
});

describe('execution-start variants and ownership guard', () => {
  const identity = async () => ({ directory: DIRECTORY, projectId: 'project-1' });
  const buildFacts = createAdmissionFacts({
    openCodeFetch: async (fetchPath) => {
      if (fetchPath === '/api/agent') return [{ id: 'build', default: true }];
      if (fetchPath === `/api/session/${SESSION}`) return sessionRecord({ agent: 'build' });
      return null;
    },
  });
  const check = (options = {}) => guardExecutionStart({
    body: options.body ?? {},
    query: options.query ?? {},
    sessionId: SESSION,
    directory: DIRECTORY,
    kind: options.kind,
    facts: options.facts ?? buildFacts,
    readEnabled: options.readEnabled ?? (async () => true),
    resolveIdentity: options.resolveIdentity ?? identity,
    hasManagedWork: options.hasManagedWork,
  });

  it('reads each route\'s execution default conservatively', () => {
    // A skill activation resumes unless told not to.
    expect(startsExecution({ kind: 'skill' })).toBe(true);
    expect(startsExecution({ kind: 'skill', body: { resume: false } })).toBe(false);
    // Interrupting never starts a turn; resuming does.
    expect(startsExecution({ kind: 'interrupt' })).toBe(false);
    expect(startsExecution({ kind: 'interrupt', query: { resume: 'true' } })).toBe(true);
    // Compaction is its own legitimate turn, never queue work.
    expect(startsExecution({ kind: 'compact', body: {} })).toBe(false);
    expect(startsExecution({ kind: 'shell' })).toBe(true);
  });

  it('refuses a skill activation that would resume a Build session', async () => {
    expect(await check({ kind: 'skill', body: { id: 'skill-1' } }))
      .toEqual({ allow: false, reason: 'build-session' });
    // Explicitly not resuming is allowed.
    expect(await check({ kind: 'skill', body: { id: 'skill-1', resume: false } })).toEqual({ allow: true });
  });

  it('refuses resuming a Build session but allows the interrupt itself', async () => {
    expect(await check({ kind: 'interrupt', query: {} })).toEqual({ allow: true });
    expect(await check({ kind: 'interrupt', query: { resume: 'true' } }))
      .toEqual({ allow: false, reason: 'build-session' });
  });

  it('leaves compaction alone: a compaction turn is not project build work', async () => {
    expect(await check({ kind: 'compact', body: {} })).toEqual({ allow: true });
  });

  it('refuses moving a session while the queue holds work for it', async () => {
    expect(await check({ kind: 'move', body: { directory: '/elsewhere' }, hasManagedWork: async () => true }))
      .toEqual({ allow: false, reason: 'session-move' });
    // An idle session with nothing queued may move.
    expect(await check({ kind: 'move', body: { directory: '/elsewhere' }, hasManagedWork: async () => false }))
      .toEqual({ allow: true });
  });

  it('refuses an inbox change that would steer managed work', async () => {
    expect(await check({ kind: 'inbox-update', body: { delivery: 'steer' }, hasManagedWork: async () => true }))
      .toEqual({ allow: false, reason: 'inbox-mutation' });
    expect(await check({ kind: 'inbox-mutation', hasManagedWork: async () => true }))
      .toEqual({ allow: false, reason: 'inbox-mutation' });
    // Nothing managed: the inbox is the caller's own.
    expect(await check({ kind: 'inbox-update', body: { delivery: 'steer' }, hasManagedWork: async () => false }))
      .toEqual({ allow: true });
  });

  it('ignores a route this guard does not own', async () => {
    expect(await check({ kind: 'config-update', body: {} })).toEqual({ allow: true });
  });
});
