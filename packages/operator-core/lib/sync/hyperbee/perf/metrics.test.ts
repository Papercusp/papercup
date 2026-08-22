/**
 * metrics.test.ts — percentile math + the ScenarioMeter envelope (P-001).
 */

import { describe, expect, it } from 'vitest';
import {
  convergenceVerdict,
  recomputeConvergenceVerdict,
  ScenarioMeter,
  Series,
  startTimer,
  summarize,
} from './metrics';

describe('summarize', () => {
  it('computes nearest-rank percentiles on a known series', () => {
    const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1)); // 1..100
    expect(s.count).toBe(100);
    expect(s.p50).toBe(50);
    expect(s.p95).toBe(95);
    expect(s.p99).toBe(99);
    expect(s.max).toBe(100);
    expect(s.mean).toBe(50.5);
  });

  it('handles tiny and empty series', () => {
    expect(summarize([])).toMatchObject({ count: 0, p50: 0, p95: 0, max: 0 });
    const one = summarize([7]);
    expect(one).toMatchObject({ count: 1, p50: 7, p95: 7, p99: 7, max: 7, mean: 7 });
  });

  it('is input-order independent', () => {
    expect(summarize([3, 1, 2])).toEqual(summarize([1, 2, 3]));
  });
});

describe('Series + startTimer', () => {
  it('collects and summarizes', () => {
    const s = new Series('ms');
    s.push(1);
    s.push(2);
    expect(s.count).toBe(2);
    expect(s.summarize().max).toBe(2);
  });

  it('startTimer measures elapsed ms', async () => {
    const done = startTimer();
    await new Promise((r) => setTimeout(r, 20));
    const ms = done();
    expect(ms).toBeGreaterThanOrEqual(15);
    expect(ms).toBeLessThan(2000);
  });
});

describe('ScenarioMeter', () => {
  it('produces a complete artifact with the D-003 SLO verdict', async () => {
    const meter = new ScenarioMeter({
      scenario: 'test.meter',
      tier: 1,
      params: { x: 1 },
    });
    meter.metric('aMs').push(5);
    meter.metric('rate', 'ops/sec').push(100);
    meter.opsDecoded = 42;
    meter.note('hello');
    await new Promise((r) => setTimeout(r, 30));
    const a = meter.finish();
    expect(a.schema).toBe(2);
    expect(a.scenario).toBe('test.meter');
    expect(a.tier).toBe(1);
    expect(a.params).toEqual({ x: 1 });
    expect(a.metrics.aMs.count).toBe(1);
    expect(a.metrics.rate.unit).toBe('ops/sec');
    expect(a.opsDecoded).toBe(42);
    expect(a.notes).toEqual(['hello']);
    expect(a.loopLag).not.toBeNull();
    expect(typeof a.sloPassed).toBe('boolean');
    expect(a.sloLimitMs).toBe(100);
    expect(a.durationMs).toBeGreaterThan(0);
    expect(a.rss.peakBytes).toBeGreaterThan(0);
    expect(a.host.cpus).toBeGreaterThan(0);
  });

  it('an idle loop passes the SLO; the verdict references the gauge', () => {
    const meter = new ScenarioMeter({ scenario: 't', tier: 1, params: {} });
    const a = meter.finish();
    // An idle test process should never show 100ms p95 loop lag.
    expect(a.sloPassed).toBe(true);
  });
});

/**
 * The recurrence guard for EI-20576392705164447.
 *
 * On 2026-08-16 a 64-peer `replication.sustained` run wrote an artifact that
 * simultaneously recorded (a) `sloPassed: true` with a healthy 21ms loop-lag
 * p95, (b) `notes` listing readers that never applied all ops, and (c) an
 * appendToVisible p95 of 601 SECONDS. The verdict read only (a), so `--gate`
 * and `--slo-only` would both have gone green on a mesh ten minutes behind.
 *
 * The invariant locked down here: a healthy host SLO must never be able to
 * carry a non-converged run to a pass. The two verdicts stay separate, and the
 * convergence one is not derivable from the responsiveness one.
 */
describe('convergence verdict (EI-20576392705164447)', () => {
  it('THE 2026-08-16 CASE: healthy loop lag + readers that never caught up ⇒ SLO passes, convergence FAILS', () => {
    const meter = new ScenarioMeter({
      scenario: 'replication.sustained',
      tier: 1,
      params: { peers: 64, rate: 10, count: 200 },
    });
    meter.expectReaders(63);
    meter.readerDidNotConverge(1);
    meter.readerDidNotConverge(22);
    const a = meter.finish();

    // The host really was responsive — that reading is preserved, not "fixed".
    expect(a.sloPassed).toBe(true);
    // …and it no longer speaks for the mesh.
    expect(a.convergencePassed).toBe(false);
    expect(a.convergence).toMatchObject({
      expectedReaders: 63,
      convergedReaders: 61,
      laggingReaders: ['1', '22'],
    });
    // The human-readable note is unchanged, so anything grepping artifacts still matches.
    expect(a.notes).toContain('reader 1 did not apply all ops in time');
  });

  it('CONTROL: the PRE-FIX verdict passes this very data — so the guard above is discriminating, not vacuous', () => {
    const meter = new ScenarioMeter({ scenario: 'replication.sustained', tier: 1, params: { peers: 64 } });
    meter.expectReaders(63);
    meter.readerDidNotConverge(1);
    const a = meter.finish();
    // What shipped before this fix: the whole verdict was `sloPassed`, and
    // nothing consulted `notes`. Kept here as a permanent control so a future
    // regression that quietly reverts the verdict to host-responsiveness-only
    // cannot leave these tests green (repo rule: prove the guard is falsifiable
    // WITHOUT mutating the shared tree).
    const preFixVerdict = (art: typeof a) => art.sloPassed;
    expect(preFixVerdict(a)).toBe(true); // ← the bug, reproduced
    expect(a.convergencePassed).toBe(false); // ← the fix, on identical input
  });

  /**
   * The headroom half of EI-20581532536662596 — see ConvergenceStats.budgetMs.
   *
   * A verdict says whether the run passed; these say BY HOW MUCH, which is what
   * makes a pass/fail flip attributable to the substrate rather than to someone
   * moving the goalpost.
   */
  describe('convergence headroom is recorded, not just the verdict', () => {
    it('records the budget and the observed times so headroom is computable', () => {
      const meter = new ScenarioMeter({ scenario: 'replication.sustained', tier: 1, params: { peers: 4 } });
      meter.expectReaders(3);
      meter.convergenceBudget(120_000);
      meter.readerConverged(0, 4_000);
      meter.readerConverged(1, 9_000);
      meter.readerConverged(2, 6_000);

      const a = meter.finish();
      expect(a.convergencePassed).toBe(true);
      expect(a.convergence?.budgetMs).toBe(120_000);
      expect(a.convergence?.convergedMs?.count).toBe(3);
      expect(a.convergence?.convergedMs?.max).toBe(9_000);
      // The claim a green run is entitled to make, now checkable from the artifact.
      expect(a.convergence!.budgetMs! - a.convergence!.convergedMs!.max).toBe(111_000);
    });

    it('DISCRIMINATION: two runs with the SAME verdict are distinguishable by headroom', () => {
      // The whole point. Both pass 3/3; one cleared a 120s budget with 111s to
      // spare, the other scraped it by 200ms and is one bad tick from red. A bare
      // `convergencePassed: true` renders these two identically — which is how a
      // budget change and a substrate change become impossible to tell apart.
      const roomy = new ScenarioMeter({ scenario: 's', tier: 1, params: {} });
      roomy.expectReaders(3);
      roomy.convergenceBudget(120_000);
      for (const ms of [4_000, 9_000, 6_000]) roomy.readerConverged('r', ms);

      const marginal = new ScenarioMeter({ scenario: 's', tier: 1, params: {} });
      marginal.expectReaders(3);
      marginal.convergenceBudget(120_000);
      for (const ms of [110_000, 119_800, 118_000]) marginal.readerConverged('r', ms);

      const a = roomy.finish();
      const b = marginal.finish();

      expect(a.convergencePassed).toBe(b.convergencePassed); // identical verdicts…
      expect(a.convergence!.convergedMs!.max).toBeLessThan(b.convergence!.convergedMs!.max);
      const headroom = (art: typeof a) =>
        art.convergence!.budgetMs! - art.convergence!.convergedMs!.max;
      expect(headroom(a)).toBeGreaterThan(100_000);
      expect(headroom(b)).toBeLessThan(1_000); // …wildly different margins
    });

    it('a reader that never converged contributes NO sample, so percentiles are not diluted', () => {
      // Censoring matters: stamping a non-converged reader at the budget would
      // drag `max` toward it and make a genuinely-degrading run read as merely
      // slow. The count falling short of expectedReaders is the signal instead.
      const meter = new ScenarioMeter({ scenario: 's', tier: 1, params: {} });
      meter.expectReaders(3);
      meter.convergenceBudget(120_000);
      meter.readerConverged(0, 4_000);
      meter.readerConverged(1, 6_000);
      meter.readerDidNotConverge(2);

      const a = meter.finish();
      expect(a.convergencePassed).toBe(false);
      expect(a.convergence?.convergedMs?.count).toBe(2);
      expect(a.convergence?.convergedMs?.max).toBe(6_000); // NOT 120_000
      expect(a.convergence?.convergedReaders).toBe(2);
    });

    it('stays null when the scenario declared no budget or timings — never a fabricated zero', () => {
      // An un-instrumented scenario must read as "not measured", not as "converged
      // instantly", which is the same false-zero class the verdict fix removed.
      const meter = new ScenarioMeter({ scenario: 's', tier: 1, params: {} });
      meter.expectReaders(2);
      const a = meter.finish();
      expect(a.convergence?.budgetMs).toBeNull();
      expect(a.convergence?.convergedMs).toBeNull();
    });
  });

  it('every reader caught up ⇒ convergence passes', () => {
    const meter = new ScenarioMeter({ scenario: 's', tier: 1, params: {} });
    meter.expectReaders(4);
    const a = meter.finish();
    expect(a.convergencePassed).toBe(true);
    expect(a.convergence).toMatchObject({ expectedReaders: 4, convergedReaders: 4, laggingReaders: [] });
  });

  it('a scenario that declares no readers reports NOT-MEASURED, never a silent pass', () => {
    const meter = new ScenarioMeter({ scenario: 'merge.idle-tick', tier: 1, params: {} });
    const a = meter.finish();
    expect(a.convergence).toBeNull();
    expect(a.convergencePassed).toBeNull();
  });

  it('expectReaders is additive so a multi-phase scenario counts every check', () => {
    const meter = new ScenarioMeter({ scenario: 'churn.reconnect-storm', tier: 1, params: {} });
    meter.expectReaders(3); // phase 1
    meter.expectReaders(3); // rejoin after the storm
    meter.readerDidNotConverge('rejoin:2');
    const a = meter.finish();
    expect(a.convergence).toMatchObject({ expectedReaders: 6, convergedReaders: 5 });
    expect(a.convergencePassed).toBe(false);
  });

  it('the same reader reported twice is counted once', () => {
    const meter = new ScenarioMeter({ scenario: 's', tier: 1, params: {} });
    meter.expectReaders(2);
    meter.readerDidNotConverge(1);
    meter.readerDidNotConverge(1);
    expect(meter.finish().convergence?.convergedReaders).toBe(1);
  });

  describe('the appendToVisible p95 ceiling', () => {
    it('is NOT judged when unset — recorded latency alone never fails a run', () => {
      expect(
        convergenceVerdict({
          expectedReaders: 2,
          convergedReaders: 2,
          laggingReaders: [],
          p95LimitMs: null,
          observedP95Ms: 601_075,
          budgetMs: null,
          convergedMs: null,
        }),
      ).toBe(true);
    });

    it('fails a run that blows an explicitly set ceiling even with every reader caught up', () => {
      expect(
        convergenceVerdict({
          expectedReaders: 2,
          convergedReaders: 2,
          laggingReaders: [],
          p95LimitMs: 5_000,
          observedP95Ms: 32_900,
          budgetMs: null,
          convergedMs: null,
        }),
      ).toBe(false);
    });

    it('passes under the ceiling', () => {
      expect(
        convergenceVerdict({
          expectedReaders: 2,
          convergedReaders: 2,
          laggingReaders: [],
          p95LimitMs: 5_000,
          observedP95Ms: 996,
          budgetMs: null,
          convergedMs: null,
        }),
      ).toBe(true);
    });
  });

  it('recomputeConvergenceVerdict picks up appendToVisibleMs attached AFTER finish()', () => {
    // foldChildResults patches the metric in post-finish, which is why the
    // latency half of the verdict cannot be decided inside finish().
    const meter = new ScenarioMeter({
      scenario: 'replication.sustained',
      tier: 1,
      params: {},
      convergenceP95LimitMs: 5_000,
    });
    meter.expectReaders(1);
    const a = meter.finish();
    expect(a.convergencePassed).toBe(true); // nothing measured yet
    a.metrics['appendToVisibleMs'] = summarize([601_075], 'ms');
    recomputeConvergenceVerdict(a);
    expect(a.convergencePassed).toBe(false);
    expect(a.convergence?.observedP95Ms).toBe(601_075);
  });
});
