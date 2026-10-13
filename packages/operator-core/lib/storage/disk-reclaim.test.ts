import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess } from 'node:child_process';
import { compilePolicy, type RetentionClass } from './retention-policy';
import { nativeRetentionCommand, selectRetentionEntries, type RetentionEntry } from './disk-reclaim';

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
