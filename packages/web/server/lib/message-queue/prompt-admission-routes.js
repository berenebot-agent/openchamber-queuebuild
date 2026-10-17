// The admission middleware for the OpenCode session routes, registered ahead of
// the generic proxy the way the routing rewrite is.
//
// Two jobs, both server-side and both driven by live facts:
//
// 1. A request the client explicitly marked (`x-openchamber-build-queue: admit`)
//    is captured and queued instead of running now. It answers the full
//    `SessionInbox.User` record the SDK decodes, so the client's prompt call
//    resolves with the id it sent.
// 2. An execution-starting admission the server did **not** queue, on a Build
//    session of an enabled project, is refused. Without this a direct API
//    client could sidestep the lane by omitting the marker, or by starting a
//    turn through `synthetic` with execution enabled.
//
// Everything else — context-only synthetics, non-Build sessions, projects with
// the queue off — passes through untouched.

import express from 'express';
import {
  admitPrompt,
  guardExecutionStart,
  isAdmitRequest,
  promptBodySchema,
  queuedPromptResponse,
} from './admission.js';

const PROMPT_PATH = '/api/session/:sessionId/prompt';
const COMMAND_PATH = '/api/session/:sessionId/command';
const SYNTHETIC_PATH = '/api/session/:sessionId/synthetic';
const SKILL_PATH = '/api/experimental/session/:sessionId/skill';
const INTERRUPT_PATH = '/api/session/:sessionId/interrupt';
const COMPACT_PATH = '/api/session/:sessionId/compact';
const MOVE_PATH = '/api/session/:sessionId/move';
const SHELL_PATH = '/api/session/:sessionId/shell';
const INBOX_PATH = '/api/session/:sessionId/inbox/:inboxId';

// Synthetics admitted ahead of a prompt are staged so an admitted prompt can
// carry them. Bounded and short-lived: one that is never followed by a marked
// prompt is dropped, never forwarded twice.
const STAGED_TTL_MS = 30_000;
const STAGED_PER_SESSION_LIMIT = 8;

const createSyntheticStaging = (now) => {
  const bySession = new Map();
  return {
    stage(sessionId, text) {
      const entry = bySession.get(sessionId) ?? [];
      entry.push({ text, at: now() });
      bySession.set(sessionId, entry.slice(-STAGED_PER_SESSION_LIMIT));
    },
    take(sessionId) {
      const entry = bySession.get(sessionId) ?? [];
      bySession.delete(sessionId);
      return entry.filter((part) => now() - part.at <= STAGED_TTL_MS).map((part) => ({ text: part.text }));
    },
  };
};

export function registerQueuePromptAdmission(app, { messageQueueRuntime, facts, now = Date.now }) {
  if (!messageQueueRuntime?.admitSubmission) return;

  const parseJson = express.json({ limit: '50mb' });
  const staging = createSyntheticStaging(now);
  const readEnabled = (identity) => messageQueueRuntime.queueEnabledStateFor(identity);
  const resolveIdentity = (input) => messageQueueRuntime.resolveProjectIdentity(input);

  const withParsedBody = (handler) => (req, res, next) => {
    const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
    if (!contentType.includes('application/json')) return next();
    parseJson(req, res, (parseError) => {
      if (parseError) return next(parseError);
      handler(req, res, next);
    });
  };

  const directoryOf = (req) => {
    const url = new URL(req.url, 'http://localhost');
    const query = url.searchParams.get('directory');
    if (query) return query;
    const header = req.get('x-opencode-directory');
    if (!header) return undefined;
    const encoded = req.get('x-opencode-directory-encoding') === 'uri' || /%[0-9a-fA-F]{2}/.test(header);
    if (!encoded) return header;
    try { return decodeURIComponent(header); } catch { return header; }
  };

  const refuse = (res, reason) => {
    const detail = reason === 'setting-unavailable'
      ? 'The build queue setting could not be read on this server.'
      : reason === 'session-unreadable' || reason === 'agent-unknown'
        ? 'The session’s agent could not be verified.'
        : reason === 'session-move'
          ? 'This session has queued work; move it after the queue is clear.'
          : reason === 'inbox-mutation'
            ? 'This session’s queued work is managed by the build queue.'
            : 'This project runs Build prompts through the server queue.';
    return res.status(409).json({ error: `${detail} Retry through the OpenChamber composer.`, reason });
  };

  const guardInput = (parsedReq, kind) => ({
    body: parsedReq.body,
    query: { ...parsedReq.query },
    sessionId: parsedReq.params.sessionId,
    directory: directoryOf(parsedReq),
    kind,
    facts,
    readEnabled,
    resolveIdentity,
    hasManagedWork: (sessionId) => messageQueueRuntime.hasManagedWorkFor(sessionId),
  });

  /**
   * A route the queue can take: a marked request is admitted, an unmarked one
   * is checked by the guard and then forwarded.
   */
  const admissionRoute = ({ kind, answerQueued }) => (req, res, next) => withParsedBody(async (parsedReq, parsedRes, parsedNext) => {
    const sessionId = parsedReq.params.sessionId;
    // Taken once: a request that is not admitted must not leave staged text
    // behind for an unrelated later prompt.
    const leading = staging.take(sessionId);
    const marked = isAdmitRequest(parsedReq);
    if (marked && kind === 'synthetic') {
      // An execution-starting marked synthetic is not a shape this contract
      // carries: the queue admits prompts. A context-only one (resume:false) is
      // staged and rides the prompt that follows it.
      if (parsedReq.body?.resume !== false) {
        return parsedRes.status(409).json({ error: 'Synthetic execution cannot be queued; submit the prompt through the composer.', reason: 'synthetic-execution' });
      }
      const text = promptBodySchema.safeParse(parsedReq.body).data?.text ?? '';
      if (text) staging.stage(sessionId, text);
      return parsedNext();
    }
    try {
      if (marked) {
        const result = await admitPrompt({
          req: parsedReq,
          body: parsedReq.body,
          sessionId,
          directory: directoryOf(parsedReq),
          kind,
          facts,
          readEnabled,
          resolveIdentity,
          enqueue: (targetSessionId, directory, item) => messageQueueRuntime.admitSubmission({
            sessionId: targetSessionId,
            directory,
            item: { ...item, admission: { ...item.admission, leading } },
          }),
        });
        if (result.action === 'queued') return answerQueued({ req: parsedReq, res: parsedRes, sessionId });
      } else {
        const verdict = await guardExecutionStart(guardInput(parsedReq, kind));
        if (!verdict.allow) return refuse(parsedRes, verdict.reason);
      }
      return parsedNext();
    } catch (error) {
      // A failed admission is a failed prompt, not a silent passthrough: the
      // client asked for the queue and would otherwise run the turn twice.
      const status = error instanceof TypeError ? 400 : (Number.isInteger(error?.status) ? error.status : 500);
      return parsedRes.status(status).json({ error: error?.message ?? 'Failed to queue the build prompt' });
    }
  })(req, res, next);

  /**
   * A route the queue never takes, only guards: it is forwarded unless it would
   * start a Build turn or move work the queue manages.
   */
  const guardedRoute = ({ kind, readsBody = true }) => (req, res, next) => {
    const check = async (parsedReq, parsedRes, parsedNext) => {
      try {
        const verdict = await guardExecutionStart(guardInput(parsedReq, kind));
        if (!verdict.allow) return refuse(parsedRes, verdict.reason);
        return parsedNext();
      } catch (error) {
        return parsedRes.status(500).json({ error: error?.message ?? 'Admission check failed' });
      }
    };
    // A body-less route (interrupt) is checked on its query; one with a body is
    // parsed first so the guard can read `resume`.
    return readsBody ? withParsedBody(check)(req, res, next) : check(req, res, next);
  };

  app.post(PROMPT_PATH, admissionRoute({
    kind: 'prompt',
    answerQueued: ({ req, res, sessionId }) => {
      // The two headers are how the sender learns its prompt was queued rather
      // than run: the body decodes as the real admission, and the id names the
      // prompt whose optimistic record can now settle.
      const id = promptBodySchema.safeParse(req.body).data?.id ?? '';
      res.set('x-openchamber-queued', 'true');
      if (id) res.set('x-openchamber-queued-id', id);
      return res.status(200).json({
        ...queuedPromptResponse({ body: req.body, sessionId, now: now() }),
        queued: true,
      });
    },
  }));

  // The command route answers with no content, so a queued one answers 204.
  app.post(COMMAND_PATH, admissionRoute({ kind: 'command', answerQueued: ({ res }) => res.status(204).end() }));
  app.post(SYNTHETIC_PATH, admissionRoute({ kind: 'synthetic', answerQueued: ({ res }) => res.status(204).end() }));

  // Execution-starting routes the queue never takes, only guards. `move` and an
  // inbox change are guarded for ownership, not for execution.
  app.post(SKILL_PATH, guardedRoute({ kind: 'skill' }));
  app.post(INTERRUPT_PATH, guardedRoute({ kind: 'interrupt', readsBody: false }));
  app.post(MOVE_PATH, guardedRoute({ kind: 'move' }));
  app.patch(INBOX_PATH, guardedRoute({ kind: 'inbox-update' }));
  app.delete(INBOX_PATH, guardedRoute({ kind: 'inbox-mutation', readsBody: false }));
  // Shell runs a command in the checkout, not a model turn, but it mutates the
  // worktree a Build is serialized against, so it is guarded while one runs.
  app.post(SHELL_PATH, guardedRoute({ kind: 'shell' }));
}
