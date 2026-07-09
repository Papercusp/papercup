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
  registerSpawnerSidecarShutdownHooks,
  spawnSpawnerSidecar,
  stopSpawnerSidecar,
} from './spawner-sidecar-spawn';
import { _resetSidecarShutdownHookRegistryForTests } from '../process-supervision/sidecar-spawn-shared';

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

  it('EI-8810: never hands the child the parent HTTP port or the background-worker role', async () => {
    // The 2026-07-09 incident: the child inherited the parent's
    // PAPERCUSP_HONO_PORT=3270 (+ PORT, set by startRequestServers) and — when
    // the re-exec'd entry missed the *_SIDECAR_MODE divert — booted a FULL
    // hono-host on the parent's own port: EADDRINUSE → fatal exit → warm-up
    // respawn, forever. The spawn env must force port 0 (ephemeral) and
    // background-workers OFF regardless of what the parent env carries.
    process.env.PAPERCUSP_HONO_PORT = '3270';
    process.env.PORT = '3270';
    process.env.PAPERCUSP_BACKGROUND_WORKERS = '1';
    try {
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);

      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;

      const [, , opts] = spawnMock.mock.calls[0] as [string, string[], { env?: NodeJS.ProcessEnv }];
      expect(opts.env?.PAPERCUSP_HONO_PORT).toBe('0');
      expect(opts.env?.PORT).toBe('0');
      expect(opts.env?.PAPERCUSP_BACKGROUND_WORKERS).toBe('0');
    } finally {
      delete process.env.PAPERCUSP_HONO_PORT;
      delete process.env.PORT;
      delete process.env.PAPERCUSP_BACKGROUND_WORKERS;
    }
  });

  // P-006 (plan p2p-parity-parallel-lanes-2026-07-09): the sidecar respawn
  // churn. Root cause — the shared `uncaughtException` shutdown hook fired
  // (and killed a HEALTHY sidecar) on every benign `write EPIPE` a client
  // disconnect throws, which hono-host's own guard already classifies benign
  // and swallows. `registerSpawnerSidecarShutdownHooks` must gate on that same
  // classification so a benign process-wide exception no longer tears the
  // sidecar down (and triggers a warm-respawn + a fresh `[swarm] DHT
  // bootstrap` the next time a caller needs it).
  describe('registerSpawnerSidecarShutdownHooks (P-006 — benign-exception gate)', () => {
    beforeEach(() => {
      _resetSidecarShutdownHookRegistryForTests();
    });
    afterEach(() => {
      process.removeAllListeners('SIGTERM');
      process.removeAllListeners('SIGINT');
      process.removeAllListeners('uncaughtException');
    });

    const newestUncaughtExceptionListener = (): ((err: unknown) => unknown) => {
      const listeners = process.listeners('uncaughtException');
      return listeners[listeners.length - 1] as (err: unknown) => unknown;
    };

    it('a benign write EPIPE (client disconnect) does NOT stop a running sidecar', async () => {
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);
      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;

      registerSpawnerSidecarShutdownHooks();
      await newestUncaughtExceptionListener()(
        Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }),
      );

      expect(child.kill).not.toHaveBeenCalled();
      expect(isSpawnerSidecarRunning()).toBe(true);
    });

    it('a genuinely fatal uncaught exception still stops the sidecar', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);
      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;

      registerSpawnerSidecarShutdownHooks();
      await newestUncaughtExceptionListener()(new TypeError('a real bug, not EPIPE'));

      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      warn.mockRestore();
    });
  });
});
