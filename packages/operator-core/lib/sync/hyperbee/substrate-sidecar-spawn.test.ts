import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import {
  _resetSubstrateSidecarSpawnStateForTests,
  getSubstrateSidecarProcess,
  spawnSubstrateSidecar,
} from './substrate-sidecar-spawn';

type FakeChild = EventEmitter & {
  pid: number;
  killed: boolean;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

let nextPid = 2000;

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = nextPid++;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((signal?: string) => {
    child.killed = true;
    child.emit('exit', signal === 'SIGKILL' ? 137 : 0);
  });
  return child;
}

describe('substrate sidecar spawn hardening (WI-1504)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    spawnMock.mockReset();
    _resetSubstrateSidecarSpawnStateForTests();
    delete process.env.PAPERCUSP_SUBSTRATE_SIDECAR_MEMORY_MAX_G;
    delete process.env.PAPERCUSP_SUBSTRATE_SIDECAR_SCOPE;
  });

  afterEach(() => {
    _resetSubstrateSidecarSpawnStateForTests();
    vi.useRealTimers();
  });

  it('wraps the sidecar in a memory-capped transient user scope', async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);

    const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
    child.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
    await ready;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as [string, string[], { detached?: boolean; env?: NodeJS.ProcessEnv }];
    expect(cmd).toBe('systemd-run');
    expect(args).toContain('--user');
    expect(args).toContain('--scope');
    expect(args).toContain('--collect');
    expect(args).toContain('--property=MemoryMax=8G');
    expect(args).toContain('--property=MemorySwapMax=0');
    expect(args.join(' ')).toContain('apps/operator/bin/substrate-sidecar.ts');
    expect(opts.detached).toBe(true);
    expect(opts.env?.PAPERCUSP_SUBSTRATE_IPC_SOCKET).toBe('/tmp/substrate-sidecar.sock');
  });

  it('honors PAPERCUSP_SUBSTRATE_SIDECAR_MEMORY_MAX_G for the scope cap', async () => {
    process.env.PAPERCUSP_SUBSTRATE_SIDECAR_MEMORY_MAX_G = '12';
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);

    const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
    child.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
    await ready;

    const [, args] = spawnMock.mock.calls[0] as [string, string[]];
    expect(args).toContain('--property=MemoryMax=12G');
  });

  it('falls back to a direct spawn once when the scope cannot launch', async () => {
    const scoped = makeChild();
    const direct = makeChild();
    spawnMock.mockReturnValueOnce(scoped).mockReturnValueOnce(direct);

    const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
    scoped.stderr.emit('data', Buffer.from('Failed to connect to bus: No such file or directory'));
    scoped.emit('exit', 1);
    direct.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
    await ready;

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const [cmd1] = spawnMock.mock.calls[0] as [string, string[]];
    const [cmd2, args2] = spawnMock.mock.calls[1] as [string, string[]];
    expect(cmd1).toBe('systemd-run');
    expect(cmd2).toBe('npx');
    expect(args2[0]).toBe('tsx');
  });

  it('does not retry on a payload failure inside a healthy scope', async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);

    const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
    child.stderr.emit('data', Buffer.from('sidecar crashed while booting'));
    child.emit('exit', 1);

    await expect(ready).rejects.toThrow(/Sidecar exited before ready/);
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('auto-respawns after an unexpected post-ready exit', async () => {
    const first = makeChild();
    const second = makeChild();
    spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

    const ready = spawnSubstrateSidecar('/tmp/substrate-sidecar.sock', true);
    first.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
    await ready;
    expect(getSubstrateSidecarProcess()).toBe(first);

    first.emit('exit', 137);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    second.stdout.emit('data', Buffer.from('PAPERCUSP_SUBSTRATE_READY\n'));
    await vi.runAllTicks();
    expect(getSubstrateSidecarProcess()).toBe(second);
  });
});
