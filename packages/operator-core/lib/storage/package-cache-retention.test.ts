import { describe, expect, it, vi } from 'vitest';
import {
  PACKAGE_CACHE_MUTEX_NAME,
  PRESSURE_PACKAGE_CACHE_MAX_BYTES,
  resolvePackageCacheTargets,
  runPackageCacheRetention,
  type PackageCacheMeasurement,
  type PackageCacheTarget,
} from './package-cache-retention';
import { type DiskSnapshot } from './disk-space-alarm';

const GIB = 1024 ** 3;
const diskSnapshot = (freeBytes: number): DiskSnapshot => ({
  path: '/objects', totalBytes: 20 * GIB, freeBytes, freePct: freeBytes / (20 * GIB),
  totalInodes: 0, freeInodes: 0, freeInodesPct: 0,
});
const measurement = (bytes: number, truncated = false): PackageCacheMeasurement => ({ bytes, truncated });

const targets: PackageCacheTarget[] = [
  { manager: 'npm', path: '/cache/npm', command: 'npm', args: ['cache', 'clean'] },
  { manager: 'bun', path: '/cache/bun', command: 'bun', args: ['pm', 'cache', 'rm'] },
  { manager: 'pnpm', path: '/cache/pnpm', command: 'pnpm', args: ['store', 'prune'] },
];

describe('resolvePackageCacheTargets', () => {
  it('uses manager-owned cache roots and pins native cleanup to those exact paths', () => {
    const resolved = resolvePackageCacheTargets({
      homeDir: '/home/agent',
      cwd: '/repo',
      platform: 'linux',
      env: {
        NPM_CONFIG_CACHE: '~/npm-cache',
        BUN_INSTALL_CACHE_DIR: '/mnt/bun-cache',
        XDG_DATA_HOME: '/mnt/xdg',
        PAPERCUSP_NPM_BIN: '/bin/npm-x',
      },
    });

    expect(resolved).toEqual([
      {
        manager: 'npm',
        path: '/home/agent/npm-cache',
        command: '/bin/npm-x',
        args: ['--cache', '/home/agent/npm-cache', 'cache', 'clean', '--force'],
      },
      {
        manager: 'bun',
        path: '/mnt/bun-cache',
        command: 'bun',
        args: ['pm', 'cache', 'rm'],
        env: { BUN_INSTALL_CACHE_DIR: '/mnt/bun-cache' },
      },
      {
        manager: 'pnpm',
        path: '/mnt/xdg/pnpm/store',
        command: 'pnpm',
        args: ['--store-dir', '/mnt/xdg/pnpm/store', 'store', 'prune'],
      },
    ]);
  });
});

describe('runPackageCacheRetention', () => {
  it('previews a sub-high-water cache only on the critically pressured filesystem', async () => {
    const withMutex = vi.fn();
    const runCommand = vi.fn();
    const sampleDisk = vi.fn(async () => [diskSnapshot(2 * GIB)]);
    const out = await runPackageCacheRetention({
      targets, pressurePath: '/objects', dryRun: true,
      sameFilesystem: async (_path, cache) => cache !== '/cache/bun',
      sampleDisk,
      measure: async (cache) => measurement(cache === '/cache/pnpm' ? GIB / 2 : cache === '/cache/bun' ? 9 * GIB : 3 * GIB),
      withMutex, runCommand,
    });
    expect(out.map((row) => row.status)).toEqual(['would-prune', 'pressure-ineligible', 'below-threshold']);
    expect(out[0]?.maxBytes).toBe(PRESSURE_PACKAGE_CACHE_MAX_BYTES);
    expect(out[1]?.maxBytes).toBe(8 * GIB);
    expect(sampleDisk).toHaveBeenCalledWith(['/objects']);
    expect(withMutex).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('rechecks pressure under the writer lease and skips cleanup after peer recovery', async () => {
    const sampleDisk = vi.fn().mockResolvedValueOnce([diskSnapshot(GIB)])
      .mockResolvedValue([diskSnapshot(3 * GIB)]);
    const runCommand = vi.fn();
    const out = await runPackageCacheRetention({
      targets: [targets[0]!], pressurePath: '/objects', sampleDisk,
      sameFilesystem: async () => true,
      measure: async () => measurement(3 * GIB), runCommand,
      withMutex: async (name, run) => {
        expect(name).toBe(PACKAGE_CACHE_MUTEX_NAME);
        return run();
      },
    });
    expect(out[0]).toMatchObject({ status: 'below-threshold', maxBytes: 8 * GIB });
    expect(sampleDisk).toHaveBeenCalledTimes(2);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('stops pressure cleanup when the first native manager restores the reserve', async () => {
    const sampleDisk = vi.fn().mockResolvedValueOnce([diskSnapshot(GIB)])
      .mockResolvedValueOnce([diskSnapshot(GIB)])
      .mockResolvedValueOnce([diskSnapshot(GIB)])
      .mockResolvedValue([diskSnapshot(3 * GIB)]);
    const sizes = new Map([
      ['/cache/npm', [measurement(3 * GIB), measurement(3 * GIB), measurement(GIB / 2)]],
      ['/cache/bun', [measurement(3 * GIB), measurement(3 * GIB)]],
    ]);
    const runCommand = vi.fn(async () => ({ ok: true, exitCode: 0, timedOut: false, output: '' }));
    const out = await runPackageCacheRetention({
      targets: targets.slice(0, 2), pressurePath: '/objects', sampleDisk,
      sameFilesystem: async () => true,
      measure: async (cache) => sizes.get(cache)!.shift()!, runCommand,
      withMutex: async (_name, run) => run(),
    });
    expect(out.map((row) => row.status)).toEqual(['pruned', 'below-threshold']);
    expect(out[0]?.reclaimedBytes).toBe(2.5 * GIB);
    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith(targets[0], expect.any(String));
  });

  it.each([
    { snapshots: [] },
    { snapshots: [diskSnapshot(3 * GIB)] },
    { snapshots: [{ ...diskSnapshot(GIB), totalBytes: 0 }] },
    { snapshots: [{ ...diskSnapshot(GIB), freeBytes: Number.NaN }] },
    { snapshots: [{ ...diskSnapshot(GIB), freeBytes: -1 }] },
  ])('does not lower the cache floor for healthy or unmeasured pressure: $snapshots', async ({ snapshots }) => {
    const runCommand = vi.fn();
    const withMutex = vi.fn();
    const out = await runPackageCacheRetention({
      targets: [targets[0]!], pressurePath: '/objects',
      sampleDisk: async () => snapshots, sameFilesystem: async () => true,
      measure: async () => measurement(3 * GIB), runCommand, withMutex,
    });
    expect(out[0]).toMatchObject({ status: 'below-threshold', maxBytes: 8 * GIB });
    expect(withMutex).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('does not lower the floor when filesystem identity cannot be measured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runCommand = vi.fn();
      const out = await runPackageCacheRetention({
        targets: [targets[0]!], pressurePath: '/objects',
        sameFilesystem: async () => { throw new Error('stat denied'); },
        measure: async () => measurement(3 * GIB), runCommand,
      });
      expect(out[0]).toMatchObject({ status: 'pressure-ineligible', maxBytes: 8 * GIB });
      expect(runCommand).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('stat denied'));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not acquire the cleanup writer when every cache is below the high-water mark', async () => {
    const withMutex = vi.fn();
    const runCommand = vi.fn();
    const out = await runPackageCacheRetention({
      targets,
      maxBytes: 8,
      measure: async () => measurement(7),
      runCommand,
      withMutex,
    });

    expect(out.map((row) => row.status)).toEqual(['below-threshold', 'below-threshold', 'below-threshold']);
    expect(withMutex).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('dry-runs oversized or truncated caches without locking or executing cleanup', async () => {
    const withMutex = vi.fn();
    const runCommand = vi.fn();
    const sizes = new Map([
      ['/cache/npm', measurement(9)],
      ['/cache/bun', measurement(1, true)],
      ['/cache/pnpm', measurement(2)],
    ]);
    const out = await runPackageCacheRetention({
      targets,
      maxBytes: 8,
      dryRun: true,
      measure: async (path) => sizes.get(path)!,
      runCommand,
      withMutex,
    });

    expect(out.map((row) => row.status)).toEqual(['would-prune', 'would-prune', 'below-threshold']);
    expect(out[1]?.note).toMatch(/truncated/);
    expect(withMutex).not.toHaveBeenCalled();
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('re-measures under the shared install/cache mutex and runs each native manager command', async () => {
    const queues = new Map<string, PackageCacheMeasurement[]>([
      ['/cache/npm', [measurement(9), measurement(9), measurement(2)]],
      ['/cache/bun', [measurement(1)]],
      ['/cache/pnpm', [measurement(10), measurement(10), measurement(7)]],
    ]);
    const measure = vi.fn(async (path: string) => queues.get(path)!.shift()!);
    const runCommand = vi.fn(async () => ({ ok: true, exitCode: 0, timedOut: false, output: 'ok' }));
    const mutexCalls: Array<[string, Record<string, unknown> | undefined]> = [];
    const withMutex = async <T>(name: string, run: () => Promise<T>, options?: Record<string, unknown>): Promise<T> => {
      mutexCalls.push([name, options]);
      return run();
    };

    const out = await runPackageCacheRetention({
      targets,
      maxBytes: 8,
      repoRoot: '/repo',
      measure,
      runCommand,
      withMutex,
    });

    expect(mutexCalls).toHaveLength(1);
    expect(mutexCalls[0]?.[0]).toBe(PACKAGE_CACHE_MUTEX_NAME);
    expect(mutexCalls[0]?.[1]).toMatchObject({
      intent: { operation: 'package-cache-retention', managers: 'npm,pnpm' },
    });
    expect(runCommand.mock.calls).toEqual([
      [targets[0], '/repo'],
      [targets[2], '/repo'],
    ]);
    expect(out.map((row) => row.status)).toEqual(['pruned', 'below-threshold', 'pruned']);
    expect(out.map((row) => row.reclaimedBytes)).toEqual([7, 0, 3]);
  });

  it('does not run a stale cleanup when the cache fell below the threshold while waiting', async () => {
    const values = [measurement(9), measurement(4)];
    const runCommand = vi.fn();
    const out = await runPackageCacheRetention({
      targets: [targets[0]!],
      maxBytes: 8,
      measure: async () => values.shift()!,
      runCommand,
      withMutex: async (_name, run) => run(),
    });

    expect(out[0]).toMatchObject({ status: 'below-threshold', beforeBytes: 4 });
    expect(out[0]?.note).toMatch(/while waiting/);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it('contains command and mutex failures so one janitor tick cannot sink telemetry retention', async () => {
    const commandFailure = await runPackageCacheRetention({
      targets: [targets[0]!],
      maxBytes: 8,
      measure: async () => measurement(9),
      runCommand: async () => ({ ok: false, exitCode: 127, timedOut: false, output: 'missing' }),
      withMutex: async (_name, run) => run(),
    });
    expect(commandFailure[0]).toMatchObject({ status: 'prune-failed' });
    expect(commandFailure[0]?.note).toMatch(/127.*missing/);

    const mutexFailure = await runPackageCacheRetention({
      targets: [targets[0]!],
      maxBytes: 8,
      measure: async () => measurement(9),
      withMutex: async () => {
        throw new Error('install still active');
      },
    });
    expect(mutexFailure[0]).toMatchObject({ status: 'mutex-unavailable' });
    expect(mutexFailure[0]?.note).toContain('install still active');
  });

  it('keeps the maintenance wait default but honors a shorter caller budget', async () => {
    const observedTimeouts: number[] = [];
    const withMutex = async <T>(
      _name: string,
      _run: () => Promise<T>,
      options?: Record<string, unknown>,
    ): Promise<T> => {
      observedTimeouts.push(Number(options?.timeoutMs));
      throw new Error(`Timed out after ${String(options?.timeoutMs)}ms waiting for test mutex`);
    };
    const base = {
      targets: [targets[0]!],
      maxBytes: 8,
      measure: async () => measurement(9),
      withMutex,
    };

    expect((await runPackageCacheRetention(base))[0]).toMatchObject({ status: 'mutex-unavailable' });
    expect((await runPackageCacheRetention({ ...base, mutexTimeoutMs: 5_000 }))[0])
      .toMatchObject({ status: 'mutex-unavailable', note: expect.stringContaining('5000ms') });
    expect(observedTimeouts).toEqual([300_000, 5_000]);
  });
});
