#!/usr/bin/env node
// Runs every test file under the given roots.
//
// Each file gets its own global object, so the module-level singletons
// (runtime endpoint, relay tunnel, stores, registries) and the process-global
// `mock.module` replacement the shared UI and extension suites rely on cannot
// leak across files. Bun's `--parallel` implements exactly that per-file
// isolation (`--isolate`: "run each test file in a fresh global object"), so
// the scheduler is Bun's rather than a pool of `bun test <file>` spawns. That
// removes the spawn overhead and lets `--timings` balance files across workers
// by measured duration, starting the slowest first instead of leaving the tail
// idle behind one long file.
//
// Usage: node scripts/run-isolated-tests.mjs <root> [...roots]
//
// OPENCHAMBER_TEST_JOBS sets the worker count (default: one fewer than the
// detected CPU count). OPENCHAMBER_TEST_TIMEOUT sets the per-test ceiling
// (default 30000ms). OPENCHAMBER_TEST_TIMINGS=0 disables the duration cache.

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';

import { resolveBunExecutable } from './lib/bun-executable.mjs';

// Per-file durations, reused across runs. Lives beside the installed packages
// so it survives a clean and never lands in a commit.
const TIMINGS_DIR = path.join('node_modules', '.cache', 'openchamber-test-timings');

// The suite is keyed by package identity, not the checkout directory, so the
// same source measured from a worktree or a differently named clone reuses the
// same timings instead of starting a second lineage. The name is an I/O value,
// so it is coerced to a string rather than narrowed with a runtime check.
const identifyPackage = () => {
  try {
    const manifest = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const name = String(manifest?.name ?? '').replace(/[^a-zA-Z0-9._-]/g, '_');
    if (name) return name;
  } catch {
    // No manifest (or an unreadable one) still needs a stable key.
  }
  return path.basename(process.cwd()).replace(/[^a-zA-Z0-9._-]/g, '_');
};

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('run-isolated-tests: expected at least one root directory');
  process.exit(1);
}

const resolvedRoots = roots.map((root) => {
  const resolved = path.resolve(root);
  if (!statSync(resolved).isDirectory()) {
    console.error(`run-isolated-tests: not a directory: ${root}`);
    process.exit(1);
  }
  return resolved;
});

const requestedJobs = Number.parseInt(process.env.OPENCHAMBER_TEST_JOBS ?? '', 10);
const jobs = Number.isFinite(requestedJobs) && requestedJobs > 0
  ? requestedJobs
  : Math.max(1, availableParallelism() - 1);

const args = ['test', `--parallel=${jobs}`, '--isolate'];

// Bun's 5s per-test default is a wall-clock ceiling, and a heavy-but-correct
// test (a 250 KB markdown render, a large fixture) crosses it under parallel
// load while its real assertion — an operation count — still holds. 30s matches
// the web suite's own testTimeout, so a slow test fails on its assertion rather
// than on how busy the machine was.
const requestedTimeout = Number.parseInt(process.env.OPENCHAMBER_TEST_TIMEOUT ?? '', 10);
const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0 ? requestedTimeout : 30_000;
args.push(`--timeout=${timeoutMs}`);

if (process.env.OPENCHAMBER_TEST_TIMINGS !== '0') {
  // A read-only checkout has no writable cache dir; the suite still runs, it
  // just loses the cross-run balancing.
  try {
    const timingsFile = path.join(process.cwd(), TIMINGS_DIR, `${identifyPackage()}.json`);
    mkdirSync(path.dirname(timingsFile), { recursive: true });
    args.push(`--timings=${timingsFile}`, '--update-timings');
  } catch {
    // Fall through: --parallel still balances greedily within the run.
  }
}

args.push(...resolvedRoots);

const child = spawn(resolveBunExecutable(), args, { stdio: 'inherit', windowsHide: true });
child.on('error', (error) => {
  console.error(`run-isolated-tests: ${error.message}`);
  process.exit(1);
});
child.on('close', (code) => process.exit(code ?? 1));
