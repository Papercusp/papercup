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
  demonstratedEvidenceFloor,
  sustainedlyUninterpretable,
  UNJUDGEABLE_WINDOW_RUN,
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

/** Literal fixture: the exemption lifecycle stays testable after the shipped map empties. */
const STALE_ACTION_GAP = { 'acted-on-stale-or-wrong-value': 'WI-6548' } as const;

describe('⚠ a QUIET window is not a DEAD producer (the 2026-07-28T03:08Z fleet-gate red)', () => {
  /** The exact live window that red the gate: 37 eligible, 0 comparable. */
  const quiet = (over: Partial<MetricWindow> = {}): MetricWindow =>
    w(false, { zeroReason: 'nothing-comparable', fillRate: 0.0222, ...over });
  /** A producer that genuinely stopped writing: nothing was even eligible. */
  const dead = (over: Partial<MetricWindow> = {}): MetricWindow =>
    w(false, { zeroReason: 'nothing-eligible', fillRate: 0, ...over });

  it('excuses ONE quiet window after a healthy run — reported, not a regression', () => {
    expect(judgeMetricRatchet([w(true), w(true), quiet()])).toBe('window-unjudgeable');
  });

  it('⚠ STILL fails a producer that genuinely died, on the FIRST window', () => {
    // The teeth this module exists for are unchanged. `nothing-eligible` means the
    // producer has not written — that is a producer signal, never a quiet window.
    expect(judgeMetricRatchet([w(true), w(true), dead()])).toBe('regressed');
  });

  it('⚠ a SUSTAINED run of uninterpretable windows is a regression even if the producer writes', () => {
    // Otherwise a metric that can never find a comparable unit hides behind
    // "quiet" forever — the excuse would become the new vacuous pass.
    expect(judgeMetricRatchet([w(true), quiet(), quiet(), quiet()])).toBe('regressed');
    expect(judgeMetricRatchet([w(true), quiet(), quiet()])).toBe('window-unjudgeable');
  });

  it('⚠ never excuses a zero FILL RATE, whatever the reason string says', () => {
    // fillRate = eligible/population. A zero means nothing was eligible at all, so
    // the producer did NOT write — the reason string must not override the count.
    expect(judgeMetricRatchet([w(true), quiet({ fillRate: 0 })])).toBe('regressed');
    expect(judgeMetricRatchet([w(true), quiet({ fillRate: null })])).toBe('regressed');
  });

  it('does not excuse a metric that was NEVER interpretable', () => {
    expect(judgeMetricRatchet([quiet(), quiet()])).toBe('never-interpretable');
  });

  it('recovers to holding the moment a comparable unit appears again', () => {
    expect(judgeMetricRatchet([w(true), quiet(), w(true)])).toBe('holding');
  });

  it('⚠ dates the last-good window from the ROW when the stored metric has none', () => {
    // The persisted `metrics` jsonb carries no per-metric `measuredAt` — it is a
    // column on the row — so live data produced "WORKED until null" on every
    // regression banner, losing the one fact that separates a producer that died an
    // hour ago from one that died last week.
    const series = [
      { measuredAt: '2026-07-28T02:38:00Z', metrics: [{ id: PLANE_METRIC_IDS[0], interpretable: true, fillRate: 0.5, zeroReason: null }] },
      { measuredAt: '2026-07-28T03:08:00Z', metrics: [{ id: PLANE_METRIC_IDS[0], interpretable: false, fillRate: 0, zeroReason: 'nothing-eligible' as const }] },
    ] as unknown as Parameters<typeof ratchetPlaneSeries>[0]['series'];
    const row = ratchetPlaneSeries({ series }).rows.find((r) => r.metric === PLANE_METRIC_IDS[0])!;
    expect(row.verdict).toBe('regressed');
    expect(row.lastInterpretableAt).toBe('2026-07-28T02:38:00Z');
    expect(row.firstInterpretableAt).toBe('2026-07-28T02:38:00Z');
  });

  it('a quiet window does NOT fail the build', () => {
    const series = [
      windowOf('2026-07-28T02:38:00Z', {}),
      windowOf('2026-07-28T03:08:00Z', { [PLANE_METRIC_IDS[0]]: quiet() }),
    ];
    const report = ratchetPlaneSeries({ series });
    expect(report.rows.find((r) => r.metric === PLANE_METRIC_IDS[0])?.verdict).toBe('window-unjudgeable');
    expect(report.failures.map((f) => f.metric)).not.toContain(PLANE_METRIC_IDS[0]);
  });
});

/**
 * WI-6562 — the SECOND quiet-fleet gate red, 2026-07-28T04:25Z on candidate
 * 18bb073c. The block above fixed one shape of "quiet is not dead"; these are the
 * two it did not cover, and between them they held `main` for the whole fleet on a
 * plane where BOTH producers were demonstrably alive.
 *
 * Every number below is the live series read back from
 * `harness_shared.agent_plane_measurements`, not an invented one — the fleet went
 * from ~4,470 calls per window to 926 overnight and both metrics fell off their
 * funnels for want of traffic alone.
 */
describe('⚠ WI-6562: a QUIET FLEET is not a dead producer either', () => {
  const STAMPED = 'intent-action-divergence-stamped';
  const SAMPLING = 'intent-action-divergence-sampling';

  /** An interpretable window carrying `eligible` of the producer's output. */
  const good = (eligible: number, at = '2026-07-27T20:00:00Z'): MetricWindow => ({
    measuredAt: at,
    interpretable: true,
    fillRate: 0.2,
    zeroReason: null,
    eligible,
    population: eligible * 5,
  });

  describe('BUG A — `nothing-eligible` when eligibility IS the occurrence', () => {
    /** 2026-07-28T04:09Z: 926 calls examined, ZERO tool failures in the window. */
    const noFailures: MetricWindow = {
      measuredAt: '2026-07-28T04:09:33Z',
      interpretable: false,
      fillRate: 0,
      zeroReason: 'nothing-eligible',
      eligible: 0,
      population: 926,
    };

    it('is a QUIET window for a metric whose eligible counts occurrences', () => {
      // 926 calls were scanned and none failed. That is the fleet having a clean
      // half-hour — the outcome we want — not the failure-row producer dying.
      expect(judgeMetricRatchet([good(9), good(1), noFailures], { eligibilityIsOccurrence: true })).toBe(
        'window-unjudgeable',
      );
    });

    it('⚠ is STILL a regression for a metric whose eligible counts a written INPUT', () => {
      // The teeth, unchanged and defaulted: six of the seven metrics count stamps,
      // `dependsOn`, declared bases. Zero of those over a live population really is
      // a dead producer, and must still fail on the FIRST window.
      expect(judgeMetricRatchet([good(9), good(1), noFailures])).toBe('regressed');
      expect(judgeMetricRatchet([good(9), good(1), noFailures], { eligibilityIsOccurrence: false })).toBe(
        'regressed',
      );
    });

    it('⚠ never excuses an EMPTY population — nothing examined is a producer signal', () => {
      // fillRate null (not 0) means the population itself was empty, so the sweep
      // did not run at all. `population` is what separates the two, exactly as this
      // metric's own vacuousPassWhen says — so a null must never reach the excuse.
      const nothingExamined: MetricWindow = { ...noFailures, fillRate: null, zeroReason: 'population-empty' };
      expect(judgeMetricRatchet([good(9), nothingExamined], { eligibilityIsOccurrence: true })).toBe(
        'regressed',
      );
      expect(
        judgeMetricRatchet([good(9), { ...noFailures, fillRate: null }], { eligibilityIsOccurrence: true }),
      ).toBe('regressed');
    });

    it('⚠ STILL fails when zero occurrences persist across BUSY windows', () => {
      // The teeth. `eligible` IS the zero for an occurrence metric, so the run is
      // weighed by what it SCANNED. Three ~4,000-call windows finding not one
      // failure, at the live ~0.4% failure rate, is not a lucky quiet spell — the
      // failure rows stopped arriving. The excuse must never be permanent.
      const busy: MetricWindow = { ...noFailures, population: 4_000 };
      const history = [good(12), good(20), good(17)]; // populations 60/100/85
      expect(sustainedlyUninterpretable([...history, busy, busy, busy], true)).toBe(true);
      expect(judgeMetricRatchet([...history, busy, busy, busy], { eligibilityIsOccurrence: true })).toBe(
        'regressed',
      );
    });

    it('but a run of QUIET windows is not — the fleet was simply idle', () => {
      // Same three-window run, same zero failures, one-fifth the traffic. The live
      // interpretable history scanned ~3.3k calls per window; 926 finding none is
      // an ordinary draw, not evidence the producer died.
      const history = [1_704, 1_667, 4_143, 4_398, 3_809].map((p) => ({
        ...good(10),
        population: p,
      }));
      expect(demonstratedEvidenceFloor(history, true)).toBe(3_809);
      expect(sustainedlyUninterpretable([...history, noFailures, noFailures, noFailures], true)).toBe(
        false,
      );
    });

    it('the LIVE sampling series does not fail the build', () => {
      // 23:08 (9 failures) · 23:39 (1) · 04:09 (0) — read from the real rows.
      const series = [
        windowOf('2026-07-28T03:08:34Z', { [SAMPLING]: good(9, '2026-07-28T03:08:34Z') }),
        windowOf('2026-07-28T03:39:02Z', { [SAMPLING]: good(1, '2026-07-28T03:39:02Z') }),
        windowOf('2026-07-28T04:09:33Z', { [SAMPLING]: noFailures }),
      ];
      const report = ratchetPlaneSeries({ series });
      expect(report.rows.find((r) => r.metric === SAMPLING)?.verdict).toBe('window-unjudgeable');
      expect(report.failures.map((f) => f.metric)).not.toContain(SAMPLING);
    });

    it('⚠ exactly ONE shipped metric declares occurrence-eligibility, and it is the sampling one', () => {
      // A guard on the DECLARATION, not the behaviour. This flag is an exemption
      // from the first-window teeth, so a metric acquiring it silently is how those
      // teeth would erode — the failure mode METRIC_KNOWN_GAPS exists to prevent,
      // one field over. Adding one is fine; adding one UNNOTICED is not.
      const declared = PLANE_METRIC_IDS.filter((id) => METRIC_SPECS[id].eligibilityIsOccurrence === true);
      expect(declared).toEqual([SAMPLING]);
    });
  });

  describe('BUG B — the degradation run is counted in EVIDENCE, not wall clock', () => {
    /** The three windows that red the gate: 37, 129, 37 stamped calls. */
    const thin = (eligible: number, at: string): MetricWindow => ({
      measuredAt: at,
      interpretable: false,
      fillRate: 0.04,
      zeroReason: 'nothing-comparable',
      eligible,
    });
    /** The live interpretable history, oldest-first: median eligible = 363. */
    const history: MetricWindow[] = [
      252, 409, 450, 597, 783, 955, 923, 43, 209, 280, 220, 363, 327, 487, 422, 206, 72,
    ].map((e) => good(e));

    it('reads the median of the metric’s OWN interpretable windows as the floor', () => {
      expect(demonstratedEvidenceFloor(history)).toBe(363);
      // The median, not the min — one lucky 43-call window must not set a floor so
      // low that it excuses nothing and the fix is vacuous.
      expect(demonstratedEvidenceFloor(history)).toBeGreaterThan(43);
    });

    it('does NOT call three starved windows a regression', () => {
      // 37 + 129 + 37 = 203 stamped calls across the whole 1.5h "sustained" run —
      // FEWER than the single 206-call window two hours earlier that yielded just 2
      // comparable buckets. In this corpus comparable arrives at ~eligible/70, so a
      // zero here is the noise floor, and no commit could have moved it.
      const windows = [
        ...history,
        thin(37, '2026-07-28T03:08:34Z'),
        thin(129, '2026-07-28T03:39:02Z'),
        thin(37, '2026-07-28T04:09:33Z'),
      ];
      expect(sustainedlyUninterpretable(windows)).toBe(false);
      expect(judgeMetricRatchet(windows)).toBe('window-unjudgeable');
    });

    it('⚠ STILL fails a half-dead producer writing at NORMAL volume', () => {
      // The teeth this rule exists for: stamps still written at full rate but
      // `goal_ref` dropped, so no bucket can ever compare. Output clears the floor
      // inside the same three windows and the regression fires exactly as before.
      const windows = [
        ...history,
        thin(400, '2026-07-28T03:08:34Z'),
        thin(420, '2026-07-28T03:39:02Z'),
        thin(390, '2026-07-28T04:09:33Z'),
      ];
      expect(sustainedlyUninterpretable(windows)).toBe(true);
      expect(judgeMetricRatchet(windows)).toBe('regressed');
    });

    it('⚠ falls back to pure run-length when no window carries `eligible`', () => {
      // Rows persisted before the ratchet read this field have no output to weigh,
      // and an ABSENT measurement must never become an excuse — such a series is
      // judged exactly as it was before, on run length alone.
      const bare = (): MetricWindow => ({
        measuredAt: '2026-07-28T03:08:00Z',
        interpretable: false,
        fillRate: 0.0222,
        zeroReason: 'nothing-comparable',
      });
      expect(sustainedlyUninterpretable([good(0), bare(), bare(), bare()])).toBe(true);
      expect(
        judgeMetricRatchet([
          { measuredAt: 'a', interpretable: true, fillRate: 0.5, zeroReason: null },
          bare(),
          bare(),
          bare(),
        ]),
      ).toBe('regressed');
    });

    it('a run SHORTER than the window minimum is never sustained, however much it carries', () => {
      const windows = [...history, thin(9_000, '2026-07-28T03:39:02Z'), thin(9_000, '2026-07-28T04:09:33Z')];
      expect(windows.slice(-2).length).toBeLessThan(UNJUDGEABLE_WINDOW_RUN);
      expect(sustainedlyUninterpretable(windows)).toBe(false);
    });
  });
});

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
    // WI-212675: the subject here is the first/last-interpretable BOOKKEEPING, and the
    // metric is only a placeholder for "one that regressed". It used to be
    // `plane-token-cost`, which is now declared `eligibilityIsTraffic` and therefore
    // reads a zero-eligible window as STARVED rather than dead — a correct verdict that
    // made it the wrong placeholder. `closed-work-basis-moved` is a stamped-input
    // metric, so the original first-window teeth this test asserts still apply to it.
    const report = ratchetPlaneSeries({
      series: [
        windowOf('2026-07-27T13:18:00Z', {}),
        windowOf('2026-07-27T14:34:00Z', {}),
        windowOf('2026-07-27T15:04:00Z', {
          'closed-work-basis-moved': w(false, { measuredAt: '2026-07-27T15:04:00Z' }),
        }),
      ],
    });
    const row = report.rows.find((r) => r.metric === 'closed-work-basis-moved');
    expect(row?.verdict).toBe('regressed');
    expect(row?.lastInterpretableAt).toBe('2026-07-27T14:34:00Z');
    expect(row?.firstInterpretableAt).toBe('2026-07-27T13:18:00Z');
  });

  /**
   * WI-212675 — the STARVED-window shape, measured live on 2026-09-03.
   *
   * All 7 Claude accounts in the provider pool hit their usage wall at ~07:00Z.
   * Workspace tool volume fell from ~6,800/hr to ~380/hr and calls to the ten
   * ENRICHED_SURFACES hit EXACTLY zero for four consecutive hours. `plane-token-cost`
   * measures bytes per enriched call, so its `eligible` went to 0 over a population
   * that was still non-empty — `nothing-eligible` with `fillRate: 0`, which the ratchet
   * read as a dead producer. It reported `regressed` and held `main` for the whole
   * fleet, on a condition no commit caused and no commit could green.
   */
  describe('a traffic-eligible metric starved by a usage-walled fleet', () => {
    it('is window-unjudgeable, not regressed — nothing died, the fleet just stopped calling', () => {
      const report = ratchetPlaneSeries({
        series: [
          windowOf('2026-09-03T05:50:00Z', {}),
          windowOf('2026-09-03T06:50:00Z', {}),
          windowOf('2026-09-03T07:50:00Z', {
            'plane-token-cost': w(false, { measuredAt: '2026-09-03T07:50:00Z' }),
          }),
        ],
      });
      const row = report.rows.find((r) => r.metric === 'plane-token-cost');
      expect(row?.verdict).toBe('window-unjudgeable');
      expect(report.failures.map((f) => f.metric)).not.toContain('plane-token-cost');
    });

    it('STILL reaches regressed once the run is sustained — the teeth are unchanged', () => {
      // The exemption is only ever "one starved window is not evidence". A run long
      // enough to clear the WI-6562 evidence floor is still a regression, which is what
      // stops this from being a way to green the gate by declaring a flag.
      const starved = (at: string) => windowOf(at, { 'plane-token-cost': w(false, { measuredAt: at }) });
      const report = ratchetPlaneSeries({
        series: [
          windowOf('2026-09-03T05:50:00Z', {}),
          starved('2026-09-03T07:50:00Z'),
          starved('2026-09-03T08:50:00Z'),
          starved('2026-09-03T09:50:00Z'),
        ],
      });
      expect(report.rows.find((r) => r.metric === 'plane-token-cost')?.verdict).toBe('regressed');
    });

    it('does not hand the exemption to a metric that did not declare it', () => {
      // The opt-in is the whole safety property: a stamped-input metric with the exact
      // same window shape must keep its first-window teeth.
      const report = ratchetPlaneSeries({
        series: [
          windowOf('2026-09-03T05:50:00Z', {}),
          windowOf('2026-09-03T07:50:00Z', {
            'acted-on-stale-declared-basis': w(false, { measuredAt: '2026-09-03T07:50:00Z' }),
          }),
        ],
      });
      expect(report.rows.find((r) => r.metric === 'acted-on-stale-declared-basis')?.verdict).toBe(
        'regressed',
      );
    });
  });

  /**
   * The live rollout series through WI-6548: 6/7 while producer v2 carried the
   * blind dependency replay, then 7/7 when producer v3 persisted a comparable
   * `staleValueQuotes` verdict for the first time.
   *
   * The DENOMINATOR dropped 8 → 7 because D-103 retired
   * `conflicting-assumption-incidence` outright rather than exempting it forever
   * (its population was empty BY CONSTRUCTION — see METRIC_KNOWN_GAPS). The two
   * COMMITMENT-backed legs are deliberately NOT blocked: their producer landed
   * (WI-6465 / D-102) and they hold in production from 2026-07-27T23:36Z onward,
   * so they take windowOf's interpretable default.
   */
  it('passes the producer-v3 rollout series with no shipped exemption', () => {
    const blocked = { 'acted-on-stale-or-wrong-value': w(false) };
    const report = ratchetPlaneSeries({
      series: [
        windowOf('2026-07-27T13:18:00Z', { ...blocked, 'intent-action-divergence-stamped': w(false) }),
        windowOf('2026-07-27T14:34:00Z', blocked),
        windowOf('2026-09-04T18:30:21.818Z', {
          'acted-on-stale-or-wrong-value': w(true, {
            measuredAt: '2026-09-04T18:30:21.818Z',
            fillRate: 0.0014,
            zeroReason: null,
          }),
        }),
      ],
    });
    expect(report.failures).toHaveLength(0);
    expect(report.exempt).toHaveLength(0);
    expect(report.rows.find((r) => r.metric === 'acted-on-stale-or-wrong-value')).toMatchObject({
      verdict: 'holding',
      interpretableNow: true,
      lastInterpretableAt: '2026-09-04T18:30:21.818Z',
    });
    expect(report.highWaterCount).toBe(7);
    expect(report.currentCount).toBe(7);
  });

  /**
   * ⚠ RETIRING A METRIC MUST NOT BE A WAY TO LAUNDER ONE.
   *
   * D-103 retired `conflicting-assumption-incidence` and deliberately KEPT
   * `acted-on-stale-or-wrong-value`, whose producer was equally silent then. The
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
    const afterUnrelated = ratchetPlaneSeries({
      series,
      closedGaps: new Set(['WI-6465']),
      gaps: STALE_ACTION_GAP,
    });
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
    const afterClose = ratchetPlaneSeries({
      series,
      closedGaps: new Set(['WI-6545']),
      gaps: STALE_ACTION_GAP,
    });
    expect(afterClose.failures).toHaveLength(0);
    expect(afterClose.exempt.map((r) => r.metric)).toEqual(['acted-on-stale-or-wrong-value']);
  });

  /** Closing WI-6548 must make the same series RED, not quietly retire the evidence. */
  it('turns the exempt metric into a failure the moment WI-6548 closes', () => {
    const blocked = { 'acted-on-stale-or-wrong-value': w(false) };
    const series = [windowOf('2026-07-27T14:34:00Z', blocked), windowOf('2026-07-27T17:05:00Z', blocked)];

    expect(ratchetPlaneSeries({ series, gaps: STALE_ACTION_GAP }).failures).toHaveLength(0);

    const afterClose = ratchetPlaneSeries({
      series,
      closedGaps: new Set(['WI-6548']),
      gaps: STALE_ACTION_GAP,
    });
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

  it('ships no gap after producer v3, while injected gap fixtures still name real ids', () => {
    expect(METRIC_KNOWN_GAPS).toEqual({});
    for (const [metric, ref] of Object.entries(STALE_ACTION_GAP)) {
      expect(PLANE_METRIC_IDS).toContain(metric as PlaneMetricId);
      expect(ref).toMatch(/^WI-\d+$/);
    }
  });
});
