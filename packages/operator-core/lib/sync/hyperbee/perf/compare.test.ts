/**
 * compare.test.ts — the P-003 comparator's threshold logic. Advisory posture
 * (D-005) is the runner's concern; here we lock the matching + flagging math.
 */

import { describe, expect, it } from 'vitest';
import type { MetricSummary, PerfArtifact } from './artifact';
import {
  baselineFromArtifacts,
  baselineFromHistory,
  compareArtifacts,
  entryKey,
  formatCompareReport,
} from './compare';

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
    schema: 2,
    provenance: null,
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
    convergence: null,
    convergencePassed: null,
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

  // WI-2788 — the absolute floor used to be a single scalar applied to the raw
  // value of every metric. Measured over 54 nightlies, that made three metrics
  // fire on 100% of their comparisons BY CONSTRUCTION rather than by regression.
  describe('sub-floor baselines (WI-2788)', () => {
    const tiny = baselineFromArtifacts(
      [artifact('s.tiny', { size: 1 }, { latMs: metric(1) })],
      'ci',
    );

    it('does not manufacture a regression when clearing the floor implies exceeding tolerance', () => {
      // baseline 1ms, floor 5ms: ANY sample that clears the floor is >= 6ms,
      // i.e. >= +500% — so a "regression" here is guaranteed by arithmetic and
      // says nothing about the code. Before the fix this reported +1900%.
      const r = compareArtifacts(tiny, [artifact('s.tiny', { size: 1 }, { latMs: metric(20) })]);
      expect(r.regressions).toHaveLength(0);
      expect(r.notComparable).toHaveLength(1);
      expect(r.notComparable[0]).toMatchObject({
        metric: 'latMs',
        reason: 'baseline-below-floor',
        baseline: 1,
        current: 20,
        floor: 5,
      });
    });

    it('reports the skip instead of silently dropping it', () => {
      const r = compareArtifacts(tiny, [artifact('s.tiny', { size: 1 }, { latMs: metric(20) })]);
      const text = formatCompareReport(r);
      expect(text).toContain('not comparable');
      expect(text).toContain('latMs');
    });

    it('still judges a metric whose baseline is comfortably above the floor', () => {
      // baseline 100ms: floor 5 < tolerance*baseline (35), so both the floor and
      // the relative test carry information and a real regression still flags.
      const r = compareArtifacts(base, [
        artifact('s.a', { size: 1000 }, { latMs: metric(150), rate: metric(1000, 'ops/sec') }),
      ]);
      expect(r.notComparable).toHaveLength(0);
      expect(r.regressions.map((d) => d.metric)).toContain('latMs');
    });

    it('honours the boundary exactly at absFloor === tolerance * baseline', () => {
      // baseline 14.285ms * 0.35 = 4.99875 < 5 -> not comparable;
      // baseline 15ms * 0.35 = 5.25 > 5 -> comparable.
      const justUnder = compareArtifacts(
        baselineFromArtifacts([artifact('s.b', { size: 1 }, { latMs: metric(14.285) })], 'ci'),
        [artifact('s.b', { size: 1 }, { latMs: metric(40) })],
      );
      expect(justUnder.notComparable).toHaveLength(1);
      const justOver = compareArtifacts(
        baselineFromArtifacts([artifact('s.b', { size: 1 }, { latMs: metric(15) })], 'ci'),
        [artifact('s.b', { size: 1 }, { latMs: metric(40) })],
      );
      expect(justOver.notComparable).toHaveLength(0);
      expect(justOver.regressions).toHaveLength(1);
    });
  });

  describe('per-unit absolute floors (WI-2788)', () => {
    it('uses a byte-scaled floor so RSS noise does not flag', () => {
      // A 5-BYTE floor never suppressed anything on a ~370MB RSS baseline.
      const rssBase = baselineFromArtifacts(
        [artifact('s.rss', { size: 1 }, { childRssPeak: metric(370_000_000, 'bytes') })],
        'ci',
      );
      const jitter = compareArtifacts(rssBase, [
        artifact('s.rss', { size: 1 }, { childRssPeak: metric(370_010_000, 'bytes') }),
      ]);
      expect(jitter.regressions).toHaveLength(0);
      expect(jitter.notComparable).toHaveLength(0);

      const real = compareArtifacts(rssBase, [
        artifact('s.rss', { size: 1 }, { childRssPeak: metric(600_000_000, 'bytes') }),
      ]);
      expect(real.regressions.map((d) => d.metric)).toContain('childRssPeak');
    });

    it('lets a caller override the floor per unit', () => {
      const rssBase = baselineFromArtifacts(
        [artifact('s.rss', { size: 1 }, { childRssPeak: metric(370_000_000, 'bytes') })],
        'ci',
      );
      const r = compareArtifacts(
        rssBase,
        [artifact('s.rss', { size: 1 }, { childRssPeak: metric(600_000_000, 'bytes') })],
        { absFloorByUnit: { bytes: 500_000_000 } },
      );
      expect(r.regressions).toHaveLength(0);
    });
  });

  describe('rolling reference (WI-2788)', () => {
    /** A run whose single metric took `v` ms. */
    const run = (v: number) => [artifact('s.a', { size: 1000 }, { latMs: metric(v) })];
    /** A noisy series: mostly ~100ms, with tenancy spikes — the real shape. */
    const noisy = [100, 105, 98, 260, 102, 99, 240, 101, 97, 300, 103, 100, 96, 250, 104];

    it('returns null until enough history has accumulated', () => {
      expect(baselineFromHistory([run(100), run(101)], { minRuns: 8 })).toBeNull();
      expect(baselineFromHistory([], {})).toBeNull();
    });

    it('derives the reference from the recent window, not one capture', () => {
      const b = baselineFromHistory(noisy.map(run), { quantile: 0.9, window: 15, minRuns: 8 });
      expect(b).not.toBeNull();
      const entry = b!.entries.find((e) => e.scenario === 's.a')!;
      // p90 of the series sits in the upper tail — above the ~100ms mode, below the max.
      expect(entry.metrics.latMs.p95).toBeGreaterThan(110);
      expect(entry.metrics.latMs.p95).toBeLessThan(300);
    });

    it('honours the window: older runs outside it do not move the reference', () => {
      const ancient = Array.from({ length: 20 }, () => run(9999));
      const b = baselineFromHistory([...ancient, ...noisy.map(run)], { window: 15, minRuns: 8 })!;
      expect(b.entries[0].metrics.latMs.p95).toBeLessThan(1000);
    });

    /**
     * TEETH. The measured reason a rolling MEDIAN is the wrong statistic: it is
     * exceeded by ~half of future samples by construction, so on a series whose
     * spread exceeds the tolerance it manufactures regressions. p90 does not.
     */
    it('a median reference flags a NORMAL sample that p90 correctly ignores', () => {
      const median = baselineFromHistory(noisy.map(run), { quantile: 0.5, window: 15, minRuns: 8 })!;
      const p90 = baselineFromHistory(noisy.map(run), { quantile: 0.9, window: 15, minRuns: 8 })!;
      // 250ms is an ordinary tenancy spike — it occurs repeatedly in the series.
      const sample = run(250);
      expect(compareArtifacts(median, sample).regressions).toHaveLength(1);
      expect(compareArtifacts(p90, sample).regressions).toHaveLength(0);
    });

    /** TEETH. A genuine regression must still be caught under the rolling reference. */
    it('still flags a real regression well beyond the historical spread', () => {
      const b = baselineFromHistory(noisy.map(run), { quantile: 0.9, window: 15, minRuns: 8 })!;
      const r = compareArtifacts(b, run(2000));
      expect(r.regressions.map((d) => d.metric)).toEqual(['latMs']);
    });

    it('uses the LOW tail for higher-is-better metrics', () => {
      const rates = [1000, 1010, 990, 600, 1005, 995, 1002, 998, 1001, 999];
      const b = baselineFromHistory(
        rates.map((v) => [artifact('s.r', { size: 1 }, { rate: metric(v, 'ops/sec') })]),
        { quantile: 0.9, window: 15, minRuns: 8 },
      )!;
      // Reference sits at the slow end, so an ordinary 600 ops/sec dip is not a "regression".
      expect(b.entries[0].metrics.rate.p95).toBeLessThan(1000);
      expect(
        compareArtifacts(b, [artifact('s.r', { size: 1 }, { rate: metric(600, 'ops/sec') })]).regressions,
      ).toHaveLength(0);
    });

    it('drops a metric that lacks enough observations in the window', () => {
      const runs = [
        ...Array.from({ length: 10 }, () => [artifact('s.a', { size: 1 }, { latMs: metric(100) })]),
        [artifact('s.a', { size: 1 }, { latMs: metric(100), rareMs: metric(50) })],
      ];
      const b = baselineFromHistory(runs, { minRuns: 8, window: 15 })!;
      expect(b.entries[0].metrics.latMs).toBeDefined();
      expect(b.entries[0].metrics.rareMs).toBeUndefined();
    });
  });
});
