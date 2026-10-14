import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { execFile, fork } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loaderIdentity, observeForkStartup, startupTraceEnv } from '../../../../scripts/lib/vitest-startup-trace.mjs';

describe('focused runner startup tracing', () => {
  it('retains diagnostics by default and preserves inherited options without exposing values', () => {
    const env = { NODE_OPTIONS: '--import=https://secret:password@example.test/private --require=/private/key' };
    const enabled = startupTraceEnv(env);
    expect(enabled.PAPERCUSP_TEST_STARTUP_TRACE).toBe('1');
    expect(enabled.NODE_OPTIONS).toContain(env.NODE_OPTIONS);
    expect(enabled.NODE_OPTIONS).toContain('vitest-startup-trace.mjs');
    expect(startupTraceEnv(enabled).NODE_OPTIONS).toBe(enabled.NODE_OPTIONS);
    const disabled = { ...env, PAPERCUSP_TEST_STARTUP_TRACE: '0' };
    expect(startupTraceEnv(disabled)).toBe(disabled);
    const identity = loaderIdentity(env.NODE_OPTIONS);
    expect(identity.switches).toEqual(['--import', '--require']);
    expect(identity.sha256).toHaveLength(64);
    expect(JSON.stringify(identity)).not.toMatch(/secret|password|private|example/);
  });

  it('leaves ordinary inherited Node children and grandchildren output untouched', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-ordinary-child-'));
    const ordinary = join(dir, 'ordinary.cjs');
    const leaf = "process.stdout.write('abc'); process.stderr.write('xyz');";
    writeFileSync(ordinary, leaf);
    const branch = `const { spawnSync } = require('node:child_process');
      const child = spawnSync(process.execPath, ['-e', ${JSON.stringify(leaf)}], { encoding: 'utf8' });
      process.stdout.write(JSON.stringify({ stdout: child.stdout, stderr: child.stderr, status: child.status }));`;
    const root = `const { spawnSync } = require('node:child_process');
      const direct = spawnSync(process.execPath, [${JSON.stringify(ordinary)}], { encoding: 'utf8' });
      const branch = spawnSync(process.execPath, ['-e', ${JSON.stringify(branch)}], { encoding: 'utf8' });
      process.stdout.write(JSON.stringify({
        direct: { stdout: direct.stdout, stderr: direct.stderr, status: direct.status },
        nested: JSON.parse(branch.stdout), branchStderr: branch.stderr, branchStatus: branch.status,
      }));`;
    const env = startupTraceEnv({ ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: undefined });
    try {
      const { stdout, stderr } = await promisify(execFile)(process.execPath, ['-e', root], { env, timeout: 10_000 });
      expect(JSON.parse(stdout)).toEqual({
        direct: { stdout: 'abc', stderr: 'xyz', status: 0 },
        nested: { stdout: 'abc', stderr: 'xyz', status: 0 },
        branchStderr: '', branchStatus: 0,
      });
      expect(stderr).toContain('TEST_FILE_STARTUP_TRACE ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('captures the real preload and fork handshake without an opt-in switch', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-startup-preload-'));
    const worker = join(dir, 'vitest', 'dist', 'workers', 'forks.js');
    mkdirSync(join(dir, 'vitest', 'dist', 'workers'), { recursive: true });
    const parent = join(dir, 'parent.cjs');
    writeFileSync(worker, `process.on('message', message => {
      if (message.type === 'start') process.send({ type: 'started' });
      if (message.type === 'stop') process.send({ type: 'stopped' }, () => process.disconnect());
    });`);
    writeFileSync(parent, `const { fork } = require('node:child_process');
      const child = fork(${JSON.stringify(worker)}, { execArgv: [] });
      child.on('message', message => {
        if (message.type === 'started') child.send({ type: 'stop' });
      });
      child.send({ type: 'start', config: { secret: 'never-log' } });`);
    try {
      const env = startupTraceEnv({ ...process.env, PAPERCUSP_TEST_STARTUP_TRACE: undefined });
      const { stderr } = await promisify(execFile)(process.execPath, [parent], { env, timeout: 10_000 });
      const rows = stderr.split('\n').filter(line => line.startsWith('TEST_FILE_STARTUP_TRACE '))
        .map(line => JSON.parse(line.slice('TEST_FILE_STARTUP_TRACE '.length)));
      expect(rows.map(row => row.event)).toEqual(expect.arrayContaining([
        'node-loaded', 'worker-forked', 'start-sent', 'started-received',
        'stop-sent', 'stopped-received', 'worker-exit', 'worker-close',
      ]));
      const workerPid = rows.find(row => row.event === 'worker-forked')?.childPid;
      expect(rows.filter(row => row.event === 'node-loaded')).toHaveLength(2);
      expect(rows.some(row => row.event === 'node-loaded' && row.pid === workerPid)).toBe(true);
      expect(rows.find(row => row.event === 'started-received')).toMatchObject({ error: false });
      expect(stderr).not.toContain('never-log');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('observes the real start/started exchange without changing send semantics', () => {
    const child = new EventEmitter() as any;
    child.pid = 42;
    const calls: unknown[] = [];
    const rows: any[] = [];
    let clock = 100;
    const original = child.send = function(...args: unknown[]) { calls.push(args); return false; };
    observeForkStartup(child, row => rows.push(row), () => clock);
    const payload = { type: 'start', config: { secret: 'never-log' } };
    expect(child.send(payload, 'callback-placeholder')).toBe(false);
    clock = 279;
    child.emit('message', { type: 'rpc', secret: 'never-log' });
    child.emit('message', { type: 'started', error: null });
    child.emit('message', { type: 'started', error: null });
    child.emit('exit', 0, null);
    child.emit('close');
    expect(calls).toEqual([[payload, 'callback-placeholder']]);
    expect(rows.map(row => row.event)).toEqual(['start-sent', 'started-received', 'worker-exit', 'worker-close']);
    expect(rows[1]).toMatchObject({ childPid: 42, startupMs: 179, error: false });
    expect(rows.every(row => row.childPid === 42)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('never-log');
    expect(child.send).toBe(original);
    expect(child.listenerCount('message')).toBe(0);
    expect(child.listenerCount('exit')).toBe(0);
    expect(child.listenerCount('close')).toBe(0);
  });

  it('reports a worker exit before the handshake and cleans up idempotently', () => {
    const child = new EventEmitter() as any;
    child.pid = 43;
    child.send = () => true;
    const rows: any[] = [];
    const stop = observeForkStartup(child, row => rows.push(row), () => 0);
    child.emit('exit', 1, null);
    expect(rows).toEqual([{ event: 'worker-exit', childPid: 43, elapsedMs: 0, code: 1, signal: null, started: false }]);
    stop(); stop();
    expect(child.eventNames()).toEqual([]);
  });

  it('distinguishes an unacknowledged stop from an acknowledged stop awaiting process exit', () => {
    const child = new EventEmitter() as any;
    child.pid = 44;
    const payloads: unknown[] = [];
    const signals: unknown[] = [];
    const originalSend = child.send = (payload: unknown) => { payloads.push(payload); return false; };
    const originalKill = child.kill = (signal: unknown) => { signals.push(signal); return true; };
    const rows: any[] = [];
    let clock = 0;
    const detach = observeForkStartup(child, row => rows.push(row), () => clock);
    const payload = { type: 'stop', otelCarrier: { secret: 'never-log' } };
    expect(child.send(payload)).toBe(false);
    expect(rows.map(row => row.event)).toEqual(['stop-sent']);
    clock = 37;
    child.emit('message', { type: 'stopped', error: { secret: 'never-log' } });
    child.emit('message', { type: 'stopped' });
    expect(rows[1]).toMatchObject({ event: 'stopped-received', stopMs: 37, error: true });
    expect(rows.some(row => row.event === 'worker-exit')).toBe(false);
    expect(child.kill('SIGTERM')).toBe(true);
    expect(signals).toEqual(['SIGTERM']);
    expect(payloads).toEqual([payload]);
    expect(rows[2]).toMatchObject({ event: 'worker-signal', signal: 'SIGTERM', sent: true });
    expect(JSON.stringify(rows)).not.toContain('never-log');
    detach();
    expect(child.send).toBe(originalSend);
    expect(child.kill).toBe(originalKill);
    expect(child.eventNames()).toEqual([]);
  });

  it('keeps IPC and termination semantics when diagnostic output throws', () => {
    const child = new EventEmitter() as any;
    child.send = () => false;
    child.kill = () => true;
    const detach = observeForkStartup(child, () => { throw new Error('unavailable output'); });
    expect(child.send({ type: 'stop' })).toBe(false);
    expect(() => child.emit('message', { type: 'stopped' })).not.toThrow();
    expect(child.kill()).toBe(true);
    detach();
  });

  it('captures the stop acknowledgement, IPC disconnect, exit and close of a real fork', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vitest-lifecycle-'));
    const fixture = join(dir, 'worker.cjs');
    writeFileSync(fixture, `process.on('message', message => {
      if (message.type === 'stop') process.send({ type: 'stopped' }, () => process.disconnect());
    });`);
    const child = fork(fixture, { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [] });
    const rows: any[] = [];
    observeForkStartup(child, row => rows.push(row));
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('error', reject);
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)));
        child.send({ type: 'stop' });
      });
      expect(rows.map(row => row.event)).toEqual([
        'stop-sent', 'stopped-received', 'worker-disconnect', 'worker-exit', 'worker-close',
      ]);
      expect(rows[1]).toMatchObject({ error: false });
    } finally {
      if (child.exitCode === null) child.kill();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
