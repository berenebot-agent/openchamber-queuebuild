// Managed Build Git boundary. Only the queue calls this module after confirming
// every session/subagent/background writer is idle. All ref updates use CAS.
// Unexpected state is an error and MUST retain the queue's unsafe lease.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const git = async (repository, ...args) => {
  const { stdout } = await exec('git', ['-C', repository, ...args], {
    timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8',
  });
  return stdout.trim();
};
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};
const refPart = (value) => {
  const part = String(value ?? '');
  assert(/^[a-zA-Z0-9_-]{4,128}$/.test(part), 'Invalid recovery identity');
  return part;
};
const clean = async (repository) =>
  (await git(repository, 'status', '--porcelain=v1', '--untracked-files=all')) === '';
const identity = async (repository) => {
  const real = await fs.realpath(repository);
  const root = await fs.realpath(await git(real, 'rev-parse', '--show-toplevel'));
  assert(path.resolve(real) === path.resolve(root), 'Managed Build requires the selected Git worktree root');
  const branch = await git(real, 'symbolic-ref', '-q', 'HEAD');
  assert(branch.startsWith('refs/heads/'), 'Managed Build requires an attached branch');
  const head = await git(real, 'rev-parse', '--verify', 'HEAD');
  assert(/^[0-9a-f]{40,64}$/.test(head), 'Managed Build requires an initial commit');
  return { repository: real, branch, head };
};
const sameBranch = async (baseline) => {
  const current = await identity(baseline.repository);
  assert(current.repository === baseline.repository && current.branch === baseline.branch,
    'Managed Build repository or branch changed');
  return current;
};
const descendantOf = async (repository, baseline, head) => {
  // Do not recover a branch reset by another writer or a divergent checkout.
  try {
    await git(repository, 'merge-base', '--is-ancestor', baseline, head);
    return true;
  } catch {
    return false;
  }
};

export async function captureManagedBaseline(repository) {
  const base = await identity(repository);
  assert(await clean(base.repository), 'Managed Build requires a clean working tree before dispatch');
  return base;
}

export async function verifyManagedSuccess(baseline) {
  const current = await sameBranch(baseline);
  assert(await descendantOf(current.repository, baseline.head, current.head),
    'Managed Build branch diverged from its baseline');
  assert(await clean(current.repository), 'Managed Build left uncommitted or untracked files');
  return { head: current.head };
}

/**
 * Preserve the whole net diff (including intermediate commits, staged edits
 * and untracked files), then restore the exact initial baseline. Never apply
 * the stash automatically; subsequent work receives its pinned ref.
 *
 * A rescue ref is written *before* moving the branch, and only deleted after
 * a verified clean recovery. If any step throws, the caller must keep its
 * durable unsafe lease; the rescue ref and existing bytes are left for review.
 */
export async function parkManagedFailure(baseline, sessionId, attemptId) {
  const current = await sameBranch(baseline);
  assert(await descendantOf(current.repository, baseline.head, current.head),
    'Cannot recover a branch that diverged from the managed baseline');
  const prefix = 'refs/openchamber/recovery/' + refPart(sessionId) + '/' + refPart(attemptId);
  const rescueRef = prefix + '/rescue';
  const stashRef = prefix + '/stash';
  const prior = await git(current.repository, 'show-ref', '--verify', rescueRef).then(() => true).catch(() => false);
  assert(!prior, 'This Build already has an incomplete recovery; reconcile it manually');
  await git(current.repository, 'update-ref', rescueRef, current.head, '0000000000000000000000000000000000000000');
  // CAS against the HEAD observed above; a concurrent commit must fail closed.
  if (current.head !== baseline.head) {
    await git(current.repository, 'update-ref', baseline.branch, baseline.head, current.head);
  }
  let stash = null;
  if (!(await clean(current.repository))) {
    const previous = await git(current.repository, 'rev-parse', '--verify', 'refs/stash').catch(() => null);
    await git(current.repository, 'stash', 'push', '--include-untracked', '-m',
      'openchamber recovery ' + sessionId + '/' + attemptId);
    stash = await git(current.repository, 'rev-parse', '--verify', 'refs/stash');
    assert(stash && stash !== previous, 'Git did not create a recovery stash');
    assert((await git(current.repository, 'rev-parse', stash + '^1')) === baseline.head,
      'Recovery stash does not match the recorded baseline');
    await git(current.repository, 'update-ref', stashRef, stash, '0000000000000000000000000000000000000000');
  }
  assert((await git(current.repository, 'rev-parse', 'HEAD')) === baseline.head,
    'Managed Build baseline could not be restored');
  assert(await clean(current.repository), 'Managed Build recovery did not leave a clean worktree');
  await git(current.repository, 'update-ref', '-d', rescueRef, current.head);
  return { ...baseline, attemptId, sessionId, stash, stashRef: stash ? stashRef : null,
    recoveredAt: Date.now() };
}

// Treat a footer as the agent's *report*, not authority to release a lease.
// OpenCode's terminal outcome and the Git verification remain mandatory.
export function readManagedReport(messages, attemptId, startedAt) {
  if (!Array.isArray(messages)) return { outcome: 'unknown', reason: 'History unavailable' };
  const since = (m) => {
    const info = m?.info ?? m;
    return Number(info?.time?.created ?? info?.time?.completed ?? 0) >= startedAt;
  };
  const entries = messages.filter(since);
  const terminal = entries.find(m => (m?.type ?? m?.info?.type) === 'idle');
  const terminalOutcome = terminal?.outcome ?? terminal?.info?.outcome;
  if (terminalOutcome === 'interrupted' || terminalOutcome === 'failed') {
    return { outcome: 'failed', reason: 'OpenCode reported ' + terminalOutcome };
  }
  if (terminalOutcome !== 'succeeded') return { outcome: 'unknown', reason: 'Terminal outcome unverified' };
  const replies = entries.filter(m => {
    const info = m?.info ?? m;
    return info?.role === 'assistant' || info?.type === 'assistant';
  });
  for (const reply of replies) {
    // OpenCode's message route puts reply text in `content[]`; `parts[]` is the
    // shape older fixtures and clients used. Only text blocks are reply text, so
    // a tool call's own output can never pass for the agent's report. Blocks are
    // joined because one reply can split its text over several of them.
    const text = (block) => (block?.type === 'text' ? block?.text : undefined);
    const blocks = (list) => (Array.isArray(list) ? list.map(text).filter(Boolean).join('\n') : '');
    const pieces = [
      reply?.text, reply?.message?.text, blocks(reply?.content), blocks(reply?.parts),
    ].filter(s => typeof s === 'string');
    for (const body of pieces) {
      const last = body.trim().split(/\r?\n/).at(-1) ?? '';
      const match = /^OPENCHAMBER_TURN_COMPLETE:\s*(\{.*\})$/.exec(last);
      if (!match) continue;
      let payload;
      try { payload = JSON.parse(match[1]); } catch { continue; }
      if (payload?.attempt_id !== attemptId) continue;
      if (!['success', 'failed', 'input_required'].includes(payload?.outcome)) continue;
      return { outcome: payload.outcome, reason: String(payload.reason ?? payload.summary ?? '').slice(0, 500) };
    }
  }
  return { outcome: 'unknown', reason: 'Missing valid managed completion footer' };
}
