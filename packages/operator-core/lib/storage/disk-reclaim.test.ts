import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { compilePolicy, type RetentionClass } from './retention-policy';
import { nativeRetentionCommand, scanRetentionHolders, selectRetentionEntries, type RetentionEntry } from './disk-reclaim';

const delegateSpawn = vi.hoisted(() => vi.fn());
vi.mock('../task-manager/managed-spawn', () => ({ managedSpawn: delegateSpawn }));

const HOUR = 3_600_000;
const now = 1000 * HOUR;
const policy: RetentionClass[] = [
  { id: 'scratch', title: 'scratch', origin: 'agent', roots: ['/scratch'], keep: { kind: 'max-age', maxAgeHours: 24 }, enforcers: [{ kind: 'standing-reclaim' }] },
  { id: 'dumps', title: 'dumps', origin: 'agent', roots: ['/dumps'], keep: { kind: 'newest', keep: 1 }, enforcers: [{ kind: 'standing-reclaim' }] },
  { id: 'protected', title: 'protected', origin: 'owner', roots: ['/scratch/owner'], keep: { kind: 'keep', reason: 'owner data' }, enforcers: [{ kind: 'none' }] },
  { id: 'leased', title: 'leased', origin: 'agent', roots: ['/leased'], keep: { kind: 'lease', record: 'live session', graceHours: 1 }, enforcers: [{ kind: 'standing-reclaim', via: 'owning-program' }] },
];
const compiled = compilePolicy(policy, '/home/test');
const entry = (path: string, classId: string, ageHours: number): RetentionEntry => ({ path, root: path.slice(0, path.lastIndexOf('/')), classId, newestWriteMs: now - ageHours * HOUR, bytes: 100, dev: 1, ino: 1 });

describe('scheduled retention selection', () => {
  it('expires only stale entries, oldest first, without a disk-pressure input', () => {
    const selected = selectRetentionEntries([entry('/scratch/new', 'scratch', 1), entry('/scratch/old', 'scratch', 25), entry('/scratch/older', 'scratch', 48)], compiled, now);
    expect(selected.map((e) => e.path)).toEqual(['/scratch/older', '/scratch/old']);
  });
  it('keeps the newest backup per root even when the entire group is old', () => {
    expect(selectRetentionEntries([entry('/dumps/newest', 'dumps', 90), entry('/dumps/old', 'dumps', 100)], compiled, now).map((e) => e.path)).toEqual(['/dumps/old']);
  });
  it('never selects an owner subtree, root, unmatched path or lease from age alone', () => {
    expect(selectRetentionEntries([entry('/scratch/owner/data', 'scratch', 90), entry('/scratch', 'scratch', 90), entry('/other/file', 'scratch', 90), entry('/leased/run', 'leased', 90)], compiled, now)).toEqual([]);
  });
  it('fails closed when the declared class differs from the authoritative selector', () => {
    expect(selectRetentionEntries([entry('/dumps/old', 'scratch', 90)], compiled, now)).toEqual([]);
  });
});

describe('retention holder evidence', () => {
  afterEach(() => { delegateSpawn.mockReset(); });

  it('passes a duration to the existing privileged scanner and requires the caller control', async () => {
    const scan = vi.fn().mockResolvedValue({ complete: true, byPath: new Map([[process.cwd(), [String(process.pid)]], ['/scratch/held', ['123']]]) });
    const result = await scanRetentionHolders(['/scratch/held'], {
      uid: () => 0, readStatus: async () => `NSpid:\t${process.pid}\n`, scan,
    });
    expect(scan).toHaveBeenCalledWith(['/scratch/held', process.cwd()], {
      descendants: true, includeCwd: true, failClosed: true, deadlineMs: 30_000,
    });
    expect(result.complete).toBe(true);
    expect(result.byPath.get('/scratch/held')).toEqual(['123']);
    scan.mockResolvedValueOnce({ complete: true, byPath: new Map() });
    expect((await scanRetentionHolders([], { uid: () => 0, readStatus: async () => 'NSpid:\t1\n', scan })).complete).toBe(false);
  });

  it('uses host-readable evidence for an ordinary operator while preserving live holders', async () => {
    const privileged = vi.fn().mockResolvedValue({ complete: true, byPath: new Map([[process.cwd(), [String(process.pid)]], ['/scratch/held', ['999']]]) });
    const scan = vi.fn();
    const result = await scanRetentionHolders(['/scratch/held'], {
      uid: () => 1000, readStatus: async () => 'NSpid:\t1\n', scan, privileged,
    });
    expect(scan).not.toHaveBeenCalled();
    expect(privileged).toHaveBeenCalledWith(['/scratch/held', process.cwd()], process.cwd());
    expect(result).toEqual({ complete: true, byPath: new Map([[process.cwd(), [String(process.pid)]], ['/scratch/held', ['999']]]) });
  });

  it('preserves full JSON stdout separately from scope diagnostics and refuses truncated evidence', async () => {
    const holderPids = Array.from({ length: 1000 }, (_, i) => String(i + 1));
    const byPath = [[process.cwd(), [String(process.pid)]], ['/scratch', holderPids]];
    const deps = { uid: () => 1000, readStatus: async () => 'NSpid:\t1\n' };
    const launch = (output: string) => delegateSpawn.mockImplementationOnce(async (_command, _args, spec, options) => {
      expect(spec.runtimeMaxSec).toBe(31);
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      options.onSpawn(child as unknown as ChildProcess, 'holder-read-task');
      child.stderr.write('Running as unit: holder-read-task.scope\n');
      child.stdout.write(output); child.emit('close', 0, null);
      return { child, taskId: 'holder-read-task' };
    });
    launch(JSON.stringify({ complete: true, byPath }));
    const result = await scanRetentionHolders(['/scratch'], deps);
    expect(result.complete).toBe(true);
    expect(result.byPath.get('/scratch')).toEqual(holderPids);
    launch(' '.repeat(1024 * 1024) + JSON.stringify({ complete: true, byPath }));
    expect((await scanRetentionHolders(['/scratch'], deps)).complete).toBe(false);
  });

  it('refuses missing privilege, partial evidence and nested PID namespaces', async () => {
    const privileged = vi.fn().mockRejectedValue(new Error('sudo denied'));
    const deps = { uid: () => 1000, readStatus: async () => 'NSpid:\t1\n', privileged };
    expect((await scanRetentionHolders(['/scratch'], deps)).complete).toBe(false);
    privileged.mockResolvedValueOnce({ complete: false, byPath: new Map([[process.cwd(), [String(process.pid)]]]) });
    expect((await scanRetentionHolders(['/scratch'], deps)).complete).toBe(false);
    privileged.mockClear();
    expect((await scanRetentionHolders(['/scratch'], { ...deps, readStatus: async () => 'NSpid:\t1\t2\n' })).complete).toBe(false);
    expect(privileged).not.toHaveBeenCalled();
  });

  it('retains scanner failure metrics across the privileged transport', async () => {
    const diagnostics = { elapsedMs: 12, processesTotal: 10, processesScanned: 9, descriptorsScanned: 40,
      deadlineExceeded: false, readFailures: 1, failureSamples: [{ operation: 'fd-directory', path: '/proc/5/fd', code: 'EACCES' }] };
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'incomplete-holder-task');
      child.stdout.write(JSON.stringify({ complete: false, byPath: [[process.cwd(), [String(process.pid)]]], diagnostics }));
      child.emit('close', 0, null); return { child, taskId: 'incomplete-holder-task' };
    });
    const result = await scanRetentionHolders(['/scratch'], { uid: () => 1000, readStatus: async () => 'NSpid:\t1\n' });
    expect(result.complete).toBe(false);
    expect(result.diagnostics).toEqual(diagnostics);
  });

  it('retains bounded stderr, task identity and signal when privilege transport fails', async () => {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'denied-holder-task');
      child.stderr.write('x'.repeat(5000) + 'sudo: permission denied');
      child.emit('close', null, 'SIGTERM'); return { child, taskId: 'denied-holder-task' };
    });
    const result = await scanRetentionHolders(['/scratch'], { uid: () => 1000, readStatus: async () => 'NSpid:\t1\n' });
    expect(result.complete).toBe(false);
    expect(result.diagnostics).toMatchObject({ taskId: 'denied-holder-task', exitCode: null, signal: 'SIGTERM', outputTruncated: false });
    expect(result.diagnostics?.stderr).toHaveLength(4000);
    expect(result.diagnostics?.stderr).toContain('sudo: permission denied');
  });

  it.each(['not-json', JSON.stringify({ complete: true, byPath: [] }), JSON.stringify({ complete: true, byPath: [['/foreign', ['1']]] })])(
    'rejects privileged output without valid, caller-controlled evidence: %s', async (output) => {
      const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
      delegateSpawn.mockImplementationOnce(async (command, args, _spec, options) => {
        expect(command).toBe('/usr/bin/sudo');
        expect(args.slice(0, 2)).toEqual(['-n', process.execPath]);
        options.onSpawn(child as unknown as ChildProcess, 'holder-read-task');
        child.stdout.write(output); child.emit('close', 0, null);
        return { child, taskId: 'holder-read-task' };
      });
      expect((await scanRetentionHolders(['/scratch'], { uid: () => 1000, readStatus: async () => 'NSpid:\t1\n' })).complete).toBe(false);
    },
  );

  it('streams oversized candidate sets without placing the payload in argv', async () => {
    const paths = Array.from({ length: 14_000 }, (_, i) => `/scratch/expired-${i}`);
    const chunks: Buffer[] = [];
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn() });
    child.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    delegateSpawn.mockImplementationOnce(async (command, args, _spec, options) => {
      expect(command).toBe('/usr/bin/sudo');
      expect(args.every((arg: string) => Buffer.byteLength(arg) < 128 * 1024)).toBe(true);
      expect(options.spawnOptions.stdio[0]).toBe('pipe');
      options.onSpawn(child as unknown as ChildProcess, 'large-holder-task');
      child.stdout.write(JSON.stringify({ complete: true, byPath: [[process.cwd(), [String(process.pid)]]] }));
      child.emit('close', 0, null);
      return { child, taskId: 'large-holder-task' };
    });
    const result = await scanRetentionHolders(paths, { uid: () => 1000, readStatus: async () => 'NSpid:\t1\n' });
    expect(result.complete).toBe(true);
    const input = Buffer.concat(chunks).toString('utf8');
    expect(Buffer.byteLength(input)).toBeGreaterThan(128 * 1024);
    expect(JSON.parse(input)).toEqual([...paths, process.cwd()]);
  });
});

describe('native retention completion', () => {
  afterEach(() => { vi.useRealTimers(); delegateSpawn.mockReset(); });

  it.each([0, 2])('preserves output and exit %s before the launch promise resolves', async (code) => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    });
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'fast-retention-task');
      child.stdout.write('retention receipt');
      child.emit('close', code, null);
      await Promise.resolve();
      return { child, taskId: 'fast-retention-task' };
    });
    await expect(nativeRetentionCommand('/repo', 'true', [])).resolves.toEqual({
      ok: code === 0, detail: { code, signal: null, taskId: 'fast-retention-task', output: 'retention receipt' },
    });
  });

  it('reports a spawn error emitted before launch bookkeeping returns', async () => {
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: vi.fn() });
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'failed-retention-task');
      child.emit('error', new Error('fixture exec denied'));
      return { child, taskId: 'failed-retention-task' };
    });
    await expect(nativeRetentionCommand('/repo', 'false', [])).resolves.toEqual({
      ok: false, detail: { error: 'fixture exec denied', taskId: 'failed-retention-task', output: '' },
    });
  });

  it('times out a running child once and keeps the timeout verdict when kill emits close', async () => {
    vi.useFakeTimers();
    let observed!: () => void;
    const ready = new Promise<void>((resolve) => { observed = resolve; });
    const child = Object.assign(new EventEmitter(), { stdout: null, stderr: null, kill: vi.fn() });
    child.kill.mockImplementation(() => { child.emit('close', null, 'SIGKILL'); });
    delegateSpawn.mockImplementationOnce(async (_command, _args, _spec, options) => {
      options.onSpawn(child as unknown as ChildProcess, 'slow-retention-task');
      observed();
      return { child, taskId: 'slow-retention-task' };
    });
    const result = nativeRetentionCommand('/repo', 'sleep', ['300']);
    await ready;
    await vi.advanceTimersByTimeAsync(120_000);
    await expect(result).resolves.toEqual({
      ok: false, detail: { error: 'delegate timeout', taskId: 'slow-retention-task', output: '' },
    });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  });
});
