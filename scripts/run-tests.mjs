#!/usr/bin/env node
// Full-suite entry point for `bun run test`.
//
// The web suite is the long pole and spends most of its wall time in real
// subprocess and deadline waits, so the CPU-bound tiers overlap it rather than
// queueing behind it. What this adds over a plain `&&` chain is that every tier
// runs even when an earlier one fails, the full detail is timestamped to disk
// as it happens, and one line of metadata plus a ledger entry records what was
// run so a failure never needs a re-run to place in time.
//
// Env: OPENCHAMBER_TEST_JOBS / OPENCHAMBER_VITEST_WORKERS size the workers (see
// the tier runners); OPENCHAMBER_TEST_OVERLAP=1 runs the tiers concurrently;
// OPENCHAMBER_TEST_LOG_DIR moves the artifacts.

import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, totalmem } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isolated = (name, cwd, ...roots) => ({ name, cwd, command: ['node', path.join(ROOT, 'scripts/run-isolated-tests.mjs'), ...roots] });

const TIERS = [
  isolated('scripts', ROOT, 'scripts'),
  isolated('sdk', path.join(ROOT, 'packages/sdk'), 'src', 'scripts'),
  isolated('ui', path.join(ROOT, 'packages/ui'), 'src'),
  isolated('vscode', path.join(ROOT, 'packages/vscode'), 'src', 'webview'),
  isolated('electron', path.join(ROOT, 'packages/electron'), '.'),
  { name: 'web', cwd: path.join(ROOT, 'packages/web'), command: ['bun', 'run', 'test'] },
];

const gitOutput = (args) => {
  const result = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : '';
};

const runId = new Date().toISOString().replace(/[:.]/g, '-');
const resultsDir = process.env.OPENCHAMBER_TEST_LOG_DIR || path.join(ROOT, 'test-results');
mkdirSync(resultsDir, { recursive: true });
const detailPath = path.join(resultsDir, `run-${runId}.log`);
const ledgerPath = path.join(resultsDir, 'ledger.ndjson');

const enginesNode = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).engines?.node ?? '';
const minimumMajor = Number.parseInt(/>=?\s*(\d+)/.exec(enginesNode)?.[1] ?? '', 10);
const nodeMajor = Number.parseInt(process.versions.node, 10);
const toolchainWarning = Number.isFinite(minimumMajor) && nodeMajor < minimumMajor
  ? `WARNING: node ${process.versions.node} is below the required >=${minimumMajor}; some suites fail on the wrong runtime`
  : null;

// Output is written in blocks rather than per chunk: a chatty runner (vitest
// prints every test's logs) otherwise forces a synchronous write per chunk,
// which back-pressures the child's stdout pipe. Only the tail is retained for
// the failure report, the same way the previous runner bounded it.
const FLUSH_BYTES = 256 * 1024;
const RETAIN_BYTES = 1024 * 1024;

const runTier = (tier) => new Promise((resolve) => {
  const startedAt = Date.now();
  let retained = '';
  let pending = '';
  const flush = () => {
    if (!pending) return;
    appendFileSync(detailPath, pending);
    pending = '';
  };
  const append = (text) => {
    if (!text) return;
    const stamp = `[+${((Date.now() - startedAt) / 1000).toFixed(1)}s]`;
    pending += text.split('\n').filter(Boolean).map((line) => `${stamp} ${tier.name} ${line}`).join('\n') + '\n';
    if (pending.length > FLUSH_BYTES) flush();
    retained = (retained + text).slice(-RETAIN_BYTES);
  };
  const child = spawn(tier.command[0], tier.command.slice(1), {
    cwd: tier.cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child.stdout.on('data', (data) => append(data.toString()));
  child.stderr.on('data', (data) => append(data.toString()));
  child.on('error', (error) => append(`${error.message}\n`));
  child.on('close', (code) => {
    flush();
    resolve({ tier: tier.name, code: code ?? 1, ms: Date.now() - startedAt, output: retained });
  });
});

const runStartedAt = Date.now();
console.log(`openchamber test run ${runId}`);
if (toolchainWarning) console.log(toolchainWarning);
console.log(`detail: ${detailPath}\n`);

// Tiers run in sequence by default. Overlapping them was measured ~10% faster
// on an idle host, but the web suite is full of real deadline/retry tests, and
// the CPU-bound tiers running beside it made those tests miss their deadlines
// (message-queue build-lease tests failed only in the overlapped run and pass
// in isolation). Determinism wins: OPENCHAMBER_TEST_OVERLAP=1 opts back in on a
// host with spare capacity.
const results = [];
const runAndRecord = async (tier) => {
  const result = await runTier(tier);
  results.push(result);
  return result;
};

if (process.env.OPENCHAMBER_TEST_OVERLAP === '1') {
  const webTier = TIERS.find((tier) => tier.name === 'web');
  await Promise.all([
    runAndRecord(webTier),
    (async () => {
      for (const tier of TIERS) {
        if (tier !== webTier) await runAndRecord(tier);
      }
    })(),
  ]);
} else {
  for (const tier of TIERS) await runAndRecord(tier);
}

for (const tier of TIERS) {
  const result = results.find((entry) => entry.tier === tier.name);
  console.log(`${result.code === 0 ? 'PASS' : 'FAIL'}  ${tier.name.padEnd(9)} ${(result.ms / 1000).toFixed(1)}s`);
}

for (const result of results.filter((entry) => entry.code !== 0)) {
  const lines = result.output.split('\n');
  const firstError = lines.findIndex((line) => /FAIL|Error|✗|×|not ok/.test(line));
  const from = firstError === -1 ? 0 : firstError;
  console.log(`\n----- first failure in ${result.tier} -----\n${lines.slice(from, from + 15).join('\n')}`);
}

const totalMs = Date.now() - runStartedAt;
const failed = results.filter((entry) => entry.code !== 0);
console.log(`\n${results.length - failed.length}/${results.length} tiers passed in ${(totalMs / 1000).toFixed(1)}s`);
if (failed.length > 0) console.log(`failed: ${failed.map((entry) => entry.tier).join(', ')} — full detail in ${detailPath}`);

writeFileSync(path.join(resultsDir, 'last-run.json'), JSON.stringify({
  runId,
  totalMs,
  tiers: Object.fromEntries(results.map((entry) => [entry.tier, { code: entry.code, ms: entry.ms }])),
}, null, 2) + '\n');

appendFileSync(ledgerPath, JSON.stringify({
  at: new Date().toISOString(),
  sha: gitOutput(['rev-parse', 'HEAD']),
  branch: gitOutput(['rev-parse', '--abbrev-ref', 'HEAD']),
  dirty: gitOutput(['status', '--porcelain']).length > 0,
  node: process.versions.node,
  bun: spawnSync('bun', ['--version'], { encoding: 'utf8' }).stdout?.trim() ?? '',
  cpus: availableParallelism(),
  memoryGb: Math.round(totalmem() / 1e9),
  jobs: process.env.OPENCHAMBER_TEST_JOBS ?? 'auto',
  vitestWorkers: process.env.OPENCHAMBER_VITEST_WORKERS ?? 'auto',
  totalMs,
  tiers: Object.fromEntries(results.map((entry) => [entry.tier, { code: entry.code, ms: entry.ms }])),
}) + '\n');

process.exit(failed.length > 0 ? 1 : 0);
