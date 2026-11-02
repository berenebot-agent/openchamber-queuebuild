import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { captureManagedBaseline, verifyManagedSuccess, parkManagedFailure, readManagedReport } from './managed-git.js';

const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
async function withRepo(run) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-managed-'));
  try {
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'config', 'user.name', 'Build Test');
    await fs.writeFile(path.join(dir, 'file.txt'), 'original\n');
    git(dir, 'add', '--all');
    git(dir, 'commit', '-m', 'baseline');
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
test('managed success checks branch and clean committed history', async () => withRepo(async dir => {
  const baseline = await captureManagedBaseline(dir);
  await fs.writeFile(path.join(dir, 'file.txt'), 'updated\n');
  await assert.rejects(verifyManagedSuccess(baseline), /uncommitted/);
  git(dir, 'add', '--all');
  git(dir, 'commit', '-m', 'build');
  assert.ok((await verifyManagedSuccess(baseline)).head !== baseline.head);
}));
test('failed build preserves commits and untracked edits in stable pinned stash', async () => withRepo(async dir => {
  const baseline = await captureManagedBaseline(dir);
  await fs.writeFile(path.join(dir, 'file.txt'), 'committed\n');
  git(dir, 'add', '--all');
  git(dir, 'commit', '-m', 'partial');
  await fs.writeFile(path.join(dir, 'new.txt'), 'untracked\n');
  const result = await parkManagedFailure(baseline, 'session123', 'attempt123');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), baseline.head);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.equal(git(dir, 'rev-parse', result.stashRef), result.stash);
  assert.equal(git(dir, 'show', result.stash + ':file.txt'), 'committed');
  assert.equal(git(dir, 'show', result.stash + '^3:new.txt'), 'untracked');
}));
test('failed build with no changes releases cleanly with no stash', async () => withRepo(async dir => {
  const baseline = await captureManagedBaseline(dir);
  const result = await parkManagedFailure(baseline, 'session123', 'attempt123');
  assert.equal(result.stash, null);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), baseline.head);
}));
test('changed branch fails closed without altering either checkout', async () => withRepo(async dir => {
  const baseline = await captureManagedBaseline(dir);
  git(dir, 'checkout', '-b', 'another');
  await fs.writeFile(path.join(dir, 'file.txt'), 'keep\n');
  await assert.rejects(parkManagedFailure(baseline, 'session123', 'attempt123'), /branch changed/);
  assert.equal(await fs.readFile(path.join(dir, 'file.txt'), 'utf8'), 'keep\n');
}));
test('footer needs matching attempt and terminal success', () => {
  const history = [{ type: 'idle', outcome: 'succeeded', time: { created: 120 } },
    { type: 'assistant', time: { created: 110 }, parts: [{ text: 'Finished\nOPENCHAMBER_TURN_COMPLETE: {"attempt_id":"a","outcome":"success"}' }] }];
  assert.equal(readManagedReport(history, 'a', 100).outcome, 'success');
  assert.equal(readManagedReport(history, 'b', 100).outcome, 'unknown');
  assert.equal(readManagedReport([{ type: 'idle', outcome: 'interrupted', time: { created: 120 } }], 'a', 100).outcome, 'failed');
});
