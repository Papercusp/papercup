/**
 * compare.test.ts — the P-003 comparator's threshold logic. Advisory posture
 * (D-005) is the runner's concern; here we lock the matching + flagging math.
 */

import { describe, expect, it } from 'vitest';
import type { MetricSummary, PerfArtifact } from './artifact';
import { baselineFromArtifacts, compareArtifacts, entryKey } from './compare';

function metric(p95: number, unit: MetricSummary['unit'] = 'ms'): MetricSummary {
  return { unit, count: 10, p50: p95 * 0.8, p95, p99: p95 * 1.1, max: p95 * 1.2, mean: p95 * 0.85 };
}

function artifact(
  scenario: string,
  params: Record<string, number>,
  metrics: Record<string, MetricSummary>,
  lagP95 = 10,
): PerfArtifact {
  return {
    schema: 1,
    scenario,
    tier: 1,
    params,
    startedAt: '2026-06-07T00:00:00.000Z',
    durationMs: 1000,
    host: { hostname: 'h', platform: 'linux', arch: 'x64', cpus: 8, node: 'v22' },
    metrics,
    loopLag: { p50Ms: lagP95 / 2, p95Ms: lagP95, p99Ms: lagP95 * 1.5, maxMs: lagP95 * 2 },
    sloPassed: lagP95 < 100,
    sloLimitMs: 100,
    cpu: { userMs: 1, systemMs: 1 },
    rss: { peakBytes: 1 },
    notes: [],
  };
}

describe('p2p-perf comparator', () => {
  const base = baselineFromArtifacts(
    [artifact('s.a', { size: 1000 }, { latMs: metric(100), rate: metric(1000, 'ops/sec') })],
    'ci',
  );

  it('flags a latency regression past tolerance', () => {
    const r = compareArtifacts(base, [
      artifact('s.a', { size: 1000 }, { latMs: metric(150), rate: metric(1000, 'ops/sec') }),
    ]);
    expect(r.regressions).toHaveLength(1);
    expect(r.regressions[0].metric).toBe('latMs');
    expect(r.regressions[0].relChange).toBeCloseTo(0.5, 1);
  });

  it('does not flag inside tolerance or under the absolute floor', () => {
    const inside = compareArtifacts(base, [
      artifact('s.a', { size: 1000 }, { latMs: metric(120), rate: metric(1000, 'ops/sec') }),
    ]);
    expect(inside.regressions).toHaveLength(0);
    const tiny = compareArtifacts(
      baselineFromArtifacts([artifact('s.a', { size: 1000 }, { latMs: metric(1) })], 'ci'),
      [artifact('s.a', { size: 1000 }, { latMs: metric(4) })], // +300% but under 5ms floor
    );
    expect(tiny.regressions).toHaveLength(0);
  });

  it('inverts the direction for ops/sec metrics', () => {
    const r = compareArtifacts(base, [
      artifact('s.a', { size: 1000 }, { latMs: metric(100), rate: metric(500, 'ops/sec') }),
    ]);
    expect(r.regressions.map((d) => d.metric)).toContain('rate');
    const faster = compareArtifacts(base, [
      artifact('s.a', { size: 1000 }, { latMs: metric(100), rate: metric(2000, 'ops/sec') }),
    ]);
    expect(faster.regressions).toHaveLength(0);
    expect(faster.improvements.map((d) => d.metric)).toContain('rate');
  });

  it('reports improvements symmetric to regressions', () => {
    const r = compareArtifacts(base, [
      artifact('s.a', { size: 1000 }, { latMs: metric(40), rate: metric(1000, 'ops/sec') }),
    ]);
    expect(r.improvements.map((d) => d.metric)).toContain('latMs');
  });

  it('always reports SLO violations, baseline match or not', () => {
    const r = compareArtifacts(base, [
      artifact('s.NEW', { size: 9 }, { latMs: metric(1) }, 250),
    ]);
    expect(r.sloViolations).toHaveLength(1);
    expect(r.sloViolations[0].p95Ms).toBe(250);
  });

  it('tracks new and missing entries by scenario+params key', () => {
    const r = compareArtifacts(base, [
      artifact('s.a', { size: 2000 }, { latMs: metric(100) }),
    ]);
    expect(r.newEntries).toContain(entryKey('s.a', { size: 2000 }));
    expect(r.missingEntries).toContain(entryKey('s.a', { size: 1000 }));
  });

  it('params key is order-insensitive', () => {
    expect(entryKey('x', { b: 2, a: 1 })).toBe(entryKey('x', { a: 1, b: 2 }));
  });
});
