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
  refreshTripwireCurrents,
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

  it('reports unchanged (and writes nothing) when the value already matches', () => {
    const already: GoalTripwireLike[] = [
      { metric: 'spend_cents', label: 'spend', threshold: 500, current: 310, unit: 'cents' },
    ];
    const res = refreshTripwireCurrents(already, { measuredSpentCents: 310, goalAgeMs: 0 });

    expect(res.advanced).toBe(0);
    expect(res.changed).toBe(false);
    expect(res.outcomes[0]?.reason).toBe('unchanged');
    // Referential identity lets the caller skip the UPDATE entirely.
    expect(res.next).toBe(already);
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
      'spend_usd',
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
});
