import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const exec = promisify(execFile);
const MAX_PATHS = 30;
const MAX_BASELINES = 500;
const HASH_BUDGET = 32 * 1024 * 1024;

const git = async (directory, args) => (await exec('git', args, {
  cwd: directory, timeout: 10000, maxBuffer: 4 * 1024 * 1024,
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
})).stdout;

const parseStatus = (text) => {
  const fields = text.split('\0');
  const files = [];
  for (let i = 0; i < fields.length; i++) {
    if (!fields[i]) continue;
    const status = fields[i].slice(0, 2);
    files.push({ status, name: fields[i].slice(3) });
    if (/[RC]/.test(status)) files.push({ status: ' D', name: fields[++i] });
  }
  return files;
};

async function readSnapshot(directory) {
  const root = (await git(directory, ['rev-parse', '--show-toplevel'])).trim();
  const head = (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim();
  const branch = (await git(root, ['branch', '--show-current'])).trim();
  const status = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const files = parseStatus(status);
  let budget = HASH_BUDGET;
  const fingerprints = new Map();
  // shortcut: large dirty trees have no delta baseline; raise the budget only if measured demand warrants it.
  if (files.length <= 1000) {
    for (const file of files) {
      const filename = path.join(root, file.name);
      const stat = await fs.lstat(filename).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) { fingerprints.set(file.name, 'deleted'); continue; }
      if (stat.isSymbolicLink()) {
        fingerprints.set(file.name, `link:${await fs.readlink(filename)}`);
        continue;
      }
      budget -= stat.size;
      if (!stat.isFile() || budget < 0) break;
      const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const hash = createHash('sha256');
        let bytes = 0;
        for await (const chunk of handle.createReadStream({ autoClose: false })) {
          bytes += chunk.length;
          if (bytes > stat.size) throw new Error('File grew during the tree read');
          hash.update(chunk);
        }
        const after = await handle.stat();
        if (bytes !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) {
          throw new Error('File changed during the tree read');
        }
        fingerprints.set(file.name, `${stat.mode}:${hash.digest('hex')}`);
      } finally {
        await handle.close();
      }
    }
  }
  if (head !== (await git(root, ['rev-parse', '--verify', 'HEAD'])).trim()
    || status !== await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])) {
    throw new Error('Checkout changed during the tree read');
  }
  return { root, head, branch, files, fingerprints, complete: fingerprints.size === files.length };
}

const listFiles = (files) => [
  ...files.slice(0, MAX_PATHS).map(file => `${file.status} ${JSON.stringify(file.name)}`),
  ...(files.length > MAX_PATHS ? [`... ${files.length - MAX_PATHS} more paths omitted.`] : []),
].join('\n');

async function describeChanges(previous, current) {
  const changes = new Map();
  const fields = (await git(current.root, [
    'diff', '--name-status', '-z', '--no-renames', '--no-ext-diff', '--no-textconv', previous.head, current.head, '--',
  ])).split('\0');
  for (let i = 0; i + 1 < fields.length; i += 2) changes.set(fields[i + 1], fields[i]);
  const previousFiles = new Map(previous.files.map(file => [file.name, file.status]));
  const currentFiles = new Map(current.files.map(file => [file.name, file.status]));
  for (const name of new Set([...previousFiles.keys(), ...currentFiles.keys()])) {
    if (previous.fingerprints.get(name) === current.fingerprints.get(name)
      && previousFiles.get(name) === currentFiles.get(name)) continue;
    const status = currentFiles.get(name);
    const exists = await fs.lstat(path.join(current.root, name)).then(() => true, error => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    changes.set(name, !exists ? 'D' : status === '??' || /[AR]/.test(status ?? '')
      || previous.fingerprints.get(name) === 'deleted' ? 'A' : 'M');
  }
  return [...changes].sort(([a], [b]) => a.localeCompare(b)).map(([name, status]) => ({ name, status }));
}

/** Baselines belong to a session and checkout, regardless of its Plan/Build agent. */
export function createSessionTreeRuntime({ activityProbe, resolveRepository = async () => null, snapshot = readSnapshot }) {
  const baselines = new Map();
  const pending = new Map();
  const keyOf = (sessionId, directory) => JSON.stringify([sessionId, directory]);
  const read = async directory => snapshot(await resolveRepository(directory) || directory);

  const capture = async (sessionId, directory, token) => {
    const statuses = await activityProbe.fetchActiveSessionStatuses();
    if (!statuses) throw new Error('Session activity unavailable');
    if (statuses[sessionId]) return;
    const shells = await activityProbe.fetchRunningShellSessionIds(directory);
    if (!shells) throw new Error('Background shell activity unavailable');
    if (shells.has(sessionId)) return;
    const descendants = await activityProbe.hasWorkingDescendants(sessionId, statuses);
    const shellDescendants = await activityProbe.hasShellDescendants(sessionId, shells);
    if (descendants === null || shellDescendants === null) throw new Error('Descendant activity unavailable');
    if (descendants || shellDescendants) return;
    const state = await read(directory);
    if (pending.get(token.key) !== token) return;
    baselines.delete(token.key);
    if (state.complete) baselines.set(token.key, state);
    if (baselines.size > MAX_BASELINES) baselines.delete(baselines.keys().next().value);
  };

  return {
    reset() {
      pending.clear();
      baselines.clear();
    },
    async settle(sessionId, directory) {
      await pending.get(keyOf(sessionId, directory))?.promise;
    },
    processPayload(payload, directory) {
      const sessionId = payload.properties?.sessionID;
      if (!sessionId || !directory) return;
      const key = keyOf(sessionId, directory);
      if (payload.type === 'session.deleted') {
        pending.delete(key);
        baselines.delete(key);
        return;
      }
      if (payload.properties.aborted || payload.type === 'session.error') pending.delete(key);
      if (payload.type === 'session.status' && payload.properties.status?.type !== 'idle') {
        pending.delete(key);
      }
      if (payload.type !== 'session.idle' || payload.properties.aborted) return;
      const token = { key, promise: null };
      pending.set(key, token);
      token.promise = capture(sessionId, directory, token).catch(() => {
        if (pending.get(key) === token) baselines.delete(key);
      }).finally(() => {
        if (pending.get(key) === token) pending.delete(key);
      });
    },
    async describe(sessionId, directory) {
      const key = keyOf(sessionId, directory);
      await pending.get(key)?.promise;
      try {
        const current = await read(directory);
        const lines = [
          `Build starts from commit \`${current.head.slice(0, 9)}\`${current.branch ? ` on ${JSON.stringify(current.branch)}` : ' with detached HEAD'}. Working tree ${current.files.length ? 'has uncommitted changes' : 'clean'}.`,
        ];
        const previous = baselines.get(key);
        if (previous?.root === current.root && current.complete) {
          const changed = await describeChanges(previous, current).catch(() => null);
          if (changed?.length) lines.push(`Since your last completed turn:\n${listFiles(changed)}\n\nRe-read listed files if relevant to your task.`);
          else if (changed) lines.push('No file changes since your last completed turn.');
        }
        if (current.files.length) lines.push(`Uncommitted at build start:\n${listFiles(current.files)}\n\nPreserve pre-existing changes.`);
        return lines.join('\n\n');
      } catch {
        return '';
      }
    },
  };
}
