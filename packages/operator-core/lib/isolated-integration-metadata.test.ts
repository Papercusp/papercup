/** Cheap guard for the context API used by the expensive private-worker fixture. */
import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureIsolatedWorker, isolatedIntegrationCases } from '../test/isolated-integration-proof';

isolatedIntegrationCases('attaches per-case isolated runtime evidence after an async test (failing exit: %s)', async (failingExit, context) => {
  await Promise.resolve();
  const runId = failingExit ? '20261008T000001Z-100' : '20261008T000000Z-100';
  Object.assign(context.task.meta, { papercuspIsolatedRuntimeRunId: runId });
  expect(context.task.meta).toMatchObject({ papercuspIsolatedRuntimeRunId: runId });
});

it('retains output before a failing worker closes and preserves its actual exit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-capture-'));
  const child = spawn(process.execPath, ['-e', "console.log('original-before-failure'); setTimeout(() => process.exit(7), 100);"], { stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const result = captureIsolatedWorker(child, dir, { timeoutMs: 10_000 });
    await once(child.stdout!, 'data');
    expect(readFileSync(join(dir, 'worker.log'), 'utf8')).toContain('original-before-failure');
    expect(await result).toMatchObject({ code: 7, signal: null, timedOut: false, stdioDrainTimedOut: false });
    expect(JSON.parse(readFileSync(join(dir, 'worker-result.json'), 'utf8'))).toMatchObject({ code: 7, timedOut: false });
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

it('terminates a worker that ignores TERM and retains the timeout as failure evidence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-timeout-'));
  const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); console.log('original-hung-worker'); setInterval(() => {}, 1000);"], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exit = once(child, 'exit');
  try {
    const result = await captureIsolatedWorker(child, dir, { timeoutMs: 2_000, killGraceMs: 100 });
    await exit;
    expect(result).toMatchObject({ code: null, signal: 'SIGKILL', timedOut: true, stdioDrainTimedOut: false });
    expect(result.output).toContain('original-hung-worker');
    expect(JSON.parse(readFileSync(join(dir, 'worker-result.json'), 'utf8'))).toMatchObject({ signal: 'SIGKILL', timedOut: true });
    expect(() => process.kill(child.pid!, 0)).toThrow();
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

it('bounds drainage when an exited worker leaves a descendant holding its pipes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-pipe-'));
  const child = spawn(process.execPath, ['-e', "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 1, 2] }); console.log('descendant=' + c.pid); process.exit(0);"], { stdio: ['ignore', 'pipe', 'pipe'] });
  let descendant: number | undefined;
  try {
    const result = await captureIsolatedWorker(child, dir, { timeoutMs: 10_000, killGraceMs: 100 });
    descendant = Number(result.output.match(/descendant=(\d+)/)?.[1]);
    expect(descendant).toBeGreaterThan(0);
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: false, stdioDrainTimedOut: true });
    expect(JSON.parse(readFileSync(join(dir, 'worker-result.json'), 'utf8'))).toMatchObject({ stdioDrainTimedOut: true });
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* already gone */ } }
    child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true });
  }
});
