/** EI-25449368540823559: exercise teardown without rerunning security journeys. */
import { fork } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { captureIsolatedWorker, isolatedWorkerOptions, recordIsolatedIntegrationProof } from '../test/isolated-integration-proof';

const root = resolve(import.meta.dirname, '../../..');
const workerOptions = isolatedWorkerOptions(30_000);

it('stops real private PG and removes its runtime after an ordinary child exit', async context => {
  const runId = await recordIsolatedIntegrationProof({ root,
    filePath: 'packages/operator-core/lib/isolated-runtime-cleanup.integration.test.ts',
    sourcePaths: ['scripts/with-test-pg.mjs', 'scripts/test-files.mjs', 'scripts/lib/batch-watchdog.mjs',
      'packages/operator-core/test/isolated-integration-proof.ts', 'packages/operator-core/lib/process-identity.ts'],
    execute: async (observe, evidenceDir) => {
      await mkdir(join(evidenceDir, 'tmp'));
      const env: NodeJS.ProcessEnv = { ...process.env, PC_ISOLATED_RUNTIME_PROOF: '1', TMPDIR: join(evidenceDir, 'tmp') };
      delete env.PC_HEAVY_PREEMPT_READY_FILE;
      delete env.PC_HEAVY_PSI_FINALIZATION_FILE;
      const child = fork(join(root, 'scripts/with-test-pg.mjs'), [
        '--isolated-runtime', '--', process.execPath, '-e', "console.log('isolated-cleanup-control');",
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
