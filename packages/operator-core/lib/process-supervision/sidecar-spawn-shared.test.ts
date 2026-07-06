import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  resolveSidecarSpawnPlan,
  respawnBackoffMs,
  pruneRespawnWindow,
  respawnBudgetExhausted,
  gracefulStopChild,
  registerSidecarShutdownHooks,
  _resetSidecarShutdownHookRegistryForTests,
} from './sidecar-spawn-shared';

describe('resolveSidecarSpawnPlan (WI-3079)', () => {
  it('dev (real .ts on disk) → npx tsx <devScriptPath>', () => {
    const plan = resolveSidecarSpawnPlan({
      selfPath: '/repo/packages/operator-core/lib/fleet/spawner-sidecar-spawn.ts',
      devScriptPath: '/repo/apps/operator/bin/spawner-sidecar.ts',
      bundledModeEnvVar: 'PAPERCUSP_SPAWNER_SIDECAR_MODE',
      execPath: '/usr/bin/node',
    });
    expect(plan).toEqual({
      cmd: 'npx',
      args: ['tsx', '/repo/apps/operator/bin/spawner-sidecar.ts'],
      env: {},
      mode: 'dev-tsx',
    });
  });

  it('packaged (bundled serve.mjs) → re-exec self under the bundled node with the divert env', () => {
    const plan = resolveSidecarSpawnPlan({
      selfPath: '/opt/Papercup/resources/serve.mjs',
      devScriptPath: '/opt/Papercup/resources/apps/operator/bin/spawner-sidecar.ts',
      bundledModeEnvVar: 'PAPERCUSP_SPAWNER_SIDECAR_MODE',
      execPath: '/opt/Papercup/resources/node',
    });
    expect(plan).toEqual({
      cmd: '/opt/Papercup/resources/node',
      args: ['/opt/Papercup/resources/serve.mjs'],
      env: { PAPERCUSP_SPAWNER_SIDECAR_MODE: '1' },
      mode: 'bundled-reexec',
    });
  });

  it('non-ts dev entry (defensive branch — never hit in practice) → direct execPath spawn', () => {
    const plan = resolveSidecarSpawnPlan({
      selfPath: '/repo/lib/x.ts',
      devScriptPath: '/repo/bin/x.js',
      bundledModeEnvVar: 'X_MODE',
      execPath: '/usr/bin/node',
    });
    expect(plan).toEqual({ cmd: '/usr/bin/node', args: ['/repo/bin/x.js'], env: {}, mode: 'dev-tsx' });
  });
});

describe('respawnBackoffMs', () => {
  it('doubles from 1s and caps at 30s', () => {
    expect(respawnBackoffMs(1)).toBe(1_000);
    expect(respawnBackoffMs(2)).toBe(2_000);
    expect(respawnBackoffMs(3)).toBe(4_000);
    expect(respawnBackoffMs(4)).toBe(8_000);
    expect(respawnBackoffMs(5)).toBe(16_000);
    expect(respawnBackoffMs(6)).toBe(30_000);
    expect(respawnBackoffMs(10)).toBe(30_000);
  });

  it('honors a custom cap', () => {
    expect(respawnBackoffMs(6, 60_000)).toBe(32_000);
  });

  it('never goes negative for a zero/negative attempt', () => {
    expect(respawnBackoffMs(0)).toBe(1_000);
    expect(respawnBackoffMs(-3)).toBe(1_000);
  });
});

describe('pruneRespawnWindow / respawnBudgetExhausted', () => {
  it('drops attempts older than the window', () => {
    const now = 100_000;
    const attempts = [now - 400_000, now - 100_000, now - 1_000];
    expect(pruneRespawnWindow(attempts, now, 300_000)).toEqual([now - 100_000, now - 1_000]);
  });

  it('trips once attempts reach maxAttempts', () => {
    expect(respawnBudgetExhausted([1, 2, 3, 4], 5)).toBe(false);
    expect(respawnBudgetExhausted([1, 2, 3, 4, 5], 5)).toBe(true);
    expect(respawnBudgetExhausted([], 5)).toBe(false);
  });
});

describe('gracefulStopChild', () => {
  it('resolves on exit without force-killing', async () => {
    const child = new EventEmitter();
    const kill = vi.fn((sig: NodeJS.Signals) => {
      if (sig === 'SIGTERM') queueMicrotask(() => child.emit('exit'));
    });
    await gracefulStopChild(child, { timeoutMs: 5_000, kill });
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('force-kills with SIGKILL after the timeout elapses', async () => {
    vi.useFakeTimers();
    const child = new EventEmitter();
    const kill = vi.fn();
    const done = gracefulStopChild(child, { timeoutMs: 5_000, kill });
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(kill).toHaveBeenCalledTimes(2);
    expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
    vi.useRealTimers();
  });

  it('never rejects even if kill() throws synchronously', async () => {
    const child = new EventEmitter();
    const kill = vi.fn(() => {
      throw new Error('ESRCH');
    });
    await expect(gracefulStopChild(child, { timeoutMs: 5_000, kill })).resolves.toBeUndefined();
  });
});

describe('registerSidecarShutdownHooks', () => {
  beforeEach(() => {
    _resetSidecarShutdownHookRegistryForTests();
  });

  it('is idempotent per label — a second call for the same label registers nothing new', () => {
    const before = process.listenerCount('SIGTERM');
    registerSidecarShutdownHooks({ label: 'test-idempotent', stop: () => {} });
    const afterFirst = process.listenerCount('SIGTERM');
    registerSidecarShutdownHooks({ label: 'test-idempotent', stop: () => {} });
    const afterSecond = process.listenerCount('SIGTERM');
    expect(afterFirst).toBeGreaterThan(before);
    expect(afterSecond).toBe(afterFirst);
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('uncaughtException');
  });

  it('async mode: SIGTERM handler awaits stop()', async () => {
    let stopped = false;
    registerSidecarShutdownHooks({
      label: 'test-async',
      stop: async () => {
        stopped = true;
      },
    });
    const listeners = process.listeners('SIGTERM');
    const newest = listeners[listeners.length - 1] as (...a: unknown[]) => unknown;
    await newest();
    expect(stopped).toBe(true);
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
    process.removeAllListeners('uncaughtException');
  });

  it("sync-with-exit mode: registers an 'exit' listener too, fire-and-forget", () => {
    let called = 0;
    registerSidecarShutdownHooks({ label: 'test-sync', stop: () => { called += 1; }, mode: 'sync-with-exit' });
    const listeners = process.listeners('exit');
    expect(listeners.length).toBeGreaterThan(0);
    const newest = listeners[listeners.length - 1] as (...a: unknown[]) => unknown;
    newest();
    expect(called).toBe(1);
    process.removeAllListeners('exit');
    process.removeAllListeners('SIGTERM');
    process.removeAllListeners('SIGINT');
  });
});
