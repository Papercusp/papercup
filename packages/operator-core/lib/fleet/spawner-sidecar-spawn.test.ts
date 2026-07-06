/**
 * Tests for the spawner sidecar spawner (WI-344 ③). Previously untested — added
 * as part of WI-3079's migration onto the shared process-supervision primitives
 * (process-supervision/sidecar-spawn-shared.ts), to lock in the spawn-plan +
 * ready-handshake + graceful-stop behavior this module now delegates part of.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: (...args: unknown[]) => spawnMock(...args) }));

import {
  _setSpawnerSidecarProcessForTests,
  getSpawnerSidecarProcess,
  isSpawnerSidecarRunning,
  spawnSpawnerSidecar,
  stopSpawnerSidecar,
} from './spawner-sidecar-spawn';

type FakeChild = EventEmitter & {
  pid: number;
  killed: boolean;
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
};

function makeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.pid = 4242;
  child.killed = false;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn((signal?: string) => {
    child.killed = true;
    child.emit('exit', signal === 'SIGKILL' ? 137 : 0);
  });
  return child;
}

describe('spawner-sidecar-spawn (WI-3079 migration)', () => {
  beforeEach(() => {
    spawnMock.mockReset();
    _setSpawnerSidecarProcessForTests(null);
  });

  afterEach(() => {
    _setSpawnerSidecarProcessForTests(null);
    vi.restoreAllMocks();
  });

  it('spawns via npx tsx in dev, resolves on the PAPERCUSP_SPAWNER_READY handshake', async () => {
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);

    const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await ready;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args, opts] = spawnMock.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
    expect(cmd).toBe('npx');
    expect(args[0]).toBe('tsx');
    expect(args[1]).toContain('apps/operator/bin/spawner-sidecar.ts');
    expect(opts.env?.PAPERCUSP_SPAWNER_IPC_SOCKET).toBe('/tmp/spawner-sidecar.sock');
    expect(isSpawnerSidecarRunning()).toBe(true);
    expect(getSpawnerSidecarProcess()).toBe(child);
  });

  it('stopSpawnerSidecar SIGTERMs the child and resolves once it exits (no respawn — spawner has none)', async () => {
    // spawner-sidecar-spawn.ts has no `deliberateStop` flag (unlike its substrate/gateway
    // siblings), so its 'exit' handler unconditionally console.warns "died" even on a
    // deliberate stop — pre-existing behavior, not something this migration changed.
    // Mock + assert per the fail-on-console convention.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const child = makeChild();
    spawnMock.mockReturnValueOnce(child);

    const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
    child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
    await ready;

    await stopSpawnerSidecar();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(getSpawnerSidecarProcess()).toBeNull();
    expect(isSpawnerSidecarRunning()).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('died'));
  });

  it('a no-op stop when nothing is running never throws', async () => {
    await expect(stopSpawnerSidecar()).resolves.toBeUndefined();
  });
});
