/**
 * Tests for tripwire-refresh (plan blender-goal-amendment-rail-2026-08-19 P-004).
 *
 * The fixtures are the LIVE shapes measured 2026-08-19, not invented ones — the
 * two active goals that carried tripwires, plus the domain metrics that sat
 * beside them. Keeping the real shapes here is what makes the two policy rules
 * (never invent, never promote a floor) falsifiable against production data
 * rather than against a convenient example.
 */
import { describe, expect, it } from 'vitest';
import {
  GENERICALLY_MEASURABLE_METRICS,
  breachedTripwires,
  evidenceKey,
  isDerived,
  refreshTripwireCurrents,
  unmeasuredTripwireAdvisories,
  type GoalTripwireLike,
  type TripwireMeasurement,
} from './tripwire-refresh';

/** the-papercusp-desktop-app-is-verified-working-in-7273ca, verbatim. */
const DESKTOP_GOAL_TRIPWIRES: GoalTripwireLike[] = [
  { metric: 'hours_since_verdict_advance', label: 'Hours since any per-VM verdict advanced', threshold: 48, unit: 'h' },
  { metric: 'spend_usd', label: 'Measured child-fleet spend', threshold: 50, unit: 'usd' },
];

/** the-gui-chat-surface-is-ready-to-ship-to-strange-8fa0ed, verbatim. */
const GUI_GOAL_TRIPWIRES: GoalTripwireLike[] = [
  { metric: 'days_elapsed', label: 'Day of 14', threshold: 14, unit: 'days' },
  { metric: 'spend_usd', label: 'Spend of $200 ceiling', threshold: 200, unit: 'usd' },
];

const NO_MEASUREMENT: TripwireMeasurement = { measuredSpentCents: null, goalAgeMs: 0 };

describe('refreshTripwireCurrents', () => {
  it('advances spend_usd from the measured cents snapshot — the live defect', () => {
    // The exact live numbers: metadata.spentCents 34618 (measured, 97 samples,
    // 0 unpriced) against a declared $50 ceiling, showing as `current: null`.
    const res = refreshTripwireCurrents(DESKTOP_GOAL_TRIPWIRES, {
      measuredSpentCents: 34618,
      goalAgeMs: 3 * 86_400_000,
    });

    expect(res.changed).toBe(true);
    expect(res.advanced).toBe(1);

    const spend = res.next.find((t) => t.metric === 'spend_usd');
    expect(spend?.current).toBe(346.18);

    // ...and that is a 6.9x breach that was invisible while current was null.
    expect(breachedTripwires(res.next)).toEqual([
      { metric: 'spend_usd', current: 346.18, threshold: 50, unit: 'usd' },
    ]);
  });

  describe('window-suffixed spend metrics (WI-10004419)', () => {
    /** work-on-everything-fresh-grading-and-improvement-60d3a8, verbatim as measured 2026-09-30. */
    const WEEKLY_CEILING: GoalTripwireLike[] = [
      {
        metric: 'spend_usd_7d',
        label: 'Trailing-7d measured spend vs $500/wk ceiling',
        threshold: 500,
        unit: 'usd',
        current: 34.91,
      },
    ];
    const WEEK_SEC = 604_800;

    it('advances spend_usd_7d from a 7d rollup — the live defect (frozen at 34.91 vs 102.78 measured)', () => {
      const res = refreshTripwireCurrents(WEEKLY_CEILING, {
        measuredSpentCents: 10278,
        measuredWindowSec: WEEK_SEC,
        goalAgeMs: 30 * 86_400_000,
      });
      expect(res.outcomes[0]).toMatchObject({ metric: 'spend_usd_7d', before: 34.91, after: 102.78, reason: 'advanced' });
      expect(res.next[0]?.current).toBe(102.78);
      expect(isDerived(res.next[0] as GoalTripwireLike)).toBe(true);
    });

    it('resolves spend_cents_7d in cents over the same window', () => {
      const res = refreshTripwireCurrents([{ metric: 'spend_cents_7d', label: 'c', threshold: 50_000 }], {
        measuredSpentCents: 10278.4,
        measuredWindowSec: WEEK_SEC,
        goalAgeMs: 0,
      });
      expect(res.next[0]?.current).toBe(10278);
    });

    it('stays UNMEASURED when the rollup window differs from the suffix — never relabels a population', () => {
      for (const measuredWindowSec of [86_400, 2_592_000, null, undefined]) {
        const res = refreshTripwireCurrents(WEEKLY_CEILING, {
          measuredSpentCents: 10278,
          measuredWindowSec,
          goalAgeMs: 0,
        });
        expect(res.outcomes[0]?.reason).toBe('unmeasured');
        expect(res.next[0]).toBe(WEEKLY_CEILING[0]);
      }
    });

    it('stays unmeasured on a floor rollup even with the right window (rule 2)', () => {
      const res = refreshTripwireCurrents(WEEKLY_CEILING, {
        measuredSpentCents: null,
        measuredWindowSec: WEEK_SEC,
        goalAgeMs: 0,
      });
      expect(res.outcomes[0]?.reason).toBe('unmeasured');
      expect(res.next[0]?.current).toBe(34.91);
    });

    it('makes a measured weekly breach breach-eligible', () => {
      const res = refreshTripwireCurrents(WEEKLY_CEILING, {
        measuredSpentCents: 61_000,
        measuredWindowSec: WEEK_SEC,
        goalAgeMs: 0,
      });
      expect(breachedTripwires(res.next)).toEqual([
        { metric: 'spend_usd_7d', current: 610, threshold: 500, unit: 'usd' },
      ]);
    });
  });

  it('RULE 1: leaves a metric with no generic resolver byte-identical', () => {
    const res = refreshTripwireCurrents(DESKTOP_GOAL_TRIPWIRES, {
      measuredSpentCents: 34618,
      goalAgeMs: 3 * 86_400_000,
    });

    const domain = res.next.find((t) => t.metric === 'hours_since_verdict_advance');
    // Not merely equal — the SAME object: nothing was rewritten.
    expect(domain).toBe(DESKTOP_GOAL_TRIPWIRES[0]);
    expect(domain?.current).toBeUndefined();
    expect(res.outcomes.find((o) => o.metric === 'hours_since_verdict_advance')?.reason).toBe(
      'no-resolver',
    );
  });

  it('RULE 2: an unmeasured (floor) rollup advances no spend tripwire', () => {
    // the-gui-chat-surface had 8 of 17 samples unpriced => measured:false, so the
    // caller passes null even though a 1762c total exists.
    const res = refreshTripwireCurrents(GUI_GOAL_TRIPWIRES, {
      measuredSpentCents: null,
      goalAgeMs: 8 * 86_400_000,
    });

    const spend = res.next.find((t) => t.metric === 'spend_usd');
    expect(spend?.current).toBeUndefined();
    expect(res.outcomes.find((o) => o.metric === 'spend_usd')?.reason).toBe('unmeasured');

    // The time metric beside it still advances — one unmeasurable metric does
    // not stall the rest of the goal's scoring.
    expect(res.next.find((t) => t.metric === 'days_elapsed')?.current).toBe(8);
    expect(res.advanced).toBe(1);
  });

  it('RULE 2 is one-directional: an unmeasured pass never CLEARS a scored value', () => {
    const scored: GoalTripwireLike[] = [
      { metric: 'spend_usd', label: 'spend', threshold: 50, current: 346.18, unit: 'usd' },
    ];
    const res = refreshTripwireCurrents(scored, NO_MEASUREMENT);

    expect(res.next[0]?.current).toBe(346.18);
    expect(res.changed).toBe(false);
    expect(res.outcomes[0]?.reason).toBe('unmeasured');
  });

  it('resolves by METRIC NAME even when the unit label disagrees', () => {
    // A goal author who mislabels the unit still gets the metric's contract.
    const mislabelled: GoalTripwireLike[] = [
      { metric: 'spend_cents', label: 'spend', threshold: 500, unit: 'usd' },
    ];
    const res = refreshTripwireCurrents(mislabelled, {
      measuredSpentCents: 310,
      goalAgeMs: 0,
    });
    expect(res.next[0]?.current).toBe(310);
  });

  it('reports unchanged (and writes nothing) when the value AND its stamp already match', () => {
    const already: GoalTripwireLike[] = [
      {
        metric: 'spend_cents',
        label: 'spend',
        threshold: 500,
        current: 310,
        unit: 'cents',
        measuredBy: { source: 'resolver:spend_cents', atMs: 1_000, value: 310 },
      },
    ];
    const res = refreshTripwireCurrents(already, { measuredSpentCents: 310, goalAgeMs: 0 });

    expect(res.advanced).toBe(0);
    expect(res.restamped).toBe(0);
    expect(res.changed).toBe(false);
    expect(res.outcomes[0]?.reason).toBe('unchanged');
    // Referential identity lets the caller skip the UPDATE entirely.
    expect(res.next).toBe(already);
  });

  it('STAMPS a correct-but-unstamped reading, so it stops reading as hand-set', () => {
    // The value needs no correction, but its PROVENANCE does: without a stamp
    // this is indistinguishable from a number an agent typed. That is worth the
    // one write, which is why a re-stamp counts as `changed`.
    const unstamped: GoalTripwireLike[] = [
      { metric: 'spend_cents', label: 'spend', threshold: 500, current: 310, unit: 'cents' },
    ];
    const res = refreshTripwireCurrents(unstamped, {
      measuredSpentCents: 310,
      goalAgeMs: 0,
      nowMs: 4_242,
    });

    expect(res.advanced).toBe(0);
    expect(res.restamped).toBe(1);
    expect(res.changed).toBe(true);
    expect(res.next).not.toBe(unstamped);
    expect(res.next[0]?.current).toBe(310);
    expect(res.next[0]?.measuredBy).toEqual({
      source: 'resolver:spend_cents',
      atMs: 4_242,
      value: 310,
    });
    expect(isDerived(res.next[0]!)).toBe(true);
  });

  it('rounds spend_usd to cents precision rather than emitting float noise', () => {
    const t: GoalTripwireLike[] = [{ metric: 'spend_usd', label: 's', threshold: 1, unit: 'usd' }];
    expect(refreshTripwireCurrents(t, { measuredSpentCents: 1, goalAgeMs: 0 }).next[0]?.current).toBe(
      0.01,
    );
    expect(refreshTripwireCurrents(t, { measuredSpentCents: 7, goalAgeMs: 0 }).next[0]?.current).toBe(
      0.07,
    );
  });

  it('floors elapsed metrics and clamps a negative age to zero', () => {
    const t: GoalTripwireLike[] = [
      { metric: 'days_elapsed', label: 'd', threshold: 14 },
      { metric: 'hours_elapsed', label: 'h', threshold: 48 },
    ];
    const res = refreshTripwireCurrents(t, {
      measuredSpentCents: null,
      goalAgeMs: 2 * 86_400_000 + 5 * 3_600_000,
    });
    expect(res.next[0]?.current).toBe(2);
    expect(res.next[1]?.current).toBe(53);

    // A clock skew must not produce a negative elapsed reading.
    const skewed = refreshTripwireCurrents(t, { measuredSpentCents: null, goalAgeMs: -5_000 });
    expect(skewed.next[0]?.current).toBe(0);
    expect(skewed.next[1]?.current).toBe(0);
  });

  it('treats a null/absent/non-finite stored current as unscored', () => {
    const t: GoalTripwireLike[] = [
      { metric: 'spend_cents', label: 's', threshold: 500, current: null },
      { metric: 'days_elapsed', label: 'd', threshold: 14, current: Number.NaN },
    ];
    const res = refreshTripwireCurrents(t, { measuredSpentCents: 42, goalAgeMs: 86_400_000 });
    expect(res.outcomes.every((o) => o.before === null)).toBe(true);
    expect(res.next[0]?.current).toBe(42);
    expect(res.next[1]?.current).toBe(1);
  });

  it('handles null / empty tripwire sets without writing', () => {
    for (const empty of [null, undefined, []]) {
      const res = refreshTripwireCurrents(empty, { measuredSpentCents: 100, goalAgeMs: 0 });
      expect(res.changed).toBe(false);
      expect(res.advanced).toBe(0);
      expect(res.next).toEqual([]);
    }
  });

  it('exposes exactly the metrics it can resolve, so the vocabulary is auditable', () => {
    expect(GENERICALLY_MEASURABLE_METRICS).toEqual([
      'days_elapsed',
      'hours_elapsed',
      'spend_cents',
      'spend_cents_24h',
      'spend_cents_30d',
      'spend_cents_7d',
      'spend_usd',
      'spend_usd_24h',
      'spend_usd_30d',
      'spend_usd_7d',
    ]);
    // The domain metrics measured live are deliberately NOT in the set.
    for (const domain of [
      'hours_since_verdict_advance',
      'species_covered',
      'charts_rendered',
      'site_http_status',
      'open_goal_items',
    ]) {
      expect(GENERICALLY_MEASURABLE_METRICS).not.toContain(domain);
    }
  });
});

describe('breachedTripwires', () => {
  it('reports at-or-past threshold, and stays silent on unscored tripwires', () => {
    const t: GoalTripwireLike[] = [
      { metric: 'spend_usd', label: 's', threshold: 50, current: 50, unit: 'usd' }, // at
      { metric: 'days_elapsed', label: 'd', threshold: 14, current: 13 }, // under
      { metric: 'hours_since_verdict_advance', label: 'h', threshold: 48 }, // unscored
    ];
    expect(breachedTripwires(t)).toEqual([
      { metric: 'spend_usd', current: 50, threshold: 50, unit: 'usd' },
    ]);
  });

  it('never reports a breach it cannot substantiate', () => {
    // An unscored tripwire is not a pass and not a breach — it is a blank, which
    // is the whole condition P-004 exists to remove. It must never render as OK.
    expect(breachedTripwires(DESKTOP_GOAL_TRIPWIRES)).toEqual([]);
  });

  it('never treats an executor-owned decreasing metric as a platform-measured breach', () => {
    // Regression for EI-21120596206391308: this exact shape falsely killed a
    // live goal because the generic >= comparison read "2 reached 0". The
    // platform has no resolver for openReleaseWalls, so only the goal executor
    // may decide whether/how its decreasing value trips the kill criterion.
    const executorOwned: GoalTripwireLike[] = [
      {
        metric: 'openReleaseWalls',
        label: 'Signed release walls still open',
        threshold: 0,
        current: 2,
        unit: 'walls',
      },
    ];

    expect(breachedTripwires(executorOwned)).toEqual([]);
  });
});

/**
 * THE FALSIFIER (EI-21605510614702802 / WI-2039711).
 *
 * The claim under test is not "the platform can measure things" — P-004 already
 * established that. It is the stronger one this work exists to make true: a
 * stale hand-set value CANNOT persist while passing for a measurement. Each
 * test below is written to fail if provenance were reduced to a boolean flag or
 * a mere "a stamp exists" check, which is how this would most plausibly regress.
 */
describe('provenance — a hand-set value can never pass for a measurement', () => {
  /**
   * FALSIFIABILITY CONTROL. A guard test that has never failed is a guard nobody
   * has tested, and the way this one would most plausibly regress is someone
   * "simplifying" the value comparison in `isDerived` down to a presence check —
   * which still passes every happy-path test above. Rather than mutate the
   * shared tree to prove otherwise (that races the git-sync sweep), the wrong
   * implementation lives here permanently as a control, exactly as the repo's
   * mutation-probe guidance prescribes for an imported module.
   */
  const presenceOnlyIsDerived = (t: GoalTripwireLike): boolean => !!t.measuredBy;

  it('DISCRIMINATES against a presence-only stamp check — the likely regression', () => {
    const tampered: GoalTripwireLike = {
      metric: 'spend_usd',
      label: 'spend',
      threshold: 50,
      current: 12,
      measuredBy: { source: 'resolver:spend_usd', atMs: 1_000, value: 346.18 },
    };

    // The control is FOOLED — it calls a hand-edited number a measurement...
    expect(presenceOnlyIsDerived(tampered)).toBe(true);
    // ...and the real implementation is not. If these two ever agree here, the
    // comparison has been weakened and this test is what fails.
    expect(isDerived(tampered)).toBe(false);

    // CALIBRATION: both must agree on a genuinely derived reading, or the
    // discrimination above could be an artifact of a broken control instead.
    const honest: GoalTripwireLike = { ...tampered, current: 346.18 };
    expect(presenceOnlyIsDerived(honest)).toBe(true);
    expect(isDerived(honest)).toBe(true);
  });

  it('reports a hand-set reading as NOT derived, however plausible the number', () => {
    // Verbatim shape from goal 9425fe, the filing's own example.
    const handSet: GoalTripwireLike[] = [
      { metric: 'surfaces_verified', label: 'Surfaces verified', threshold: 30, current: 0 },
    ];
    expect(isDerived(handSet[0]!)).toBe(false);

    // ...and the refresh leaves it alone (rule 1) rather than inventing a stamp.
    const res = refreshTripwireCurrents(handSet, { measuredSpentCents: 34618, goalAgeMs: 0 });
    expect(res.outcomes[0]?.reason).toBe('no-resolver');
    expect(res.next[0]?.measuredBy).toBeUndefined();
    expect(isDerived(res.next[0]!)).toBe(false);
  });

  it('VOIDS a stamp whose value no longer matches — the hand-edit-after-measurement case', () => {
    /*
     * The failure this closes: the platform measures 346.18 and stamps it, then
     * an agent hand-writes a flattering 12 over the top via goals:update. If the
     * stamp were merely PRESENT-checked, the edited number would inherit the
     * measurement's credibility. Comparing `value` is what makes that impossible.
     */
    const tampered: GoalTripwireLike = {
      metric: 'spend_usd',
      label: 'spend',
      threshold: 50,
      current: 12,
      measuredBy: { source: 'resolver:spend_usd', atMs: 1_000, value: 346.18 },
    };
    expect(isDerived(tampered)).toBe(false);

    // A stamp that DOES vouch for the stored number is the only derived case.
    expect(isDerived({ ...tampered, current: 346.18 })).toBe(true);
  });

  it('does not treat a malformed or partial stamp as provenance', () => {
    const base = { metric: 'spend_usd', label: 's', threshold: 50, current: 10 } as const;
    // No stamp at all.
    expect(isDerived({ ...base })).toBe(false);
    // Explicitly null (how a cleared jsonb field arrives).
    expect(isDerived({ ...base, measuredBy: null })).toBe(false);
    // A non-finite value can never equal `current`, so it must not vouch for it.
    expect(
      isDerived({ ...base, measuredBy: { source: 'resolver:spend_usd', atMs: 1, value: Number.NaN } }),
    ).toBe(false);
    // A reading that is itself absent cannot be derived, stamp or not.
    expect(
      isDerived({
        metric: 'spend_usd',
        label: 's',
        threshold: 50,
        measuredBy: { source: 'resolver:spend_usd', atMs: 1, value: 10 },
      }),
    ).toBe(false);
  });

  it('stamps the SOURCE, so a reader can tell which evidence produced the number', () => {
    const res = refreshTripwireCurrents(
      [{ metric: 'spend_usd', label: 's', threshold: 50 }],
      { measuredSpentCents: 34618, goalAgeMs: 0, nowMs: 777 },
    );
    expect(res.next[0]?.measuredBy).toEqual({
      source: 'resolver:spend_usd',
      atMs: 777,
      value: 346.18,
    });
  });

  it('leaves a stale stamp ORIGINAL when the measurement stops resolving', () => {
    // Rule 2 is one-directional: the number survives an unmeasured pass. Its
    // stamp must NOT be refreshed to `now` on that pass, or a source that has
    // silently stopped reporting would keep looking freshly measured forever —
    // which is the "stale value persists" failure wearing a stamp.
    const scored: GoalTripwireLike[] = [
      {
        metric: 'spend_usd',
        label: 'spend',
        threshold: 50,
        current: 346.18,
        measuredBy: { source: 'resolver:spend_usd', atMs: 1_000, value: 346.18 },
      },
    ];
    const res = refreshTripwireCurrents(scored, {
      measuredSpentCents: null,
      goalAgeMs: 0,
      nowMs: 9_999_999,
    });

    expect(res.changed).toBe(false);
    expect(res.outcomes[0]?.reason).toBe('unmeasured');
    expect(res.next[0]?.measuredBy?.atMs).toBe(1_000);
  });
});

describe('declared evidence bindings', () => {
  const bound: GoalTripwireLike[] = [
    {
      metric: 'surfaces_verified',
      label: 'Surfaces verified',
      threshold: 30,
      current: 0,
      evidence: { kind: 'work-item-count', ref: 'surfaces-done' },
    },
  ];

  it('advances a metric the platform has no built-in resolver for', () => {
    const res = refreshTripwireCurrents(bound, {
      measuredSpentCents: null,
      goalAgeMs: 0,
      nowMs: 55,
      evidence: { 'work-item-count:surfaces-done': 17 },
    });

    expect(res.advanced).toBe(1);
    expect(res.next[0]?.current).toBe(17);
    expect(res.next[0]?.measuredBy).toEqual({
      source: 'evidence:work-item-count:surfaces-done',
      atMs: 55,
      value: 17,
    });
    expect(isDerived(res.next[0]!)).toBe(true);
  });

  it('advances NOTHING when the caller supplied no value for the binding (rule 2)', () => {
    const absent: Array<Readonly<Record<string, number | null>> | undefined> = [
      undefined,
      {},
      { 'work-item-count:surfaces-done': null },
    ];
    for (const evidence of absent) {
      const res = refreshTripwireCurrents(bound, {
        measuredSpentCents: null,
        goalAgeMs: 0,
        evidence,
      });
      expect(res.changed).toBe(false);
      expect(res.outcomes[0]?.reason).toBe('unmeasured');
      // Crucially it stays hand-set rather than acquiring an unearned stamp.
      expect(isDerived(res.next[0]!)).toBe(false);
    }
  });

  it('REFUSES to let a binding capture a platform-owned metric', () => {
    /*
     * A goal author who declares `spend_usd` bound to evidence of their choosing
     * must not be able to redirect the spend reading: spend truth comes from the
     * cost ledger (goal-mode-design-intent-hardening D-003). The built-in
     * resolver wins, and the binding is ignored entirely.
     */
    const hijack: GoalTripwireLike[] = [
      {
        metric: 'spend_usd',
        label: 'spend',
        threshold: 50,
        evidence: { kind: 'work-item-count', ref: 'anything' },
      },
    ];
    const res = refreshTripwireCurrents(hijack, {
      measuredSpentCents: 34618,
      goalAgeMs: 0,
      evidence: { 'work-item-count:anything': 1 },
    });

    expect(res.next[0]?.current).toBe(346.18);
    expect(res.next[0]?.measuredBy?.source).toBe('resolver:spend_usd');
  });

  it('ignores a malformed binding rather than guessing at it (rule 1)', () => {
    const malformed: GoalTripwireLike[] = [
      { metric: 'surfaces_verified', label: 's', threshold: 30, evidence: { kind: '' } },
    ];
    const res = refreshTripwireCurrents(malformed, {
      measuredSpentCents: null,
      goalAgeMs: 0,
      evidence: { ':': 5 },
    });
    expect(res.outcomes[0]?.reason).toBe('no-resolver');
    expect(res.next[0]?.current).toBeUndefined();
  });

  it('keys evidence stably, including when ref is omitted', () => {
    expect(evidenceKey({ kind: 'census', ref: 'surfaces' })).toBe('census:surfaces');
    expect(evidenceKey({ kind: 'census' })).toBe('census:');
  });

  it('does NOT make an evidence-derived metric breach-eligible', () => {
    /*
     * Deliberate, and the conservative half of this change: `breachedTripwires`
     * gates terminal kill actions, and a derived number is still not necessarily
     * a consumption-toward-a-ceiling reading (goal-mode-2026-08-07 D-022's
     * complement convention). Widening kill eligibility is a separate decision
     * with an owner-facing consequence, so provenance does not smuggle it in.
     */
    const derived: GoalTripwireLike[] = [
      {
        metric: 'surfaces_verified',
        label: 's',
        threshold: 30,
        current: 31,
        measuredBy: { source: 'evidence:work-item-count:x', atMs: 1, value: 31 },
      },
    ];
    expect(breachedTripwires(derived)).toEqual([]);
  });
});

describe('unmeasuredTripwireAdvisories — a metric that reads as measured but never will be (WI-10004424)', () => {
  const tw = (metric: string, extra: Record<string, unknown> = {}) => ({ metric, ...extra });
  const byMetric = (metrics: string[], opts?: { budgetWindowSec?: number | null }) =>
    Object.fromEntries(
      unmeasuredTripwireAdvisories(metrics.map((m) => tw(m)), opts).map((a) => [a.metric, a]),
    );

  it('flags platform-shaped names that no resolver answers, naming the nearest measured metric', () => {
    const got = byMetric(['spend_usd_week', 'spend_usd_1d', 'spend_total', 'spend_cents_monthly', 'days_left', 'hours', 'Spend_USD']);
    expect(got.spend_usd_week?.suggestedMetric).toBe('spend_usd_7d');
    expect(got.spend_usd_1d?.suggestedMetric).toBe('spend_usd_24h');
    expect(got.spend_total?.suggestedMetric).toBe('spend_usd');
    expect(got.spend_cents_monthly?.suggestedMetric).toBe('spend_cents_30d');
    expect(got.days_left?.suggestedMetric).toBe('days_elapsed');
    expect(got.hours?.suggestedMetric).toBe('hours_elapsed');
    // The resolver lookup is case-sensitive, so a case variant is unmeasured too.
    expect(got.Spend_USD?.suggestedMetric).toBe('spend_usd');
    for (const a of Object.values(got)) {
      expect(a.code).toBe('platform-shaped-metric-unresolved');
      expect(GENERICALLY_MEASURABLE_METRICS).toContain(a.suggestedMetric);
    }
  });

  it('stays SILENT on every metric a resolver actually measures (no window known)', () => {
    expect(unmeasuredTripwireAdvisories(GENERICALLY_MEASURABLE_METRICS.map((m) => tw(m)))).toEqual([]);
  });

  it('stays silent on executor-scored domain metrics, including the live fixtures', () => {
    // hours_since_verdict_advance is a real goal's domain metric (DESKTOP_GOAL_TRIPWIRES):
    // a prefix rule would tell its author to swap it for goal age, a different quantity.
    const domain = [...DESKTOP_GOAL_TRIPWIRES, ...GUI_GOAL_TRIPWIRES].map((t) => tw(t.metric));
    expect(unmeasuredTripwireAdvisories(domain)).toEqual([]);
    expect(byMetric(['spend_ads_usd', 'species_covered', 'days_until_launch_review', 'openReleaseWalls'])).toEqual({});
  });

  it('stays silent when a declared evidence binding measures the metric', () => {
    expect(
      unmeasuredTripwireAdvisories([tw('spend_usd_week', { evidence: { kind: 'saved-query', ref: 'weekly' } })]),
    ).toEqual([]);
    // A malformed binding measures nothing (rule 1), so it does not silence the advisory.
    expect(unmeasuredTripwireAdvisories([tw('spend_usd_week', { evidence: { kind: '' } })])).toHaveLength(1);
  });

  it('flags a window-suffixed spend metric whose suffix differs from the goal budget window', () => {
    const lifetime = byMetric(['spend_usd_7d', 'spend_usd'], { budgetWindowSec: null });
    expect(Object.keys(lifetime)).toEqual(['spend_usd_7d']);
    expect(lifetime.spend_usd_7d.code).toBe('spend-window-never-measured');
    expect(lifetime.spend_usd_7d.suggestedMetric).toBe('spend_usd');
    const daily = byMetric(['spend_cents_7d'], { budgetWindowSec: 86_400 });
    expect(daily.spend_cents_7d.code).toBe('spend-window-never-measured');
    expect(daily.spend_cents_7d.suggestedMetric).toBeNull();
    expect(daily.spend_cents_7d.message).toContain('604800');
  });

  it('agrees with the resolver: a window-matched metric IS measured, a mismatched one is NOT', () => {
    // Cross-check against refreshTripwireCurrents so the advisory cannot drift from
    // what the rollup actually advances.
    const weekly = { measuredSpentCents: 1234, measuredWindowSec: 604_800, goalAgeMs: 0 };
    for (const [metric, windowSec] of [['spend_usd_7d', 604_800], ['spend_usd_7d', 86_400], ['spend_usd_24h', 604_800]] as const) {
      const measured =
        refreshTripwireCurrents([{ metric, label: 'x', threshold: 1 }], { ...weekly, measuredWindowSec: windowSec })
          .outcomes[0].reason === 'advanced';
      const advised = unmeasuredTripwireAdvisories([tw(metric)], { budgetWindowSec: windowSec }).length > 0;
      expect(advised).toBe(!measured);
    }
  });

  it('tolerates null / empty / malformed input', () => {
    expect(unmeasuredTripwireAdvisories(null)).toEqual([]);
    expect(unmeasuredTripwireAdvisories(undefined)).toEqual([]);
    expect(unmeasuredTripwireAdvisories([{ metric: 42 } as unknown as { metric: string }])).toEqual([]);
  });
});
