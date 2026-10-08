/** Cheap guard for the context API used by the expensive private-worker fixture. */
import { expect, it, vi } from 'vitest';
import { ChildProcess, fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { captureIsolatedWorker, isolatedIntegrationCases, isolatedTestFileWorkerOptions } from '../test/isolated-integration-proof';

it('pins the original short-lived Node worker before allowing its command to run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-start-'));
  const child = spawn(process.execPath, ['--import', join(import.meta.dirname, '../../../scripts/lib/isolated-runtime-start.mjs'),
    '-e', "console.log('command-after-observation'); process.exit(7);"], {
    env: { ...process.env, PC_ISOLATED_RUNTIME_START_TOKEN: 'original-token' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    const captured = captureIsolatedWorker(child, dir, { timeoutMs: 10_000 });
    expect((await once(child, 'message'))[0]).toEqual({ kind: 'isolated-worker-ready', token: 'original-token' });
    const stat = readFileSync(`/proc/${child.pid}/stat`, 'utf8');
    child.send({ kind: 'isolated-worker-observed', token: 'wrong-token', accepted: true });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(readFileSync(join(dir, 'worker.log'), 'utf8')).toBe('');
    expect(readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(')').slice(1).join(')').trim().split(/\s+/)[19])
      .toBe(stat.split(')').slice(1).join(')').trim().split(/\s+/)[19]);
    child.send({ kind: 'isolated-worker-observed', token: 'original-token', accepted: true });
    const result = await captured;
    expect(result).toMatchObject({ code: 7, timedOut: false });
    expect(result.output).toContain('command-after-observation');
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

it('refuses to run command code when the original observer disconnects', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-unobserved-'));
  const child = spawn(process.execPath, ['--import', join(import.meta.dirname, '../../../scripts/lib/isolated-runtime-start.mjs'),
    '-e', "console.log('unobserved-command-ran');"], {
    env: { ...process.env, PC_ISOLATED_RUNTIME_START_TOKEN: 'original-token' }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  try {
    const captured = captureIsolatedWorker(child, dir, { timeoutMs: 10_000 });
    await once(child, 'message');
    child.disconnect();
    const result = await captured;
    expect(result).toMatchObject({ code: 1, timedOut: false });
    expect(result.output).toContain('original worker observer disconnected');
    expect(result.output).not.toContain('unobserved-command-ran');
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

it('composes the nested router budgets without spending execution time on bootstrap', () => {
  const options = isolatedTestFileWorkerOptions({ PAPERCUSP_TEST_FILE_TIMEOUT_MS: '900000', PAPERCUSP_TEST_FILE_LIST_TIMEOUT_MS: '180000' }, 2);
  expect(options.phaseTimeouts).toMatchObject({ bootstrapMs: 180_000, executeMs: 1_082_000 });
  expect(options.phaseTimeouts.bootstrapMaxMs).toBe(900_000);
  expect(options.killGraceMs).toBeGreaterThanOrEqual(10_000 + 5_000);
  expect(options.testTimeoutMs).toBeGreaterThan(options.phaseTimeouts.bootstrapMs + options.phaseTimeouts.executeMaxMs! + options.phaseTimeouts.teardownMs);
});

it('gives each lifecycle phase its own budget and refuses deadline renewal by repeated IPC', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-phases-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 200, teardownMs: 150 }, killGraceMs: 50 });
    await vi.advanceTimersByTimeAsync(90);
    child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(190);
    expect(kill).not.toHaveBeenCalled();
    child.emit('message', { kind: 'isolated-runtime-stopping' });
    await vi.advanceTimersByTimeAsync(140);
    child.emit('message', { kind: 'isolated-runtime-stopping' });
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'teardown', stdioDrainTimedOut: false });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('bounds a missing runtime-start and cannot extend it with unrelated IPC', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-bootstrap-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 200, teardownMs: 150 }, killGraceMs: 50 });
    await vi.advanceTimersByTimeAsync(90); child.emit('message', { kind: 'other' });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(50);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    Object.assign(child, { signalCode: 'SIGKILL' }); child.emit('exit', null, 'SIGKILL'); child.emit('close', null, 'SIGKILL');
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap', signal: 'SIGKILL' });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('allows actual TERM cleanup to finish before its declared grace and preserves timeout failure', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-grace-'));
  const child = fork('-e', ["process.on('SIGTERM', () => setTimeout(() => { console.log('cleanup-finished'); process.exit(0); }, 200)); process.send({kind:'isolated-runtime-start'}); setInterval(() => {},1000);"], { execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  try {
    const result = await captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 10_000, executeMs: 100, teardownMs: 1000 }, killGraceMs: 1000 });
    expect(result).toMatchObject({ code: 0, signal: null, timedOut: true, timeoutPhase: 'execute', stdioDrainTimedOut: false });
    expect(result.output).toContain('cleanup-finished');
    expect(JSON.parse(readFileSync(join(dir, 'worker-result.json'), 'utf8'))).toMatchObject({ timedOut: true, timeoutPhase: 'execute' });
  } finally { child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true }); }
});

it('extends progressing bootstrap stages and refuses renewal by noise or repeated stages', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-boot-progress-'));
  const child = new ChildProcess();
  const stdout = new PassThrough(); Object.assign(child, { stdout });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: {
      bootstrapMs: 100, bootstrapMaxMs: 300, executeMs: 100, teardownMs: 100,
    }, killGraceMs: 50 });
    await vi.advanceTimersByTimeAsync(90);
    child.emit('message', { kind: 'isolated-runtime-bootstrap-progress', stage: 'migration:000-baseline.sql' });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(90);
    stdout.write('noisy NOTICE is not stage progress');
    child.emit('message', { kind: 'isolated-runtime-bootstrap-progress', stage: 'migration:000-baseline.sql' });
    child.emit('message', { kind: 'isolated-runtime-bootstrap-progress', stage: 'invented' });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap' });
  } finally { stdout.destroy(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('enforces the absolute bootstrap ceiling despite distinct continuing stages', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-boot-ceiling-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: {
      bootstrapMs: 100, bootstrapMaxMs: 300, executeMs: 100, teardownMs: 100,
    }, killGraceMs: 50 });
    for (const stage of ['initdb', 'postmaster', 'database']) {
      await vi.advanceTimersByTimeAsync(90);
      child.emit('message', { kind: 'isolated-runtime-bootstrap-progress', stage });
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'bootstrap' });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('waits for observed kernel exit before starting the shorter pipe-drain budget', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-exit-race-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  let settled = false;
  try {
    const captured = captureIsolatedWorker(child, dir, { timeoutMs: 100, killGraceMs: 50, drainGraceMs: 20 }).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(150);
    expect(kill).toHaveBeenCalledWith('SIGKILL');
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    Object.assign(child, { signalCode: 'SIGKILL' }); child.emit('exit', null, 'SIGKILL'); child.emit('close', null, 'SIGKILL');
    expect(await captured).toMatchObject({ signal: 'SIGKILL', exitWaitTimedOut: false, stdioDrainTimedOut: false });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('cannot renew the execution deadline by repeating runtime-start', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-execution-'));
  const child = new ChildProcess();
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 200, teardownMs: 100 }, killGraceMs: 50 });
    child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(190); child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'execute' });
  } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

it('uses the router progress watchdog and still enforces its absolute ceiling', async () => {
  vi.useFakeTimers();
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-progress-'));
  const child = new ChildProcess();
  const stdout = new PassThrough(); Object.assign(child, { stdout });
  const kill = vi.spyOn(child, 'kill').mockReturnValue(true);
  try {
    const captured = captureIsolatedWorker(child, dir, { phaseTimeouts: { bootstrapMs: 100, executeMs: 200, executeMaxMs: 400, teardownMs: 100 }, killGraceMs: 50 });
    child.emit('message', { kind: 'isolated-runtime-start' });
    await vi.advanceTimersByTimeAsync(190); stdout.write('original-progress\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(190); stdout.write('still-progressing\n');
    await vi.advanceTimersByTimeAsync(10);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
    Object.assign(child, { exitCode: 1 }); child.emit('exit', 1, null); child.emit('close', 1, null);
    expect(await captured).toMatchObject({ timedOut: true, timeoutPhase: 'execute' });
  } finally { stdout.destroy(); vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }); }
});

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

it('kills a TERM-ignoring worker and its owned descendant together', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'isolated-worker-group-'));
  const source = "const {fork}=require('node:child_process'); process.on('SIGTERM',()=>{}); const d=fork('-e',[\"process.on('SIGTERM',()=>{}); process.send({ready:true}); setInterval(()=>{},1000);\"],{execArgv:[],stdio:['ignore',1,2,'ipc']}); d.on('message',()=>{console.log('descendant='+d.pid); process.send({kind:'isolated-runtime-start'});}); setInterval(()=>{},1000);";
  const child = fork('-e', [source], { detached: true, execArgv: [], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let descendant: number | undefined;
  try {
    const result = await captureIsolatedWorker(child, dir, {
      phaseTimeouts: { bootstrapMs: 10_000, executeMs: 100, teardownMs: 1000 }, killGraceMs: 100,
    });
    descendant = Number(result.output.match(/descendant=(\d+)/)?.[1]);
    expect(descendant).toBeGreaterThan(0);
    expect(result).toMatchObject({ signal: 'SIGKILL', timedOut: true, timeoutPhase: 'execute', stdioDrainTimedOut: false });
    // An orphan may await the host reaper as a zombie; it has exited and cannot
    // keep PG, pipes or private files active. A live descendant fails this guard.
    await expect.poll(() => {
      try {
        const stat = readFileSync(`/proc/${descendant}/stat`, 'utf8');
        return stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/)[0] === 'Z';
      } catch { return true; }
    }, { timeout: 5000 }).toBe(true);
    expect(() => process.kill(child.pid!, 0)).toThrow();
  } finally {
    if (descendant) { try { process.kill(descendant, 'SIGKILL'); } catch { /* already exited */ } }
    child.kill('SIGKILL'); rmSync(dir, { recursive: true, force: true });
  }
});
