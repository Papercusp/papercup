/**
 * Pins each tripwire metric to the POPULATION its `current` measured
 * (spend-attribution…-2026-09-04 P-004).
 *
 * A breach reason is attached to a kill, so it is the worst possible place for
 * a bare number. `spend_usd 62 reached threshold 100` reads as "this goal has
 * spent $62"; it is in fact a statement about the goal's POT SUBSET, because
 * the spend resolvers are fed `measuredSpentCents`, which the rollup sets from
 * the pot leg alone and never from the diagnostic session leg.
 *
 * `METRIC_POPULATION` is therefore code-describing metadata about RESOLVERS —
 * the repo's derived-truth ladder says that will drift unless something fails
 * when it does. This is that something: add a resolver without a population and
 * the readout would silently go back to an unlabelled number, so this test
 * fails instead.
 */
import { describe, expect, it } from 'vitest';
import {
  GENERICALLY_MEASURABLE_METRICS,
  METRIC_POPULATION,
  populationForMetric,
} from './tripwire-refresh';

describe('tripwire metric populations — every resolved metric names what it measured', () => {
  it('covers EVERY generically-measurable metric, with no orphans in either direction', () => {
    // The load-bearing assertion. A new resolver with no population entry is
    // exactly the drift this file exists to catch.
    const resolved = [...GENERICALLY_MEASURABLE_METRICS].sort();
    const labelled = Object.keys(METRIC_POPULATION).sort();
    expect(labelled).toEqual(resolved);
  });

  it('labels the spend metrics with the POT scope — the leg that actually feeds them', () => {
    // Not cosmetic: naming these 'goal spend' would restate the very error
    // P-004 exists to stop. Both spend resolvers read measuredSpentCents, which
    // refreshGoalTripwires sets from `rollup.pot`, never from the session leg.
    expect(populationForMetric('spend_usd')).toBe('inside-goal-pots:authoritative');
    expect(populationForMetric('spend_cents')).toBe('inside-goal-pots:authoritative');
  });

  it('does NOT give the time metrics a spend scope', () => {
    // days/hours_elapsed derive from goalAgeMs, not from any spend leg. Handing
    // them a spend population would be a different false label, not a fix.
    expect(populationForMetric('days_elapsed')).toBe('goal-lifetime');
    expect(populationForMetric('hours_elapsed')).toBe('goal-lifetime');
  });

  it('CONTROL: the coverage comparison actually detects an unlabelled resolver', () => {
    // The test above is only worth having if it FAILS when someone adds a
    // resolver and forgets the population. Proving that by mutating the real
    // module would race git-sync (it sweeps the whole tree on a timer and would
    // commit the mutant), so the control is permanent and synthetic instead:
    // run the identical comparison against a resolver set with one extra entry.
    const resolvedPlusNew = [...GENERICALLY_MEASURABLE_METRICS, 'newly_added_metric'].sort();
    const labelled = Object.keys(METRIC_POPULATION).sort();
    expect(labelled).not.toEqual(resolvedPlusNew);

    // And the opposite drift — a population left behind after its resolver was
    // removed — is caught by the same equality, in the other direction.
    const labelledPlusOrphan = [...labelled, 'orphaned_population'].sort();
    expect(labelledPlusOrphan).not.toEqual([...GENERICALLY_MEASURABLE_METRICS].sort());
  });

  it('CALIBRATION: the real sets are non-empty, so the equality is not vacuous', () => {
    // Two empty arrays are equal. Without this, a refactor that emptied both
    // would turn the coverage test into a permanent, silent pass.
    expect(GENERICALLY_MEASURABLE_METRICS.length).toBeGreaterThan(0);
    expect(Object.keys(METRIC_POPULATION).length).toBeGreaterThan(0);
  });

  it('returns null for a metric this module does not resolve, rather than inventing one', () => {
    // A declared evidence binding carries its own meaning. Fabricating a label
    // for it here would be the same drift in the opposite direction.
    expect(populationForMetric('some_declared_evidence_metric')).toBeNull();
    expect(populationForMetric('')).toBeNull();
  });
});
