/**
 * jev-memory-timeouts-to-zero-2026-10-01 D-001: one unit-start probe per unit per
 * UNIT_START_PROBE_TTL_MS, shared by concurrent callers.
 *
 * Unmemoized, one gitPipelinePosition({ path }) forked systemctl + ps for each of
 * ~5 unit probes, and deploymentPositionForEvidence runs up to 12 paths in
 * parallel, so a single work_items:get could freeze a multi-GB operator's event
 * loop for seconds. These tests pin the single-flight, the TTL expiry (never
 * served stale past it), and negative caching.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  UNIT_START_PROBE_TTL_MS,
  probeUnitStartShared,
  resetUnitStartProbeCacheForTest,
} from './git-pipeline-position';

type Probe = { pid: number | null; startedAtMs: number | null } | null;

describe('probeUnitStartShared', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T22:00:00Z'));
    resetUnitStartProbeCacheForTest();
  });
  afterEach(() => {
    vi.useRealTimers();
    resetUnitStartProbeCacheForTest();
  });

  it('runs ONE probe for many concurrent callers of the same unit', async () => {
    let release: (v: Probe) => void = () => undefined;
    const uncached = vi.fn(() => new Promise<Probe>((resolve) => { release = resolve; }));
    const pending = Array.from({ length: 10 }, () => probeUnitStartShared('papercusp-dev-api.service', uncached));
    release({ pid: 4242, startedAtMs: 1_000 });
    const results = await Promise.all(pending);
    expect(uncached).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(results[0]).toEqual({ pid: 4242, startedAtMs: 1_000 });
  });

  it('probes distinct units independently', async () => {
    const uncached = vi.fn(async (unit: string): Promise<Probe> => ({ pid: unit.length, startedAtMs: 1 }));
    await probeUnitStartShared('a.service', uncached);
    await probeUnitStartShared('bb.service', uncached);
    expect(uncached.mock.calls.map((c) => c[0])).toEqual(['a.service', 'bb.service']);
  });

  it('re-probes once the TTL has passed, never serving the old value', async () => {
    let n = 0;
    const uncached = vi.fn(async (): Promise<Probe> => ({ pid: ++n, startedAtMs: n }));
    await expect(probeUnitStartShared('u.service', uncached)).resolves.toEqual({ pid: 1, startedAtMs: 1 });
    vi.setSystemTime(Date.now() + UNIT_START_PROBE_TTL_MS - 1);
    await expect(probeUnitStartShared('u.service', uncached)).resolves.toEqual({ pid: 1, startedAtMs: 1 });
    vi.setSystemTime(Date.now() + 2);
    await expect(probeUnitStartShared('u.service', uncached)).resolves.toEqual({ pid: 2, startedAtMs: 2 });
    expect(uncached).toHaveBeenCalledTimes(2);
  });

  it('caches an unreadable systemd (null) too, so it is not re-forked per path', async () => {
    const uncached = vi.fn(async (): Promise<Probe> => null);
    await probeUnitStartShared('gone.service', uncached);
    await probeUnitStartShared('gone.service', uncached);
    expect(uncached).toHaveBeenCalledTimes(1);
  });
});
