import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { prepareQueuedBuild } from './queued-build.js';

const exec = promisify(execFile);
const directories = [];
const env = { ...process.env, GIT_CONFIG_GLOBAL: os.devNull, GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Queue Test', GIT_AUTHOR_EMAIL: 'queue@example.test',
  GIT_COMMITTER_NAME: 'Queue Test', GIT_COMMITTER_EMAIL: 'queue@example.test', LC_ALL: 'C' };
async function git(directory, args) {
  try {
    const result = await exec('git', args, { cwd: directory, env, maxBuffer: 20 * 1024 * 1024 });
    return { ...result, success: true, exitCode: 0 };
  } catch (error) {
    return { success: false, exitCode: error.code, stdout: error.stdout || '', stderr: error.stderr || '' };
  }
}
async function stageSource(directory) {
  await git(directory, ['init']);
  await git(directory, ['add', 'source.py']);
}
async function fixture() {
  // The configured scratch directory has an ancestor .git marker on this box.
  // Initialization fixtures need a directory outside any existing Git tree.
  const tempRoot = process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const directory = await fs.mkdtemp(path.join(tempRoot, 'openchamber-queued-build-'));
  directories.push(directory);
  await fs.writeFile(path.join(directory, 'source.py'), 'print("hello")\n');
  return directory;
}
const prepare = (directory, options = {}) => prepareQueuedBuild({
  directory, run: git, generateMessage: async () => 'Add project source', onProgress: () => {}, isCurrent: () => true, ...options,
});
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
});

describe('automatic build commits', () => {
  it('leaves files unchanged if Git is unavailable', async () => {
    const directory = await fixture();
    await expect(prepare(directory, { run: async () => ({ success: false, exitCode: null, stderr: '', stdout: '' }) })).rejects.toThrow('Cannot inspect Git');
    expect(await fs.readdir(directory)).toEqual(['source.py']);
  });

  it('refuses an unfinished Git operation even when the working tree is clean', async () => {
    const directory = await fixture();
    await stageSource(directory);
    const first = await prepare(directory);
    await fs.writeFile(path.join(directory, '.git', 'MERGE_HEAD'), first.hash + '\n');
    await expect(prepare(directory)).rejects.toThrow('Finish the current merge');
    expect((await git(directory, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(first.hash);
  });

  it('keeps unstaged edits made during generation and reports the remaining changes', async () => {
    const directory = await fixture();
    await stageSource(directory);
    await expect(prepare(directory, { generateMessage: async () => {
      await fs.writeFile(path.join(directory, 'source.py'), 'newer content');
      return 'Save staged source';
    } })).rejects.toThrow('A commit was created, but changes remain');
    expect((await git(directory, ['log', '-1', '--format=%s'])).stdout.trim()).toBe('Save staged source');
    expect(await fs.readFile(path.join(directory, 'source.py'), 'utf8')).toBe('newer content');
  });

  it.runIf(process.platform !== 'win32')('preserves hooks and keeps staged work after a hook failure', async () => {
    const directory = await fixture();
    await git(directory, ['init']);
    await fs.writeFile(path.join(directory, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await git(directory, ['add', 'source.py']);
    await expect(prepare(directory)).rejects.toThrow('Commit failed');
    expect((await git(directory, ['rev-parse', '--verify', 'HEAD'])).success).toBe(false);
    expect((await git(directory, ['diff', '--cached', '--name-only'])).stdout).toContain('source.py');
  });
  it('initializes Git, ignores local files and commits with the model message', async () => {
    const directory = await fixture();
    expect(await git(directory, ['rev-parse', '--show-toplevel'])).toMatchObject({ exitCode: 128, stderr: expect.stringContaining('not a git repository') });
    await fs.writeFile(path.join(directory, '.env'), 'SECRET=not-real\n');
    await fs.writeFile(path.join(directory, '.env.local'), 'SECRET=not-real\n');
    await fs.writeFile(path.join(directory, '.env.example'), 'SECRET=\n');
    await fs.mkdir(path.join(directory, '__pycache__'));
    await fs.writeFile(path.join(directory, '__pycache__', 'source.pyc'), 'cache');
    await fs.mkdir(path.join(directory, 'node_modules'));
    await fs.writeFile(path.join(directory, 'node_modules', 'package.js'), 'generated');
    const phases = [];
    let input;
    await expect(prepare(directory)).rejects.toThrow('No changes are staged');
    await git(directory, ['add', '-A']);
    const result = await prepare(directory, { onProgress: phase => phases.push(phase), generateMessage: async value => {
      input = value;
      return 'Initialize project source';
    } });
    expect(result.subject).toBe('Initialize project source');
    expect(result.hash).toMatch(/^[a-f0-9]{40,64}$/);
    expect((await git(directory, ['ls-files'])).stdout.trim().split('\n')).toEqual(['.env.example', '.gitignore', 'source.py']);
    expect(input.diff).not.toContain('not-real');
    expect(phases).toEqual(['initializing', 'staging', 'generating', 'committing']);
    expect((await git(directory, ['status', '--porcelain'])).stdout).toBe('');
  });

  it('preserves an existing ignore file when initializing', async () => {
    const directory = await fixture();
    await fs.writeFile(path.join(directory, '.gitignore'), 'custom.tmp\n');
    await fs.writeFile(path.join(directory, 'custom.tmp'), 'local');
    await expect(prepare(directory)).rejects.toThrow('No changes are staged');
    await git(directory, ['add', '-A']);
    await prepare(directory);
    expect(await fs.readFile(path.join(directory, '.gitignore'), 'utf8')).toMatch(/^custom.tmp\n/);
    expect((await git(directory, ['ls-files'])).stdout).not.toContain('custom.tmp');
  });

  it('does not call the model or change a clean repository', async () => {
    const directory = await fixture();
    await stageSource(directory);
    const first = await prepare(directory);
    expect(await prepare(directory, { generateMessage: async () => { throw new Error('Unexpected generation'); } })).toBeNull();
    expect((await git(directory, ['rev-parse', 'HEAD'])).stdout.trim()).toBe(first.hash);
  });

  it('commits explicitly staged new, modified and deleted files without rewriting existing ignores', async () => {
    const directory = await fixture();
    await fs.writeFile(path.join(directory, '.gitignore'), 'custom.tmp\n');
    await stageSource(directory);
    await git(directory, ['add', '.gitignore']);
    await prepare(directory);
    const ignore = await fs.readFile(path.join(directory, '.gitignore'), 'utf8');
    await fs.writeFile(path.join(directory, 'new.txt'), 'new');
    await git(directory, ['add', 'new.txt']);
    await fs.writeFile(path.join(directory, 'new.txt'), 'updated');
    await fs.unlink(path.join(directory, 'source.py'));
    await git(directory, ['add', '-A']);
    await prepare(directory);
    expect((await git(directory, ['show', 'HEAD:new.txt'])).stdout).toBe('updated');
    expect((await git(directory, ['ls-files'])).stdout).not.toContain('source.py');
    expect(await fs.readFile(path.join(directory, '.gitignore'), 'utf8')).toBe(ignore);
  });

  it('keeps staged changes on model failure and rejects invalid messages', async () => {
    const directory = await fixture();
    await stageSource(directory);
    await expect(prepare(directory, { generateMessage: async () => { throw new Error('Model unavailable'); } })).rejects.toThrow('Model unavailable');
    expect((await git(directory, ['diff', '--cached', '--name-only'])).stdout).toContain('source.py');
    expect((await git(directory, ['rev-parse', '--verify', 'HEAD'])).success).toBe(false);
    await expect(prepare(directory, { generateMessage: async () => '```bad```' })).rejects.toThrow('usable commit message');
  });

  it('refuses changed staged state during generation', async () => {
    const directory = await fixture();
    await stageSource(directory);
    await expect(prepare(directory, { generateMessage: async () => {
      await fs.writeFile(path.join(directory, 'source.py'), 'changed');
      await git(directory, ['add', 'source.py']);
      return 'Old message';
    } })).rejects.toThrow('Git changed');
    expect((await git(directory, ['rev-parse', '--verify', 'HEAD'])).success).toBe(false);
  });

  it('uses a parent repository and refuses unrelated staged files', async () => {
    const directory = await fixture();
    await stageSource(directory);
    await prepare(directory);
    const project = path.join(directory, 'child');
    await fs.mkdir(project);
    await fs.writeFile(path.join(project, 'child.txt'), 'child');
    await fs.writeFile(path.join(directory, 'source.py'), 'outside');
    await git(directory, ['add', 'source.py']);
    await expect(prepare(project)).rejects.toThrow('outside this project');
    await expect(fs.stat(path.join(project, '.git'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cancels before committing if the queued item was removed', async () => {
    const directory = await fixture();
    await stageSource(directory);
    let current = true;
    await expect(prepare(directory, { isCurrent: () => current, generateMessage: async () => {
      current = false;
      return 'Cancelled';
    } })).rejects.toThrow('cancelled');
    expect((await git(directory, ['rev-parse', '--verify', 'HEAD'])).success).toBe(false);
  });

  it('does not follow a symlinked ignore file', async () => {
    const directory = await fixture();
    const outside = path.join(directory, 'outside.txt');
    await fs.writeFile(outside, 'keep');
    await fs.symlink(outside, path.join(directory, '.gitignore'));
    await expect(prepare(directory)).rejects.toThrow();
    expect(await fs.readFile(outside, 'utf8')).toBe('keep');
  });
  it('does not stage unstaged or untracked files or expose them to the model', async () => {
    const directory = await fixture();
    await stageSource(directory);
    await fs.writeFile(path.join(directory, 'scratch.txt'), 'unrelated local work');
    let modelCalled = false;
    await expect(prepare(directory, { generateMessage: async () => {
      modelCalled = true;
      return 'Unexpected commit';
    } })).rejects.toThrow('Unstaged or untracked project files remain');
    expect(modelCalled).toBe(false);
    expect((await git(directory, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('source.py');
    expect((await git(directory, ['rev-parse', '--verify', 'HEAD'])).success).toBe(false);
  });

  it('rejects staged credential paths before calling the commit-message model', async () => {
    const directory = await fixture();
    await git(directory, ['init']);
    await fs.writeFile(path.join(directory, '.env.local'), 'PASSWORD=sensitive');
    await git(directory, ['add', '.env.local']);
    let modelCalled = false;
    await expect(prepare(directory, { generateMessage: async () => {
      modelCalled = true;
      return 'Commit credentials';
    } })).rejects.toThrow('sensitive path');
    expect(modelCalled).toBe(false);
  });

  it('rejects private keys embedded in otherwise normal staged source files', async () => {
    const directory = await fixture();
    await fs.writeFile(path.join(directory, 'source.py'),
      'secret = "-----BEGIN PRIVATE KEY-----"\n');
    await stageSource(directory);
    let modelCalled = false;
    await expect(prepare(directory, { generateMessage: async () => {
      modelCalled = true;
      return 'Commit source';
    } })).rejects.toThrow('secret material');
    expect(modelCalled).toBe(false);
    expect((await git(directory, ['rev-parse', '--verify', 'HEAD'])).success).toBe(false);
  });

  it('refuses to auto-stage an existing tracked change', async () => {
    const directory = await fixture();
    await stageSource(directory);
    await prepare(directory);
    await fs.writeFile(path.join(directory, 'source.py'), 'local unreviewed edit\n');
    await expect(prepare(directory)).rejects.toThrow('No changes are staged');
    expect((await git(directory, ['diff', '--cached', '--name-only'])).stdout.trim()).toBe('');
  });

});
