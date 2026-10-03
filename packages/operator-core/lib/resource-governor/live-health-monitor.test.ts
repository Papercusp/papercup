import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResourceProfile } from '@papercusp/resource-profile';
import {
  LiveHealthMonitor,
  applyHostLiveHealthReadings,
  parseCloseWaitCount,
  parseMemoryKernel,
  parseNetworkCounters,
  parseProcStat,
  parsePsi,
  type HostLiveHealthCounters,
  type LiveHealthPaths,
} from './live-health-monitor';
import { emptyLiveHealthSignals } from './live-health';

const PATHS: LiveHealthPaths = {
  rootDir: '/tmp/health',
  fragmentsDir: '/tmp/health/fragments',
  snapshotPath: '/tmp/health/live-health.json',
};

function counters(overrides: Partial<HostLiveHealthCounters> = {}): HostLiveHealthCounters {
  return {
    atMs: 2_000,
    cpu: { idleMs: 400, totalMs: 1_000 },
    totalMemoryBytes: 1_000,
    freeMemoryBytes: 250,
    cpuPsi: { some60: 2.5, full60: null },
    memoryPsi: { some60: 3.5, full60: 1.5 },
    scheduler: { runnable: 4, blocked: 1 },
    memoryKernel: { swapUsedBytes: 100, swapInPages: 20, swapOutPages: 40 },
    network: { rxBytes: 2_000, txBytes: 4_000 },
    closeWaitCount: 3,
    diskFreeBytes: 5_000,
    ...overrides,
  };
}

describe('live-health host parsers', () => {
  it('parses PSI, scheduler, swap, network, and socket counters with unknown-preserving failures', () => {
    expect(parsePsi('some avg10=1.0 avg60=2.5 avg300=3 total=4\nfull avg10=0 avg60=1.5 avg300=2 total=3')).toEqual({
      some60: 2.5,
      full60: 1.5,
    });
    expect(parsePsi(null)).toEqual({ some60: null, full60: null });
    expect(parseProcStat('cpu 1 2 3\nprocs_running 7\nprocs_blocked 2\n')).toEqual({ runnable: 7, blocked: 2 });
    expect(parseMemoryKernel('SwapTotal: 100 kB\nSwapFree: 40 kB\n', 'pswpin 9\npswpout 11\n')).toEqual({
      swapUsedBytes: 60 * 1_024,
      swapInPages: 9,
      swapOutPages: 11,
    });
    expect(
      parseNetworkCounters(
        'Inter-|...\n eth0: 100 0 0 0 0 0 0 0 250 0 0 0 0 0 0 0\n lo: 999 0 0 0 0 0 0 0 999 0 0 0 0 0 0 0',
      ),
    ).toEqual({ rxBytes: 100, txBytes: 250 });
    expect(parseCloseWaitCount('sl local remote st\n0: a b 08\n1: a b 01\n', null)).toBe(1);
    expect(parseCloseWaitCount(null, null)).toBeNull();
  });

  it('uses deltas for CPU, swap, and network and leaves the first window unknown', () => {
    const firstSignals = emptyLiveHealthSignals(1_000);
    const first = counters({
      atMs: 1_000,
      cpu: { idleMs: 100, totalMs: 400 },
      memoryKernel: { swapUsedBytes: 80, swapInPages: 10, swapOutPages: 20 },
      network: { rxBytes: 1_000, txBytes: 2_000 },
    });
    applyHostLiveHealthReadings(firstSignals, 'monitor:1', first, null);
    expect(firstSignals['cpu.hostUtilizationPct'].state).toBe('unknown');
    expect(firstSignals['memory.swapInBytesPerSec'].value).toBeNull();

    const secondSignals = emptyLiveHealthSignals(2_000);
    applyHostLiveHealthReadings(secondSignals, 'monitor:1', counters(), first);
    expect(secondSignals['cpu.hostUtilizationPct'].value).toBeCloseTo(50);
    expect(secondSignals['memory.swapInBytesPerSec'].value).toBe(10 * 4_096);
    expect(secondSignals['network.rxBytesPerSec'].value).toBe(1_000);
    expect(secondSignals['memory.hostUsedBytes'].value).toBe(750);
  });
});

describe('LiveHealthMonitor composition', () => {
  it('writes one versioned snapshot with resource-profile normalization and explicit observations', async () => {
    const writeSnapshot = vi.fn(async () => {});
    const profile = {
      signals: {
        cores: 6,
        physicalCores: 8,
        totalMemBytes: 10_000,
        freeMemBytes: 2_000,
        embeddedPg: false,
        hostRole: 'full',
      },
    } as ResourceProfile;
    const monitor = new LiveHealthMonitor({
      paths: PATHS,
      cadenceMs: 2_000,
      now: () => 2_000,
      resourceProfile: profile,
      collectHost: async () => counters(),
      readFragments: async () => [],
      writeSnapshot,
    });
    const snapshot = await monitor.sampleOnce();
    expect(snapshot.schemaVersion).toBe('resource-governor-live-health-v1');
    expect(snapshot.profile).toMatchObject({
      effectiveCores: 6,
      physicalCores: 8,
      source: '@papercusp/resource-profile',
    });
    expect(snapshot.signals['memory.hostUsedBytes']).toMatchObject({
      state: 'measured',
      value: 750,
      writerId: monitor.writer.id,
    });
    expect(snapshot.observations['memory.hostUsedBytes'][monitor.writer.id]).toEqual(
      snapshot.signals['memory.hostUsedBytes'],
    );
    expect(snapshot.signals['database.waitP95Ms']).toMatchObject({
      state: 'unknown',
      value: null,
      reason: 'writer-not-observed',
    });
    expect(writeSnapshot).toHaveBeenCalledWith(PATHS.snapshotPath, snapshot);
  });
});
