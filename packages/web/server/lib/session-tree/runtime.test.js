import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionTreeRuntime } from './runtime.js';

const exec = promisify(execFile);
const directories = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true });
});

const activity = () => ({
  fetchActiveSessionStatuses: vi.fn(async () => ({})),
  fetchRunningShellSessionIds: vi.fn(async () => new Set()),
  hasWorkingDescendants: vi.fn(async () => false),
  hasShellDescendants: vi.fn(async () => false),
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'session-tree-'));
  directories.push(directory);
  const git = async (...args) => (await exec('git', args, { cwd: directory })).stdout;
  await git('init', '-b', 'main');
  await git('config', 'user.name', 'Tree test');
  await git('config', 'user.email', 'tree@example.invalid');
  await fs.writeFile(path.join(directory, 'original.txt'), 'original');
  await fs.writeFile(path.join(directory, 'deleted.txt'), 'original');
  await git('add', '.');
  await git('commit', '-qm', 'baseline');
  const probe = activity();
  const runtime = createSessionTreeRuntime({ activityProbe: probe });
  const complete = async (sessionId = 'ses_test') => {
    runtime.processPayload({ type: 'session.idle', properties: { sessionID: sessionId } }, directory);
    await runtime.settle(sessionId, directory);
  };
  return { directory, git, probe, runtime, complete };
}

describe('dispatch tree context', () => {
  it('shows HEAD and cleanliness without a missing-baseline notice', async () => {
    const { runtime, directory } = await fixture();
    const text = await runtime.describe('ses_test', directory);
    expect(text).toMatch(/^Build starts from commit `[a-f0-9]{9}` on "main"\. Working tree clean\.$/);
  });

  it('reports committed additions, modifications and deletions since this session ended', async () => {
    const { runtime, directory, git, complete } = await fixture();
    await complete();
    await fs.writeFile(path.join(directory, 'original.txt'), 'changed');
    await fs.writeFile(path.join(directory, 'added.txt'), 'added');
    await fs.unlink(path.join(directory, 'deleted.txt'));
    await git('add', '.');
    await git('commit', '-qm', 'another build');
    const text = await runtime.describe('ses_test', directory);
    expect(text).toContain('Working tree clean.');
    expect(text).toContain('A "added.txt"');
    expect(text).toContain('D "deleted.txt"');
    expect(text).toContain('M "original.txt"');
    expect(text).toContain('Re-read listed files if relevant to your task.');
  });

  it('detects content changes even when a dirty file stays M', async () => {
    const { runtime, directory, complete } = await fixture();
    await fs.writeFile(path.join(directory, 'original.txt'), 'first dirty version');
    await complete();
    await fs.writeFile(path.join(directory, 'original.txt'), 'second dirty version');
    const text = await runtime.describe('ses_test', directory);
    expect(text).toContain('Since your last completed turn:\nM "original.txt"');
    expect(text).toContain('Uncommitted at build start:\n M "original.txt"');
    expect(text).toContain('Preserve pre-existing changes.');
  });

  it('keeps separate session baselines across Plan and Build turns', async () => {
    const { runtime, directory, git, complete } = await fixture();
    await complete('ses_plan_then_build');
    await fs.writeFile(path.join(directory, 'original.txt'), 'another session');
    await git('add', '.');
    await git('commit', '-qm', 'another session');
    await complete('ses_other');
    expect(await runtime.describe('ses_plan_then_build', directory)).toContain('M "original.txt"');
    expect(await runtime.describe('ses_other', directory)).toContain('No file changes since your last completed turn.');
  });

  it('reports staged additions and deleted files in the delta and dirty list', async () => {
    const { runtime, directory, git, complete } = await fixture();
    await complete();
    await fs.writeFile(path.join(directory, 'staged.txt'), 'added');
    await git('add', 'staged.txt');
    await git('rm', 'deleted.txt');
    const text = await runtime.describe('ses_test', directory);
    expect(text).toContain('A "staged.txt"');
    expect(text).toContain('D "deleted.txt"');
    expect(text).toContain('A  "staged.txt"');
  });

  it('does not capture a pause for descendants or background shells', async () => {
    const { runtime, directory, complete, probe } = await fixture();
    probe.hasWorkingDescendants.mockResolvedValue(true);
    await complete();
    expect(await runtime.describe('ses_test', directory)).not.toContain('last completed turn');
    probe.hasWorkingDescendants.mockResolvedValue(false);
    probe.fetchRunningShellSessionIds.mockResolvedValue(new Set(['ses_test']));
    await complete();
    expect(await runtime.describe('ses_test', directory)).not.toContain('last completed turn');
    probe.fetchRunningShellSessionIds.mockResolvedValue(new Set());
    await complete();
    expect(await runtime.describe('ses_test', directory)).toContain('No file changes since your last completed turn.');
  });

  it('bounds path lists and escapes unusual file names', async () => {
    const { runtime, directory } = await fixture();
    await Promise.all(Array.from({ length: 35 }, (_, i) => fs.writeFile(path.join(directory, `new-${i}\n.txt`), 'new')));
    const text = await runtime.describe('ses_test', directory);
    expect(text).toContain('5 more paths omitted.');
    expect(text).toContain('\\n.txt"');
    expect(text).not.toContain('No file changes');
  });

  it('does not claim a failed Git read is clean', async () => {
    const { runtime, directory } = await fixture();
    expect(await runtime.describe('ses_test', path.join(directory, 'missing'))).toBe('');
  });

  it('uses the project-selected repository under a non-Git workspace', async () => {
    const { directory, probe } = await fixture();
    const runtime = createSessionTreeRuntime({ activityProbe: probe, resolveRepository: async () => directory });
    expect(await runtime.describe('ses_test', '/workspace')).toContain('Working tree clean.');
    runtime.processPayload({ type: 'session.idle', properties: { sessionID: 'ses_test' } }, '/workspace');
    await runtime.settle('ses_test', '/workspace');
    expect(await runtime.describe('ses_test', '/workspace')).toContain('No file changes since your last completed turn.');
    runtime.reset();
    expect(await runtime.describe('ses_test', '/workspace')).not.toContain('last completed turn');
  });

  it('reports removed untracked files and renames, without reading symlink targets', async () => {
    const { runtime, directory, complete } = await fixture();
    await fs.writeFile(path.join(directory, 'temporary.txt'), 'temporary');
    await complete();
    await fs.unlink(path.join(directory, 'temporary.txt'));
    await fs.rename(path.join(directory, 'original.txt'), path.join(directory, 'renamed.txt'));
    await fs.symlink('/missing/private-target', path.join(directory, 'link'));
    const text = await runtime.describe('ses_test', directory);
    expect(text).toContain('D "temporary.txt"');
    expect(text).toContain('D "original.txt"');
    expect(text).toContain('A "renamed.txt"');
    expect(text).toContain('A "link"');
    expect(text).not.toContain('private-target');
  });

  it('drops an uncertain completion baseline instead of claiming nothing changed', async () => {
    const { runtime, directory, complete, probe } = await fixture();
    await complete();
    probe.fetchActiveSessionStatuses.mockResolvedValue(null);
    await complete();
    expect(await runtime.describe('ses_test', directory)).not.toContain('last completed turn');
  });

  it('does not publish an idle snapshot after a newer busy event', async () => {
    let finish;
    const snapshot = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    const runtime = createSessionTreeRuntime({ activityProbe: activity(), snapshot });
    const properties = { sessionID: 'ses_test' };
    runtime.processPayload({ type: 'session.idle', properties }, '/repo');
    await vi.waitFor(() => expect(snapshot).toHaveBeenCalled());
    runtime.processPayload({ type: 'session.status', properties: { ...properties, status: { type: 'busy' } } }, '/repo');
    const state = { root: '/repo', head: 'a'.repeat(40), branch: 'main', files: [], fingerprints: new Map(), complete: true };
    finish(state);
    snapshot.mockResolvedValue(state);
    await Promise.resolve();
    expect(await runtime.describe('ses_test', '/repo')).not.toContain('last completed turn');
  });
});
