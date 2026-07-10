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
  _resetSpawnerSidecarSpawnStateForTests,
  _setSpawnerSidecarProcessForTests,
  getSpawnerSidecarProcess,
  isSpawnerSidecarRunning,
  registerSpawnerSidecarShutdownHooks,
  spawnerSidecarSupervisionStatus,
  spawnSpawnerSidecar,
  stopSpawnerSidecar,
  MAX_RESPAWN_ATTEMPTS,
} from './spawner-sidecar-spawn';
import { _resetSidecarShutdownHookRegistryForTests, respawnBackoffMs } from '../process-supervision/sidecar-spawn-shared';

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
    vi.useFakeTimers();
    _resetSpawnerSidecarSpawnStateForTests();
  });

  afterEach(() => {
    _resetSpawnerSidecarSpawnStateForTests();
    vi.useRealTimers();
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

  it('stopSpawnerSidecar SIGTERMs the child, resolves once it exits, and does NOT auto-respawn (P-006: deliberate stop gates the respawn machinery)', async () => {
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
    // A deliberate stop is a graceful shutdown, not a crash — neither the "died"
    // warning nor an auto-respawn attempt should fire.
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('died'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawnMock).toHaveBeenCalledTimes(1); // still just the original spawn — no respawn
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

  // P-006 (critical-process-supervisor-2026-07-04): the spawner sidecar previously
  // had NO auto-respawn-on-crash at all (unlike its substrate-sidecar sibling,
  // WI-1504) — an unexpected exit just cleared state and waited for the next
  // caller to lazily re-spawn it. This block locks in the added mechanism,
  // cloned from substrate-sidecar-spawn.ts's (same shared helpers, same numbers).
  describe('auto-respawn-on-crash (P-006)', () => {
    it('auto-respawns after an unexpected post-ready exit', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const first = makeChild();
      const second = makeChild();
      spawnMock.mockReturnValueOnce(first).mockReturnValueOnce(second);

      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      first.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;
      expect(getSpawnerSidecarProcess()).toBe(first);

      first.emit('exit', 137);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('auto-respawning'));

      await vi.advanceTimersByTimeAsync(1000);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      second.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await vi.runAllTicks();
      expect(getSpawnerSidecarProcess()).toBe(second);
    });

    it('isStopping-equivalent guard: a deliberate stopSpawnerSidecar() never schedules a respawn', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);
      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;

      const stopPromise = stopSpawnerSidecar();
      child.emit('exit', 0); // the deliberate-stop exit
      await stopPromise;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(spawnMock).toHaveBeenCalledTimes(1); // no respawn
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('died'));
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('auto-respawning'));
    });

    it('MAX_RESPAWN_ATTEMPTS crashes within the window give up auto-respawning', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const first = makeChild();
      spawnMock.mockReturnValueOnce(first);
      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      first.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;

      let current = first;
      for (let i = 0; i < MAX_RESPAWN_ATTEMPTS; i++) {
        const next = makeChild();
        spawnMock.mockReturnValueOnce(next);
        current.emit('exit', 137);
        // Advance EXACTLY this attempt's backoff (never more) then immediately emit
        // ready on the new child, with zero elapsed time in between — unlike
        // substrate's killSidecarTree (a real process-group kill that no-ops
        // against a fake pid in tests), spawner's internal 10s ready-handshake
        // timeout directly calls `sidecarProcess.kill()`, which THIS suite's
        // mock synchronously turns into a real 'exit' emission. Blindly
        // overshooting the advance (e.g. a flat 20s) would let that internal
        // timeout fire first and double-count a respawn attempt.
        await vi.advanceTimersByTimeAsync(respawnBackoffMs(i + 1));
        next.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
        await vi.runAllTicks();
        current = next;
      }
      expect(spawnMock).toHaveBeenCalledTimes(MAX_RESPAWN_ATTEMPTS + 1);
      expect(spawnerSidecarSupervisionStatus().gaveUp).toBe(false);

      const spawnCallsBefore = spawnMock.mock.calls.length;
      current.emit('exit', 137);
      await vi.advanceTimersByTimeAsync(1000);
      expect(spawnMock).toHaveBeenCalledTimes(spawnCallsBefore); // no further respawn
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('giving up auto-respawn'));
      expect(spawnerSidecarSupervisionStatus().gaveUp).toBe(true);
    });
  });

  describe('spawnerSidecarSupervisionStatus (P-006 — dev:service_health feed)', () => {
    it('reports running:true + zero flap counters for a healthy, never-crashed sidecar', async () => {
      const child = makeChild();
      spawnMock.mockReturnValueOnce(child);
      const ready = spawnSpawnerSidecar('/tmp/spawner-sidecar.sock');
      child.stdout.emit('data', Buffer.from('PAPERCUSP_SPAWNER_READY\n'));
      await ready;

      expect(spawnerSidecarSupervisionStatus()).toEqual({
        running: true,
        respawnAttemptsInWindow: 0,
        gaveUp: false,
        lastRespawnScheduledAt: null,
      });
    });

    it('reports running:false + no state when nothing has ever spawned', () => {
      expect(spawnerSidecarSupervisionStatus()).toEqual({
        running: false,
        respawnAttemptsInWindow: 0,
        gaveUp: false,
        lastRespawnScheduledAt: null,
      });
    });
  });
});
