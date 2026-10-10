/** EI-25449368540823559: exercise teardown without rerunning security journeys. */
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';
import { browserCachePath } from '../../../scripts/ensure-playwright-browsers.mjs';
import { defaultEvidenceRoot } from '@papercusp/verification-harness';

const root = resolve(import.meta.dirname, '../../..');
const workerOptions = isolatedWorkerOptions(30_000);

it('pins plain-mode integration setup to its real private PG without injecting product URL overrides', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'private-admin-plain-'));
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: evidenceDir,
    PAPERCUSP_TEST_PG_ADMIN_URL: 'postgres://refused:refused@192.0.2.1:5432/shared' };
  delete env.HARNESS_ADMIN_DATABASE_URL;
  delete env.HARNESS_DATABASE_URL;
  delete env.PC_HEAVY_PREEMPT_READY_FILE;
  delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
  const child = fork(join(root, 'scripts/with-test-pg.mjs'), [
    '--', process.execPath, '-e', `
      const assert = require('node:assert/strict');
      const postgres = require('postgres');
      (async () => {
        assert.equal(process.env.HARNESS_ADMIN_DATABASE_URL, undefined);
        assert.equal(process.env.HARNESS_DATABASE_URL, undefined);
        const url = new URL(process.env.PAPERCUSP_TEST_PG_ADMIN_URL);
        assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
        assert.equal(url.port, process.env.PAPERCUSP_PG_PORT);
        const sql = postgres(url.toString(), { max: 1 });
        try {
          const [row] = await sql\`SELECT inet_server_port() AS port, current_user AS role\`;
          assert.equal(String(row.port), process.env.PAPERCUSP_PG_PORT);
          assert.equal(row.role, 'harness_admin');
          const [sockets] = await sql\`SHOW unix_socket_directories\`;
          assert.equal(sockets.unix_socket_directories, '');
          console.log('plain-private-admin-control');
        } finally { await sql.end(); }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `,
  ], { cwd: root, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
    expect(result, result.output.slice(-8000)).toMatchObject({ code: 0, signal: null, timedOut: false,
      exitWaitTimedOut: false, stdioDrainTimedOut: false });
    expect(result.output).toContain('plain-private-admin-control');
    const dataDir = result.output.match(/\(datadir (.+)\)/)?.[1];
    expect(dataDir).toBeDefined();
    expect(existsSync(dataDir!)).toBe(false);
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
}, workerOptions.testTimeoutMs);

it('returns failure and tears down private PG when an executable passes preflight but its interpreter is missing', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'private-pg-late-spawn-'));
  const command = join(evidenceDir, 'missing-interpreter-command');
  await writeFile(command, `#!${join(evidenceDir, 'absent-interpreter')}\n`, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: evidenceDir };
  delete env.PC_HEAVY_PREEMPT_READY_FILE;
  delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
  const child = fork(join(root, 'scripts/with-test-pg.mjs'), ['--', command], {
    cwd: root, detached: true, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    const result = await captureIsolatedWorker(child, evidenceDir, { timeoutMs: 120_000, killGraceMs: 45_000 });
    expect(result, result.output.slice(-8000)).toMatchObject({ code: 1, signal: null, timedOut: false,
      exitWaitTimedOut: false, stdioDrainTimedOut: false });
    expect(result.output).toContain('[with-test-pg] ready');
    expect(result.output).toContain('child failed to start');
    expect(result.output).not.toContain('child preflight failed');
    expect(result.output).toContain('database system is shut down');
    const dataDir = result.output.match(/\(datadir (.+)\)/)?.[1];
    expect(dataDir).toBeDefined();
    expect(existsSync(dataDir!)).toBe(false);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
}, 180_000);

it('stops real private PG and removes its runtime after an ordinary child exit', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/isolated-runtime-cleanup.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'scripts/test-files.mjs', 'scripts/lib/batch-watchdog.mjs',
      'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/process-identity.ts',
      'libs/generic/verification-harness/src/evidence-root.ts'],
    execute: async (observe, evidenceDir) => {
      await mkdir(join(evidenceDir, 'tmp'));
      const evidenceEnv = {
        PAPERCUSP_TEST_RUNS_DB_URL: 'postgresql://reporter-only:fixture@127.0.0.1:1/ledger',
        PAPERCUSP_TEST_RUN_RECEIPT_FILE: join(evidenceDir, 'reporter-receipts.jsonl'),
        PAPERCUSP_TEST_RUN_WORKSPACE: 'ledger-workspace',
        PAPERCUSP_TEST_RUN_HARNESS: 'ledger-harness',
        PAPERCUSP_TEST_RUN_GROUP: 'ledger-group',
        PAPERCUSP_TEST_RUN_SOURCE: 'mutation-probe',
        PAPERCUSP_TEST_RUN_COMMIT: 'abcdef123456',
        PAPERCUSP_TEST_RUN_CASE_TITLE_PATTERN: 'isolated-ledger-control',
      };
      const env: NodeJS.ProcessEnv = { ...process.env, ...evidenceEnv,
        PC_ISOLATED_RUNTIME_PROOF: '1', TMPDIR: join(evidenceDir, 'tmp'),
        PAPERCUSP_SUBSTRATE_IPC_SOCKET: '/tmp/forbidden-live-product-socket',
        PAPERCUSP_TEST_RUN_UNREGISTERED_ENDPOINT: 'http://127.0.0.1:1/forbidden',
        OPENAI_API_KEY: 'fixture-must-not-reach-private-runtime' };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const expectedBrowserCache = browserCachePath(env);
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), [
        '--isolated-runtime', '--', process.execPath, '--import', 'tsx', '-e', `
          const assert = require('node:assert/strict');
          const postgres = require('postgres');
          (async () => {
            for (const [key, expected] of Object.entries(${JSON.stringify(evidenceEnv)})) {
              assert.equal(process.env[key], expected, 'isolated reporter setting: ' + key);
            }
            assert.equal(process.env.PAPERCUSP_SUBSTRATE_IPC_SOCKET, undefined);
            assert.equal(process.env.PAPERCUSP_TEST_RUN_UNREGISTERED_ENDPOINT, undefined);
            assert.equal(process.env.OPENAI_API_KEY, undefined);
            assert.notEqual(process.env.PAPERCUSP_WORKSPACE_ID, process.env.PAPERCUSP_TEST_RUN_WORKSPACE);
            assert.notEqual(process.env.HARNESS_ADMIN_DATABASE_URL, process.env.PAPERCUSP_TEST_RUNS_DB_URL);
            console.log('isolated-reporter-env-control');
            const { defaultEvidenceRoot, runHarness } = await import('@papercusp/verification-harness');
            const artifactRoot = defaultEvidenceRoot('isolated-integration');
            const proof = await runHarness({
              contract: { name: 'isolated-integration', phases: [{ id: 'retention-control' }] },
              evidenceRoot: artifactRoot,
              runPhase: async () => ({ ok: true }),
            });
            console.log('ISOLATED_RETAINED_ARTIFACT ' + JSON.stringify({
              root: artifactRoot, runId: proof.runId, home: process.env.HOME,
              state: process.env.XDG_STATE_HOME,
            }));
            const { chromium } = require('playwright-core');
            const path = require('node:path');
            assert.equal(process.env.PLAYWRIGHT_BROWSERS_PATH, ${JSON.stringify(expectedBrowserCache)});
            const browserPath = chromium.executablePath();
            assert.ok(browserPath.startsWith(process.env.PLAYWRIGHT_BROWSERS_PATH + path.sep), browserPath);
            assert.ok(!browserPath.startsWith(process.env.XDG_CACHE_HOME + path.sep), browserPath);
            const adminUrl = new URL(process.env.PAPERCUSP_TEST_PG_ADMIN_URL);
            assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname));
            assert.equal(adminUrl.port, process.env.PAPERCUSP_PG_PORT);
            assert.equal(adminUrl.toString(), new URL(process.env.HARNESS_ADMIN_DATABASE_URL).toString());
            const sql = postgres(adminUrl.toString(), { max: 1 });
            try {
              const [row] = await sql\`SELECT inet_server_port() AS port, current_user AS role\`;
              assert.equal(String(row.port), process.env.PAPERCUSP_PG_PORT);
              assert.equal(row.role, 'harness_admin');
              const [sockets] = await sql\`SHOW unix_socket_directories\`;
              assert.equal(sockets.unix_socket_directories, '');
              console.log('private-integration-admin-control');
            } finally { await sql.end(); }
            console.log('isolated-cleanup-control');
          })().catch(error => { console.error(error); process.exitCode = 1; });
        `,
      ], { cwd: root, detached: true, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      observe(child);
      const stages: string[] = [];
      child.on('message', message => {
        if (message && typeof message === 'object' && 'kind' in message && message.kind === 'isolated-runtime-cleanup' && 'stage' in message) {
          stages.push(String(message.stage));
        }
      });
      const result = await captureIsolatedWorker(child, evidenceDir, workerOptions);
      expect(result, result.output.slice(-8000)).toMatchObject({ code: 0, signal: null, timedOut: false,
        exitWaitTimedOut: false, stdioDrainTimedOut: false });
      expect(result.output).toContain('isolated-cleanup-control');
      expect(result.output).toContain('private-integration-admin-control');
      expect(result.output).toContain('isolated-reporter-env-control');
      const artifactLine = result.output.split('\n').find(line => line.startsWith('ISOLATED_RETAINED_ARTIFACT '));
      expect(artifactLine, result.output.slice(-4000)).toBeTruthy();
      const artifact = JSON.parse(artifactLine!.slice('ISOLATED_RETAINED_ARTIFACT '.length));
      expect(existsSync(artifact.home)).toBe(false);
      expect(artifact.root, JSON.stringify(artifact)).toBe(defaultEvidenceRoot('isolated-integration'));
      expect(JSON.parse(readFileSync(join(artifact.root, artifact.runId, 'result.json'), 'utf8')).verdict).toBe('pass');
      expect(artifact.state).toBeDefined();
      expect(existsSync(artifact.state)).toBe(false);
      expect(stages).toEqual(expect.arrayContaining(['start', 'pg-stop', 'pg-stopped', 'remove-private-state', 'complete']));
    },
  });
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  console.info('ISOLATED_CLEANUP_PREFLIGHT_PROOF_RUN ' + runId);
}, workerOptions.testTimeoutMs);

it('cleans owned state when cancelled during real initdb before runtime-start', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'isolated-bootstrap-cancel-'));
  const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', TMPDIR: evidenceDir };
  delete env.PC_HEAVY_PREEMPT_READY_FILE;
  delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
  const child = fork(join(root, 'scripts/with-test-pg.mjs'), [
    '--isolated-runtime', '--', process.execPath, '-e', "throw new Error('cancelled bootstrap launched its child');",
  ], { cwd: root, detached: true, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let cancelled = false;
  let dataDir: string | undefined;
  const messages: Array<Record<string, unknown>> = [];
  child.on('message', value => { if (value && typeof value === 'object') messages.push(value as Record<string, unknown>); });
  child.stdout!.on('data', chunk => {
    const output = String(chunk);
    dataDir ??= output.match(/\(datadir (.+)\)/)?.[1];
    if (!cancelled && output.includes('syncing data to disk')) {
      cancelled = true;
      // This fork owns the group from birth, including initdb; no host process
      // or shared database participates in the cancellation.
      process.kill(-child.pid!, 'SIGTERM');
    }
  });
  try {
    const result = await captureIsolatedWorker(child, evidenceDir, { timeoutMs: 120_000, killGraceMs: 45_000 });
    expect(cancelled).toBe(true);
    expect(result).toMatchObject({ code: 143, signal: null, timedOut: false, stdioDrainTimedOut: false });
    expect(messages.some(message => message.kind === 'isolated-runtime-start')).toBe(false);
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'isolated-runtime-cleanup', stage: 'complete', runtimeRemoved: true, pgDataRemoved: true }),
    ]));
    expect(dataDir).toBeDefined();
    expect(existsSync(dataDir!)).toBe(false);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      process.kill(-child.pid!, 'SIGKILL');
      await exited;
    }
    await rm(evidenceDir, { recursive: true, force: true });
  }
}, 180_000);

it.each(['SIGINT', 'SIGTERM'] as const)('waits for cleanup on %s when the supervisor shares its caller process group', async signal => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'isolated-shared-group-cancel-'));
  const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', TMPDIR: evidenceDir };
  delete env.PC_HEAVY_PREEMPT_READY_FILE;
  delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
  const child = fork(join(root, 'scripts/with-test-pg.mjs'), [
    '--isolated-runtime', '--', process.execPath, '-e', 'setInterval(() => {}, 1000);',
  ], { cwd: root, detached: false, execArgv: [], env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const messages: Array<Record<string, unknown>> = [];
  let runtimeRoot: string | undefined;
  let dataDir: string | undefined;
  let workerPid: number | undefined;
  child.on('message', value => {
    if (!value || typeof value !== 'object') return;
    const message = value as Record<string, unknown>;
    messages.push(message);
    if (message.kind === 'isolated-runtime-start') {
      runtimeRoot = String(message.runtimeRoot);
      dataDir = String(message.dataDir);
      workerPid = Number(message.childPid);
      // Signal only this supervisor. Its caller's group must remain untouched.
      child.kill(signal);
    }
  });
  try {
    const result = await captureIsolatedWorker(child, evidenceDir, { timeoutMs: 120_000, killGraceMs: 45_000 });
    expect(result, result.output.slice(-8000)).toMatchObject({ code: null, signal, timedOut: false,
      exitWaitTimedOut: false, stdioDrainTimedOut: false });
    expect(messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'isolated-runtime-cleanup', stage: 'complete', runtimeRemoved: true, pgDataRemoved: true }),
    ]));
    expect(runtimeRoot).toBeDefined();
    expect(dataDir).toBeDefined();
    expect(existsSync(runtimeRoot!)).toBe(false);
    expect(existsSync(dataDir!)).toBe(false);
    expect(() => process.kill(workerPid!, 0)).toThrow();
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
    // A failed negative control can leave its private PG alive. Its pid file
    // must still name this exact fixture before cleanup may signal it.
    if (dataDir && existsSync(join(dataDir, 'postmaster.pid'))) {
      const [pid, ownedDir] = readFileSync(join(dataDir, 'postmaster.pid'), 'utf8').split('\n');
      if (ownedDir === dataDir) {
        try { process.kill(Number(pid), 'SIGINT'); } catch { /* already stopped */ }
        for (let n = 0; n < 100 && existsSync(join(dataDir, 'postmaster.pid')); n++) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
      }
    }
    await rm(evidenceDir, { recursive: true, force: true });
  }
}, 180_000);
