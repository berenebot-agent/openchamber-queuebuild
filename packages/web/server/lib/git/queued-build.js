import fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { unsupportedRepositoryRootReason } from './repository-root.js';

// Adapted from github/gitignore's Python, Node, macOS and Windows templates
// (CC0-1.0): https://github.com/github/gitignore. Kept deliberately small.
const ignoreRules = [
  '.env', '.env.*', '!.env.example', '!.env.sample', '!.env.template',
  '__pycache__/', '*.py[codz]', '*$py.class', '.venv/', 'venv/', 'ENV/',
  '.pytest_cache/', '.mypy_cache/', '.ruff_cache/', '.tox/', '.nox/',
  'node_modules/', '.DS_Store', 'Thumbs.db', 'Desktop.ini',
];

async function installIgnore(directory) {
  const filename = path.join(directory, '.gitignore');
  let before = null;
  try {
    before = await fs.lstat(filename);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (before && !before.isFile()) throw new Error('The default .gitignore requires a regular file.');
  const flags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK
    | (before ? 0 : constants.O_CREAT | constants.O_EXCL);
  const file = await fs.open(filename, flags, 0o644);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || (before && (before.dev !== opened.dev || before.ino !== opened.ino))) {
      throw new Error('The .gitignore changed during preparation. Retry after checking the file.');
    }
    const existing = await file.readFile('utf8');
    const lines = new Set(existing.split(/\r?\n/));
    const missing = ignoreRules.filter(rule => !lines.has(rule));
    if (missing.length === 0) return;
    await file.writeFile(`${existing && !existing.endsWith('\n') ? '\n' : ''}\n# OpenChamber automatic queue baseline (github/gitignore, CC0-1.0)\n${missing.join('\n')}\n`);
  } finally {
    await file.close();
  }
}

async function hasGitEntry(directory) {
  for (let current = directory; ; current = path.dirname(current)) {
    try {
      await fs.lstat(path.join(current, '.git'));
      return true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (current === path.dirname(current)) return false;
  }
}

/** Runs inside the Git service's repository index mutation queue. */
export async function prepareQueuedBuild({ directory, run, generateMessage, onProgress, isCurrent }) {
  const project = await fs.realpath(directory);
  const assertCurrent = () => {
    if (!isCurrent()) throw new Error('Build preparation was cancelled. Any prepared changes remain staged.');
  };
  const execute = async (cwd, args, operation) => {
    assertCurrent();
    const result = await run(cwd, args);
    if (!result.success) throw new Error(`${operation} failed. Check Git configuration, permissions, hooks and signing before retrying.`);
    return result.stdout;
  };
  onProgress('initializing');
  let probe = await run(project, ['rev-parse', '--show-toplevel']);
  if (!probe.success) {
    if (probe.exitCode !== 128 || !probe.stderr.includes('not a git repository') || await hasGitEntry(project)) {
      throw new Error('Cannot inspect Git. Check that Git is installed and this directory is accessible.');
    }
    if (unsupportedRepositoryRootReason(project)) throw new Error('Cannot initialize Git in a home directory or filesystem root.');
    assertCurrent();
    await installIgnore(project);
    await execute(project, ['init'], 'Git initialization');
    probe = await run(project, ['rev-parse', '--show-toplevel']);
  }
  if (!probe.success) throw new Error('Cannot find the repository after Git initialization.');
  const root = await fs.realpath(probe.stdout.trim());
  if (unsupportedRepositoryRootReason(root)) throw new Error('Cannot prepare a repository rooted at a home directory or filesystem root.');
  const relative = path.relative(root, project).split(path.sep).join('/');
  const scope = relative ? `:(literal)${relative}` : '.';
  const status = await execute(root, ['status', '--porcelain=v1', '--untracked-files=normal'], 'Git status');
  const conflicts = await execute(root, ['ls-files', '--unmerged', '-z'], 'Conflict inspection');
  if (conflicts) throw new Error('Resolve Git conflicts before retrying the queued build.');
  const gitDirectory = (await execute(root, ['rev-parse', '--absolute-git-dir'], 'Git operation inspection')).trim();
  for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
    try {
      await fs.lstat(path.join(gitDirectory, marker));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('Finish the current merge, rebase or cherry-pick before retrying the queued build.');
  }
  if (!status.trim()) return null;
  const stagedPaths = (await execute(root, ['diff', '--cached', '--name-only', '--no-renames', '-z'], 'Staged file inspection')).split('\0').filter(Boolean);
  if (relative && stagedPaths.some(file => !file.startsWith(relative + '/'))) {
    throw new Error('Changes outside this project are staged. Commit or unstage them before retrying the queued build.');
  }
  await execute(root, ['var', 'GIT_AUTHOR_IDENT'], 'Git author inspection');
  onProgress('staging');
  await execute(root, ['add', '-A', '--', scope], 'Staging');
  const files = await execute(root, ['diff', '--cached', '--stat'], 'Staged summary');
  if (!files.trim()) throw new Error('Changes remain outside this project or inside a submodule. Commit them before continuing.');
  const tree = (await execute(root, ['write-tree'], 'Staged snapshot')).trim();
  const headBefore = await run(root, ['rev-parse', '--verify', 'HEAD']);
  const diff = await execute(root, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--no-color'], 'Staged diff');
  onProgress('generating');
  const message = (await generateMessage({ directory: project, summary: files.slice(0, 24000), diff: diff.slice(0, 120000) })).trim();
  if (!message || message.length > 4000 || message.includes('\0') || message.startsWith('```')) {
    throw new Error('The model did not return a usable commit message. Retry preparation to generate another.');
  }
  const currentTree = (await execute(root, ['write-tree'], 'Staged snapshot verification')).trim();
  const headAfter = await run(root, ['rev-parse', '--verify', 'HEAD']);
  if (tree !== currentTree || headBefore.success !== headAfter.success || headBefore.stdout !== headAfter.stdout) {
    throw new Error('Git changed while the commit message was generated. Retry preparation for the current changes.');
  }
  onProgress('committing');
  await execute(root, ['commit', '-m', message], 'Commit');
  const hash = (await execute(root, ['rev-parse', 'HEAD'], 'Commit verification')).trim();
  const subject = (await execute(root, ['log', '-1', '--format=%s'], 'Commit summary')).trim();
  const remaining = await execute(root, ['status', '--porcelain=v1', '--untracked-files=normal'], 'Clean working tree verification');
  if (remaining.trim()) throw new Error('A commit was created, but changes remain. Check the working tree before retrying the queue.');
  return { hash, subject };
}
