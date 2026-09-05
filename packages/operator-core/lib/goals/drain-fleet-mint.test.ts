/**
 * P-001 (goal-mode-design-intent-hardening-2026-08-16) — the drain-fleet lane's
 * SHAPE guards.
 *
 * The load-bearing invariant is D-005: the auto-minted lane is goal-scoped via
 * the POSITIVE `{field:'goal', op:'='}` leaf, never a negation and never
 * pot-wide. A positive lane may intentionally match zero during goal setup;
 * the replacement guard covers dropping that fence later. Falsifiability is
 * proven the tier-1 way (no tree mutation): the
 * deliberately-WRONG lane shapes live permanently in this file as controls the
 * scope check must reject, beside a calibration case the real minted spec must
 * pass — so a scope check that "accepts everything" and a mint that "scopes
 * nothing" both fail here.
 *
 * Run: cd packages/operator-core && npx vitest run lib/goals/drain-fleet-mint.test.ts
 */
import { describe, expect, it } from 'vitest';

import { validateClaimSpec } from '../scheduler/claim-spec';
import { claimSpecIsGoalScoped } from '../system-health/goal-drain-fleet-watchdog';
import { buildGoalDrainClaimSpec, drainFleetSlugForGoal } from './drain-fleet-mint';

describe('drainFleetSlugForGoal', () => {
  it('is goal-drain-<goalId> when the id fits the slug budget', () => {
    expect(drainFleetSlugForGoal('ship-paid-app-3f9a1c')).toBe('goal-drain-ship-paid-app-3f9a1c');
  });

  it('never exceeds the 60-char fleet-slug budget', () => {
    // goalId() caps its stem at 48 chars + '-' + 6 hex = 55; prefix pushes past 60.
    const long = `${'x'.repeat(48)}-3f9a1c`;
    expect(drainFleetSlugForGoal(long).length).toBeLessThanOrEqual(60);
  });

  it('trims the READABLE stem, preserving the collision-resistant tail', () => {
    // Two goals whose long titles share a 48-char stem differ ONLY in the hex
    // tail — a plain right-truncation would map both to the same fleet.
    const a = drainFleetSlugForGoal(`${'x'.repeat(48)}-aaaaaa`);
    const b = drainFleetSlugForGoal(`${'x'.repeat(48)}-bbbbbb`);
    expect(a).not.toBe(b);
    expect(a.endsWith('-aaaaaa')).toBe(true);
    expect(b.endsWith('-bbbbbb')).toBe(true);
  });
});

describe('buildGoalDrainClaimSpec — the D-005 lane', () => {
  it('is a VALID spec — validateClaimSpec accepts it verbatim', () => {
    const v = validateClaimSpec(buildGoalDrainClaimSpec('ship-paid-app-3f9a1c'));
    expect(v.errors).toEqual([]);
    expect(v.ok).toBe(true);
  });

  it('scopes with the POSITIVE = leaf on the goal field — the WI-37711 rule', () => {
    const spec = buildGoalDrainClaimSpec('g-1') as { view: { filter: unknown } };
    expect(spec.view.filter).toEqual({ field: 'goal', op: '=', value: 'g-1' });
  });

  it('CALIBRATION: the minted spec passes the watchdog scope check for ITS goal and no other', () => {
    const spec = buildGoalDrainClaimSpec('g-1');
    expect(claimSpecIsGoalScoped(spec, 'g-1')).toBe(true);
    expect(claimSpecIsGoalScoped(spec, 'g-2')).toBe(false);
  });

  /**
   * CONTROLS — the wrong lane shapes, kept permanently so the guard pair stays
   * falsifiable. Each is a spec a plausible-but-broken mint could produce; the
   * watchdog scope check MUST reject every one, or an unscoped drain fleet
   * would read as healthy (the exact pre-D-005 gap).
   */
  it('CONTROL: the NEGATIVE form is not an ownership fence and must not count as scoped', () => {
    const negated = {
      ...buildGoalDrainClaimSpec('g-1'),
      view: { filter: { not: { field: 'goal', op: '=', value: 'g-1' } } },
    };
    expect(claimSpecIsGoalScoped(negated, 'g-1')).toBe(false);
  });

  it('CONTROL: a pot-wide lane (the DEFAULT_CLAIM_SPEC shape) must not count as scoped', () => {
    const potWide = { ...buildGoalDrainClaimSpec('g-1'), view: {} };
    expect(claimSpecIsGoalScoped(potWide, 'g-1')).toBe(false);
  });

  it('CONTROL: a lane scoped to a DIFFERENT field is not goal-scoped either', () => {
    const planScoped = {
      ...buildGoalDrainClaimSpec('g-1'),
      view: { filter: { field: 'plan', op: '=', value: 'g-1' } },
    };
    expect(claimSpecIsGoalScoped(planScoped, 'g-1')).toBe(false);
  });
});
