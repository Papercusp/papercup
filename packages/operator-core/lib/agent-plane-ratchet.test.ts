/**
 * P-003 — the interpretability ratchet.
 *
 * The states this module exists to tell apart — a producer that died yesterday, a
 * producer never built, a zero that was relabelled — are states the live box is
 * not in today, and will not be in on the day someone breaks it. So they are
 * constructed here as literal series. A green run against production proves only
 * that nothing is broken right now; these prove the ratchet would SAY so.
 */
import { describe, expect, it } from 'vitest';
import {
  judgeMetricRatchet,
  judgeKnownGap,
  isIncoherent,
  ratchetPlaneSeries,
  METRIC_KNOWN_GAPS,
  RATCHET_VERDICTS,
  type MetricWindow,
} from './agent-plane-ratchet';
import { PLANE_METRIC_IDS, type PlaneMetricId } from './agent-plane-measurement';

const w = (interpretable: boolean, over: Partial<MetricWindow> = {}): MetricWindow => ({
  measuredAt: '2026-07-27T13:18:00Z',
  interpretable,
  fillRate: interpretable ? 0.5 : 0,
  zeroReason: interpretable ? null : 'nothing-eligible',
  ...over,
});

/** One measurement window with every metric's state named explicitly. */
function windowOf(at: string, states: Partial<Record<PlaneMetricId, MetricWindow>>) {
  return {
    measuredAt: at,
    metrics: PLANE_METRIC_IDS.map((id) => ({ id, ...(states[id] ?? w(true, { measuredAt: at })) })),
  };
}

describe('judgeMetricRatchet — the four states of one metric', () => {
  it('is holding when it is interpretable now', () => {
    expect(judgeMetricRatchet([w(false), w(true)])).toBe('holding');
    expect(judgeMetricRatchet([w(true), w(true)])).toBe('holding');
  });

  /**
   * THE ONE THAT MATTERS. A metric that demonstrably worked and stopped is a live
   * regression — a producer died — and it must never read as "not built yet".
   */
  it('is regressed when it worked before and does not now', () => {
    expect(judgeMetricRatchet([w(true), w(true), w(false)])).toBe('regressed');
  });

  it('is never-interpretable when it has never once worked', () => {
    expect(judgeMetricRatchet([w(false), w(false), w(false)])).toBe('never-interpretable');
  });

  it('keeps "stopped working" and "never worked" apart — same symptom, opposite cause', () => {
    const died = judgeMetricRatchet([w(true), w(false)]);
    const neverBuilt = judgeMetricRatchet([w(false), w(false)]);
    expect(died).toBe('regressed');
    expect(neverBuilt).toBe('never-interpretable');
    expect(died).not.toBe(neverBuilt);
  });

  it('reports no-data on an empty series rather than inventing a verdict', () => {
    expect(judgeMetricRatchet([])).toBe('no-data');
  });

  it('only recognises the verdicts it declares', () => {
    expect(RATCHET_VERDICTS).toContain(judgeMetricRatchet([w(true)]));
  });
});

describe('isIncoherent — the relabelled zero', () => {
  /**
   * The "fix" this must refuse. `vacuousPassWhen` on both blocked metrics says the
   * metric is UNBUILT, not clean; the cheapest way to green a ratchet is to flip
   * the label rather than build the producer. `comparable` is a subset of
   * `eligible`, so interpretability with nothing eligible is not a bad reading —
   * it is an impossible one.
   */
  it('flags interpretable-with-nothing-eligible as incoherent', () => {
    expect(isIncoherent(w(true, { fillRate: 0, zeroReason: 'nothing-eligible' }))).toBe(true);
    expect(isIncoherent(w(true, { fillRate: 0, zeroReason: 'population-empty' }))).toBe(true);
  });

  it('flags a zero fill-rate claiming interpretability, whatever the reason says', () => {
    expect(isIncoherent(w(true, { fillRate: 0, zeroReason: 'clean' }))).toBe(true);
  });

  it('leaves an honest interpretable metric alone', () => {
    expect(isIncoherent(w(true, { fillRate: 0.23, zeroReason: 'clean' }))).toBe(false);
    expect(isIncoherent(w(true, { fillRate: 1, zeroReason: 'none-observed' }))).toBe(false);
  });

  it('never flags an uninterpretable metric — it is not claiming anything', () => {
    expect(isIncoherent(w(false, { fillRate: 0, zeroReason: 'nothing-eligible' }))).toBe(false);
  });

  it('makes the relabelled zero a FAILING verdict, not a pass', () => {
    expect(judgeMetricRatchet([w(false), w(true, { fillRate: 0, zeroReason: 'nothing-eligible' })])).toBe('incoherent');
  });

  it('does not let an incoherent window count as "it once worked"', () => {
    // A fake interpretable window must not later license a `regressed` reading,
    // which would quietly upgrade a never-built metric into a live incident.
    expect(judgeMetricRatchet([w(true, { fillRate: 0, zeroReason: 'nothing-eligible' }), w(false)])).toBe(
      'never-interpretable',
    );
  });
});

describe('judgeKnownGap — the ratchet grows teeth when the item closes', () => {
  it('exempts an unbuilt metric while its gap item is open', () => {
    expect(judgeKnownGap({ verdict: 'never-interpretable', knownGap: 'WI-6465', gapClosed: false })).toBe('exempt');
  });

  /** P-003's entire purpose: the fix cannot be called done while the instrument is blind. */
  it('FAILS the same metric once the gap item closes', () => {
    expect(judgeKnownGap({ verdict: 'never-interpretable', knownGap: 'WI-6465', gapClosed: true })).toBe('fails');
  });

  it('fails an unexplained blind metric — an exemption must be a FILED one', () => {
    expect(judgeKnownGap({ verdict: 'never-interpretable' })).toBe('fails');
  });

  it('does not apply to a metric that is merely regressed', () => {
    expect(judgeKnownGap({ verdict: 'regressed', knownGap: 'WI-6465', gapClosed: false })).toBe('not-applicable');
  });
});

describe('ratchetPlaneSeries — per-metric, never the aggregate count', () => {
  /**
   * ⚠ THE VACUOUS PASS THIS MODULE EXISTS TO AVOID.
   *
   * Ratcheting `interpretable_count` is what the plan item's wording invites. Here
   * one metric dies in the same window another comes online: the count is 4 both
   * times, so a count-ratchet reports "holding" over a dead producer. The per-metric
   * ratchet sees it. This test is the difference between the two designs.
   */
  it('catches a regression that leaves interpretable_count UNCHANGED', () => {
    const before = windowOf('2026-07-27T13:18:00Z', {
      'conflicting-assumption-incidence': w(false),
      'acted-on-stale-or-wrong-value': w(false),
    });
    const after = windowOf('2026-07-27T14:34:00Z', {
      // came online …
      'conflicting-assumption-incidence': w(true, { measuredAt: '2026-07-27T14:34:00Z' }),
      'acted-on-stale-or-wrong-value': w(false, { measuredAt: '2026-07-27T14:34:00Z' }),
      // … while this one DIED.
      'intent-action-divergence-stamped': w(false, { measuredAt: '2026-07-27T14:34:00Z' }),
    });

    const report = ratchetPlaneSeries({ series: [before, after] });

    // The headline the naive ratchet would have watched did not move.
    expect(report.currentCount).toBe(report.highWaterCount);
    // And yet a producer died.
    expect(report.failures.map((f) => f.metric)).toEqual(['intent-action-divergence-stamped']);
    expect(report.rows.find((r) => r.metric === 'intent-action-divergence-stamped')?.verdict).toBe('regressed');
  });

  it('records WHEN a regressed metric last worked, so the window is findable', () => {
    const report = ratchetPlaneSeries({
      series: [
        windowOf('2026-07-27T13:18:00Z', {}),
        windowOf('2026-07-27T14:34:00Z', {}),
        windowOf('2026-07-27T15:04:00Z', { 'plane-token-cost': w(false, { measuredAt: '2026-07-27T15:04:00Z' }) }),
      ],
    });
    const row = report.rows.find((r) => r.metric === 'plane-token-cost');
    expect(row?.verdict).toBe('regressed');
    expect(row?.lastInterpretableAt).toBe('2026-07-27T14:34:00Z');
    expect(row?.firstInterpretableAt).toBe('2026-07-27T13:18:00Z');
  });

  /** The live series as of 2026-07-27: 3/6 then 4/6 from 14:34, and no regression. */
  it('passes the real production series, with the two WI-6465 metrics exempt', () => {
    const blocked = {
      'conflicting-assumption-incidence': w(false),
      'acted-on-stale-or-wrong-value': w(false),
    };
    const report = ratchetPlaneSeries({
      series: [
        windowOf('2026-07-27T13:18:00Z', { ...blocked, 'intent-action-divergence-stamped': w(false) }),
        windowOf('2026-07-27T14:34:00Z', blocked),
        windowOf('2026-07-27T17:05:00Z', blocked),
      ],
    });
    expect(report.failures).toHaveLength(0);
    expect(report.exempt.map((r) => r.metric).sort()).toEqual([
      'acted-on-stale-or-wrong-value',
      'conflicting-assumption-incidence',
    ]);
    expect(report.highWaterCount).toBe(4);
    expect(report.currentCount).toBe(4);
  });

  /** Closing WI-6465 must make the same series RED, not quietly retire the evidence. */
  it('turns the exempt metrics into failures the moment WI-6465 closes', () => {
    const blocked = {
      'conflicting-assumption-incidence': w(false),
      'acted-on-stale-or-wrong-value': w(false),
    };
    const series = [windowOf('2026-07-27T14:34:00Z', blocked), windowOf('2026-07-27T17:05:00Z', blocked)];

    expect(ratchetPlaneSeries({ series }).failures).toHaveLength(0);

    const afterClose = ratchetPlaneSeries({ series, closedGaps: new Set(['WI-6465']) });
    expect(afterClose.failures.map((f) => f.metric).sort()).toEqual([
      'acted-on-stale-or-wrong-value',
      'conflicting-assumption-incidence',
    ]);
    expect(afterClose.exempt).toHaveLength(0);
  });

  it('reports an empty series as no-data rather than as a clean pass', () => {
    const report = ratchetPlaneSeries({ series: [] });
    expect(report.windows).toBe(0);
    expect(report.failures).toHaveLength(0);
    expect(report.rows.every((r) => r.verdict === 'no-data')).toBe(true);
    // Nothing was measured, so nothing may be claimed.
    expect(report.highWaterCount).toBe(0);
  });

  it('names a gap item for every metric known to be blind, and only real ids', () => {
    for (const [metric, ref] of Object.entries(METRIC_KNOWN_GAPS)) {
      expect(PLANE_METRIC_IDS).toContain(metric as PlaneMetricId);
      expect(ref).toMatch(/^WI-\d+$/);
    }
  });
});
