/**
 * regression-coverage-denominator.test.ts — a rendered regression count must
 * always carry the metric coverage it was computed over (WI-39359).
 *
 * THE DEFECT THIS LOCKS OUT. `compareArtifacts` has always routed metrics whose
 * baseline sits under the absolute floor to `notComparable` — a relative verdict
 * on them cannot carry information, so flagging them would select FOR outliers
 * instead of suppressing noise (WI-2788). That part was correct. What was
 * missing is that the resulting BLIND SPOT never travelled with the verdict:
 * `RunSummary` dropped `notComparable` entirely, so p2p-perf-actions rendered
 * "N regressions" as though every metric had been judged.
 *
 * Measured 2026-08-17 against the promoted tier1 `ci` baseline: 11 of 51
 * metrics (22%) are structurally blind — idleTickMs, decodeMs, deltaTick1Ms and
 * appendCallMs among them, i.e. the hot path. A 10x regression on idleTickMs
 * (0.01 → 0.1ms) is invisible to the fleet gate. "0 regressions" over that set
 * is a bounded measurement rendered as a confident total, which is the same
 * class of trap as an aggregate computed over a capped fetch.
 *
 * The guard is BEHAVIOURAL, not field-name-based: it asserts that a fully-judged
 * run and a partially-blind run cannot produce the same rendered verdict.
 */

import { describe, expect, it } from 'vitest';
import type { MetricSummary, PerfArtifact } from './artifact';
import { baselineFromArtifacts, compareArtifacts, formatCompareReport } from './compare';
import { _testing } from '../../../harness/routines/p2p-perf-actions';

function metric(p95: number, unit: MetricSummary['unit'] = 'ms'): MetricSummary {
  return { unit, count: 10, p50: p95 * 0.8, p95, p99: p95 * 1.1, max: p95 * 1.2, mean: p95 * 0.85 };
}

function artifact(
  scenario: string,
  params: Record<string, number>,
  metrics: Record<string, MetricSummary>,
): PerfArtifact {
  return {
    schema: 1,
    scenario,
    tier: 1,
    params,
    startedAt: '2026-08-17T00:00:00.000Z',
    durationMs: 1000,
    host: { hostname: 'h', platform: 'linux', arch: 'x64', cpus: 8, node: 'v22' },
    metrics,
    loopLag: { p50Ms: 5, p95Ms: 10, p99Ms: 15, maxMs: 20 },
    sloPassed: true,
    sloLimitMs: 100,
    convergence: null,
    convergencePassed: null,
    cpu: { userMs: 1, systemMs: 1 },
    rss: { peakBytes: 1 },
    notes: [],
  };
}

/**
 * A metric well ABOVE the 5ms `ms` floor: 100ms baseline means the floor is
 * 5% of it, so the floor gate and the 35% relative test each still carry
 * information. These are the metrics the guard genuinely covers.
 */
const judged = () => ({ latMs: metric(100) });

/**
 * A metric BELOW the floor/tolerance crossover (floor 5ms > 0.35 * 0.5ms), so
 * a relative verdict on it is uninformative by construction and it is routed to
 * `notComparable`. This is the shape of the real hot-path metrics.
 */
const blind = () => ({ latMs: metric(100), idleTickMs: metric(0.5) });

describe('regression verdicts carry their coverage denominator', () => {
  it('counts a below-floor "unchanged" metric as JUDGED, not blind', () => {
    // The below-floor `continue` in the compare loop is itself a verdict
    // ("moved less than the floor, so unchanged"), NOT a skip. Counting it as
    // blind would understate coverage and cry wolf on every clean run.
    const base = baselineFromArtifacts([artifact('s.a', { n: 1 }, judged())], 'ci');
    const r = compareArtifacts(base, [artifact('s.a', { n: 1 }, { latMs: metric(101) })]);
    expect(r.regressions).toHaveLength(0);
    expect(r.notComparable).toHaveLength(0);
    expect(r.metricsCompared).toBe(1);
  });

  it('separates judged from not-comparable metrics in the same run', () => {
    const base = baselineFromArtifacts([artifact('s.a', { n: 1 }, blind())], 'ci');
    const r = compareArtifacts(base, [artifact('s.a', { n: 1 }, blind())]);
    expect(r.metricsCompared).toBe(1); // latMs
    expect(r.notComparable).toHaveLength(1); // idleTickMs
    expect(r.notComparable[0]!.metric).toBe('idleTickMs');
  });

  /**
   * THE PRE-FIX CONTROL — PERMANENT. This reproduces the OLD rendering (a bare
   * count with no denominator) and asserts it is BLIND to the difference the
   * real subject must detect. Without this, a "fix" that simply stopped
   * reporting coverage would pass the test below vacuously.
   */
  it('CONTROL: a bare regression count cannot distinguish full from partial coverage', () => {
    const renderBare = (n: number) => `${n} regressions`;

    const fullBase = baselineFromArtifacts([artifact('s.a', { n: 1 }, judged())], 'ci');
    const full = compareArtifacts(fullBase, [artifact('s.a', { n: 1 }, judged())]);

    const partialBase = baselineFromArtifacts([artifact('s.a', { n: 1 }, blind())], 'ci');
    const partial = compareArtifacts(partialBase, [artifact('s.a', { n: 1 }, blind())]);

    // Both runs found zero regressions, but the second judged only half its
    // metrics. The old rendering collapses them onto the same string.
    expect(full.regressions).toHaveLength(0);
    expect(partial.regressions).toHaveLength(0);
    expect(partial.notComparable.length).toBeGreaterThan(0);
    expect(renderBare(full.regressions.length)).toBe(renderBare(partial.regressions.length));
  });

  it('SUBJECT: the rendered report DOES distinguish them', () => {
    const fullBase = baselineFromArtifacts([artifact('s.a', { n: 1 }, judged())], 'ci');
    const full = formatCompareReport(compareArtifacts(fullBase, [artifact('s.a', { n: 1 }, judged())]));

    const partialBase = baselineFromArtifacts([artifact('s.a', { n: 1 }, blind())], 'ci');
    const partial = formatCompareReport(compareArtifacts(partialBase, [artifact('s.a', { n: 1 }, blind())]));

    expect(full).not.toBe(partial);
    // The clean run states its denominator without alarm...
    expect(full).toContain('1 metric(s) judged');
    expect(full).not.toContain('NOT COMPARABLE');
    // ...and the partially-blind run says so loudly.
    expect(partial).toContain('NOT COMPARABLE');
  });

  describe('formatCoverage — the release-facing suffix', () => {
    const { formatCoverage } = _testing;

    it('stays silent when coverage is complete', () => {
      expect(formatCoverage({ regressionCoverage: { judged: 51, blind: 0, total: 51 } } as never)).toBe('');
    });

    it('stays silent when no baseline comparison ran', () => {
      // No comparison is NOT the same as full coverage, but there is also no
      // coverage figure to report — the surrounding line already says so.
      expect(formatCoverage({ regressionCoverage: null } as never)).toBe('');
    });

    it('warns, with both numbers, when any metric was not comparable', () => {
      const s = formatCoverage({ regressionCoverage: { judged: 40, blind: 11, total: 51 } } as never);
      expect(s).toContain('40/51');
      expect(s).toContain('11');
      expect(s).toContain('NOT COMPARABLE');
    });

    it('CALIBRATION: the real tier1 blind-spot shape renders a warning', () => {
      // Guards against a "fix" that silences the warning for realistic inputs.
      expect(formatCoverage({ regressionCoverage: { judged: 40, blind: 11, total: 51 } } as never)).not.toBe('');
    });
  });
});
