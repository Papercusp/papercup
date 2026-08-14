import { describe, expect, it } from 'vitest';
import type { HostSnapshot } from '../../host-snapshot';
import type { PerfSignalsV1 } from '../../system-health/perf-budgets';
import { buildHostMemoryPressurePayload } from './host-memory';

const NOW = Date.parse('2026-08-14T18:00:00.000Z');

function signals(memory?: NonNullable<NonNullable<PerfSignalsV1['signals']['psi']>['memory']>): PerfSignalsV1 {
  return {
    schemaVersion: 'perf-signals-v1',
    capturedAt: '2026-08-14T17:59:50.000Z',
    hostState: 'stable',
    signals: { psi: memory === undefined ? undefined : { memory } },
  };
}

function host(memFreePct: number): HostSnapshot {
  return {
    now: '2026-08-14T18:00:00.000Z',
    nowLocal: '2026-08-14 14:00:00 EDT (UTC-04:00)',
    memFreePct,
    memTotalGb: 252,
    psiMemSome60: 1.5,
  };
}

describe('host.memoryPressure resolver lens', () => {
  it('projects the canonical full-stall verdict with measurement time and threshold provenance', async () => {
    const out = await buildHostMemoryPressurePayload({
      nowMs: NOW,
      readSignals: async () => signals({ some: { avg60: 11.15 }, full: { avg60: 8.17 } }),
      readHost: () => host(27),
    });

    expect(out.memory).toMatchObject({
      pressure: 'crit',
      measuredAt: '2026-08-14T17:59:50.000Z',
      ageMs: 10_000,
      stale: false,
      psiMemorySome60: 11.15,
      psiMemoryFull60: 8.17,
      thresholds: {
        source: 'PERF_BUDGETS',
        psiMemorySomeWarn: 10,
        psiMemoryFullCrit: 5,
      },
      unknown: [],
    });
    expect(out.memory.reasons.join(' ')).toMatch(/all tasks stalled on memory/);
    expect(out.host).toMatchObject({ memFreePct: 27, memTotalGb: 252 });
  });

  it('keeps the free-memory falsifier independent from the PSI headline', async () => {
    const capture = signals({ some: { avg60: 1 }, full: { avg60: 0 } });
    const abundant = await buildHostMemoryPressurePayload({
      nowMs: NOW,
      readSignals: async () => capture,
      readHost: () => host(72),
    });
    const scarce = await buildHostMemoryPressurePayload({
      nowMs: NOW,
      readSignals: async () => capture,
      readHost: () => host(4),
    });

    expect(abundant.memory.pressure).toBe('ok');
    expect(scarce.memory.pressure).toBe('ok');
    expect(abundant.host.memFreePct).toBe(72);
    expect(scarce.host.memFreePct).toBe(4);
  });

  it('reports missing PSI inputs in-band instead of manufacturing a healthy zero', async () => {
    const out = await buildHostMemoryPressurePayload({
      nowMs: NOW,
      readSignals: async () => signals(),
      readHost: () => host(31),
    });

    expect(out.memory.pressure).toBeNull();
    expect(out.memory.unknown.map((u) => u.code)).toEqual([
      'psi-memory-some-unmeasured',
      'psi-memory-full-unmeasured',
    ]);
  });
});
