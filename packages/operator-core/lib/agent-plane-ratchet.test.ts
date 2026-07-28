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
  companionsUnavailable,
  METRIC_KNOWN_GAPS,
  RATCHET_VERDICTS,
  type MetricWindow,
  type RatchetVerdict,
} from './agent-plane-ratchet';
import { METRIC_SPECS, PLANE_METRIC_IDS, type PlaneMetricId } from './agent-plane-measurement';

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

describe('companionsUnavailable — a metric whose companion is dead is not a pass (P-019)', () => {
  const specs = {
    'clarification-rate': { interpretableOnlyWith: ['acted-on-stale-or-wrong-value'] as const },
    'plane-token-cost': {},
  };

  it('reports the companion when it is NOT holding', () => {
    const verdicts = new Map<PlaneMetricId, RatchetVerdict>([
      ['clarification-rate', 'holding'],
      ['acted-on-stale-or-wrong-value', 'never-interpretable'],
    ]);
    expect(companionsUnavailable('clarification-rate', verdicts, specs)).toEqual([
      'acted-on-stale-or-wrong-value',
    ]);
  });

  /**
   * THE NON-VACUITY CHECK. If this returned the companion unconditionally, the
   * disclosure would be a decoration that never clears — indistinguishable from a
   * hardcoded warning, and it would still be shouting after WI-6465 lands.
   */
  it('CLEARS once the companion starts holding — the disclosure is state-dependent', () => {
    const verdicts = new Map<PlaneMetricId, RatchetVerdict>([
      ['clarification-rate', 'holding'],
      ['acted-on-stale-or-wrong-value', 'holding'],
    ]);
    expect(companionsUnavailable('clarification-rate', verdicts, specs)).toEqual([]);
  });

  it('treats a REGRESSED companion as unavailable too, not just a never-built one', () => {
    const verdicts = new Map<PlaneMetricId, RatchetVerdict>([
      ['clarification-rate', 'holding'],
      ['acted-on-stale-or-wrong-value', 'regressed'],
    ]);
    expect(companionsUnavailable('clarification-rate', verdicts, specs)).toEqual([
      'acted-on-stale-or-wrong-value',
    ]);
  });

  it('says nothing about a metric that declares no companion', () => {
    const verdicts = new Map<PlaneMetricId, RatchetVerdict>([['plane-token-cost', 'holding']]);
    expect(companionsUnavailable('plane-token-cost', verdicts, specs)).toEqual([]);
  });

  /**
   * The LIVE registry, not a literal — this is the assertion that would have caught
   * the actual defect: `clarification-rate`'s spec said in prose that it is readable
   * only alongside `acted-on-stale-or-wrong-value`, and nothing enforced it.
   */
  it('the SHIPPED clarification-rate spec declares its companion structurally', () => {
    expect(METRIC_SPECS['clarification-rate'].interpretableOnlyWith).toEqual([
      'acted-on-stale-or-wrong-value',
    ]);
  });

  it('marks the row unreadable-alone in a full report, WITHOUT failing the build', () => {
    // acted-on-stale-or-wrong-value is never-interpretable here (its live state,
    // pending WI-6465) while clarification-rate's own funnel is healthy.
    const report = ratchetPlaneSeries({
      series: [windowOf('2026-07-27T13:18:00Z', { 'acted-on-stale-or-wrong-value': w(false) })],
    });

    const row = report.rows.find((r) => r.metric === 'clarification-rate')!;
    expect(row.verdict).toBe('holding');
    expect(row.unreadableAlone).toEqual(['acted-on-stale-or-wrong-value']);
    expect(report.unreadableAlone.map((r) => r.metric)).toContain('clarification-rate');
    // Reported, NOT failed — the honest fix is WI-6465's producer, and reddening the
    // fleet gate for a filed open gap teaches everyone to ignore this check.
    expect(report.failures.map((f) => f.metric)).not.toContain('clarification-rate');
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
      'acted-on-stale-or-wrong-value': w(false),
    });
    const after = windowOf('2026-07-27T14:34:00Z', {
      // came online …
      'acted-on-stale-or-wrong-value': w(true, { measuredAt: '2026-07-27T14:34:00Z' }),
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

  /**
   * The live series after WI-6545 / D-103: 6/7, one exempt, no regression.
   *
   * The DENOMINATOR dropped 8 → 7 because D-103 retired
   * `conflicting-assumption-incidence` outright rather than exempting it forever
   * (its population was empty BY CONSTRUCTION — see METRIC_KNOWN_GAPS). The two
   * COMMITMENT-backed legs are deliberately NOT blocked: their producer landed
   * (WI-6465 / D-102) and they hold in production from 2026-07-27T23:36Z onward,
   * so they take windowOf's interpretable default.
   */
  it('passes the real production series, with the dependsOn-backed metric exempt', () => {
    const blocked = { 'acted-on-stale-or-wrong-value': w(false) };
    const report = ratchetPlaneSeries({
      series: [
        windowOf('2026-07-27T13:18:00Z', { ...blocked, 'intent-action-divergence-stamped': w(false) }),
        windowOf('2026-07-27T14:34:00Z', blocked),
        windowOf('2026-07-27T17:05:00Z', blocked),
      ],
    });
    expect(report.failures).toHaveLength(0);
    expect(report.exempt.map((r) => r.metric)).toEqual(['acted-on-stale-or-wrong-value']);
    // 7 ids, 1 never-interpretable.
    expect(report.highWaterCount).toBe(6);
    expect(report.currentCount).toBe(6);
  });

  /**
   * ⚠ RETIRING A METRIC MUST NOT BE A WAY TO LAUNDER ONE.
   *
   * D-103 retired `conflicting-assumption-incidence` and deliberately KEPT
   * `acted-on-stale-or-wrong-value`, whose producer is equally silent. The
   * difference is that the kept one is `clarification-rate`'s declared companion,
   * so dropping it would silently upgrade that metric's hedged zero to an
   * unqualified pass. Pinned as an executable property rather than argued in a
   * comment, for the same reason the goalpost-moving guard below is: "retire the
   * inconvenient metric" is the cheapest possible way to green a ratchet.
   */
  it('retiring one blind metric did not retire the blind COMPANION that qualifies clarification-rate', () => {
    expect(PLANE_METRIC_IDS).not.toContain('conflicting-assumption-incidence');
    expect(PLANE_METRIC_IDS).toContain('acted-on-stale-or-wrong-value');
    // Still declared as the companion, so a blind companion still hedges the read.
    expect(METRIC_SPECS['clarification-rate'].interpretableOnlyWith).toContain(
      'acted-on-stale-or-wrong-value',
    );
    const verdicts = new Map<PlaneMetricId, RatchetVerdict>([
      ['acted-on-stale-or-wrong-value', 'never-interpretable'],
    ]);
    expect(companionsUnavailable('clarification-rate', verdicts, METRIC_SPECS)).toEqual([
      'acted-on-stale-or-wrong-value',
    ]);
  });

  /**
   * THE REGRESSION THIS PAIR EXISTS TO CATCH, pinned explicitly after WI-6465's close
   * red the fleet gate: closing the item a metric is exempt against must FAIL it, and
   * closing an UNRELATED item must not. Repointing an exemption is only legitimate
   * while that second property holds — otherwise "move it to another open item" becomes
   * a way to launder a gap indefinitely.
   */
  it('does NOT excuse the gapped metric when some OTHER item closes', () => {
    const blocked = { 'acted-on-stale-or-wrong-value': w(false) };
    const series = [windowOf('2026-07-27T14:34:00Z', blocked), windowOf('2026-07-27T17:05:00Z', blocked)];
    const afterUnrelated = ratchetPlaneSeries({ series, closedGaps: new Set(['WI-6465']) });
    expect(afterUnrelated.failures).toHaveLength(0);
    expect(afterUnrelated.exempt.map((r) => r.metric)).toEqual(['acted-on-stale-or-wrong-value']);
  });

  /**
   * ⚠ THE SAFETY PROPERTY FOR D-103's OWN CLOSE, pinned rather than reasoned about.
   *
   * WI-6465's close red the fleet gate precisely because a lint read a
   * machine-readable pointer at the item being closed. WI-6545 is the item that
   * retires the metric — so closing IT must be inert here, and it is inert only
   * because the retirement removed the id from METRIC_KNOWN_GAPS rather than
   * repointing it. If someone re-adds `conflicting-assumption-incidence` to the gap
   * map, this test reds instead of the fleet gate three minutes later.
   */
  it('closing WI-6545 is INERT — the metric it retired is no longer a gap to excuse', () => {
    const blocked = { 'acted-on-stale-or-wrong-value': w(false) };
    const series = [windowOf('2026-07-27T14:34:00Z', blocked), windowOf('2026-07-27T17:05:00Z', blocked)];
    const afterClose = ratchetPlaneSeries({ series, closedGaps: new Set(['WI-6545']) });
    expect(afterClose.failures).toHaveLength(0);
    expect(afterClose.exempt.map((r) => r.metric)).toEqual(['acted-on-stale-or-wrong-value']);
  });

  /** Closing WI-6548 must make the same series RED, not quietly retire the evidence. */
  it('turns the exempt metric into a failure the moment WI-6548 closes', () => {
    const blocked = { 'acted-on-stale-or-wrong-value': w(false) };
    const series = [windowOf('2026-07-27T14:34:00Z', blocked), windowOf('2026-07-27T17:05:00Z', blocked)];

    expect(ratchetPlaneSeries({ series }).failures).toHaveLength(0);

    const afterClose = ratchetPlaneSeries({ series, closedGaps: new Set(['WI-6548']) });
    expect(afterClose.failures.map((f) => f.metric)).toEqual(['acted-on-stale-or-wrong-value']);
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
