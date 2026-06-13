/**
 * policy.test.ts — pure unit tests for the B-03 per-category gate arithmetic
 * (queen-autonomy-policy-2026-06-13). No DB.
 *
 * The risk-tier / ceiling VOCABULARY lives in @papercusp/plan-parser (B-01's
 * risk-model.ts) and is tested there; this file covers the B-03 composition over
 * it: the ceiling rank/min helpers, effectiveCeiling (lock ⇒ never-auto,
 * graduation clamp), and the D-007 behavior-neutral invariant — EVERY category's
 * default policy is never-auto.
 */
import { describe, expect, it } from 'vitest';

import { AUTONOMY_CEILINGS, RISK_TIERS } from '@papercusp/plan-parser';
import {
  type AutonomyCategoryPolicy,
  autoEverAllowed,
  ceilingRank,
  defaultPolicyFor,
  effectiveCeiling,
  isAutonomyCeiling,
  minCeiling,
} from './policy';
import { AUTONOMY_CATEGORY_IDS, PROTECTED_CATEGORIES, isProtectedCategory } from './categories';

describe('ceiling helpers over the canonical AUTONOMY_CEILINGS', () => {
  it('AUTONOMY_CEILINGS = never-auto + the 5 risk tiers, ranked 0..5', () => {
    expect(AUTONOMY_CEILINGS).toEqual(['never-auto', ...RISK_TIERS]);
    expect(ceilingRank('never-auto')).toBe(0);
    expect(ceilingRank('trivial')).toBe(1);
    expect(ceilingRank('critical')).toBe(5);
  });

  it('isAutonomyCeiling guards the vocabulary (and rejects the old `none` spelling)', () => {
    expect(isAutonomyCeiling('never-auto')).toBe(true);
    expect(isAutonomyCeiling('critical')).toBe(true);
    expect(isAutonomyCeiling('none')).toBe(false);
    expect(isAutonomyCeiling('ludicrous')).toBe(false);
  });

  it('minCeiling picks the lower-autonomy ceiling', () => {
    expect(minCeiling('low', 'high')).toBe('low');
    expect(minCeiling('critical', 'never-auto')).toBe('never-auto');
    expect(minCeiling('moderate', 'moderate')).toBe('moderate');
  });
});

describe('effectiveCeiling', () => {
  const base: AutonomyCategoryPolicy = {
    category: 'inbox-triage',
    ceiling: 'high',
    locked: false,
    graduatedLevel: 'low',
    thresholdOverrides: {},
    ownerOverride: null,
  };

  it('is min(ceiling, graduatedLevel) when unlocked', () => {
    expect(effectiveCeiling(base)).toBe('low');
    expect(effectiveCeiling({ ...base, graduatedLevel: 'high' })).toBe('high');
    expect(effectiveCeiling({ ...base, ceiling: 'low', graduatedLevel: 'high' })).toBe('low');
  });

  it('is never-auto when locked, regardless of ceiling/graduation (D-005)', () => {
    expect(
      effectiveCeiling({ ...base, locked: true, ceiling: 'critical', graduatedLevel: 'critical' }),
    ).toBe('never-auto');
  });

  it('autoEverAllowed is false at the never-auto floor, true once effective > never-auto', () => {
    expect(autoEverAllowed({ ...base, ceiling: 'never-auto', graduatedLevel: 'never-auto' })).toBe(
      false,
    );
    expect(autoEverAllowed(base)).toBe(true);
    expect(autoEverAllowed({ ...base, locked: true })).toBe(false);
  });
});

describe('defaultPolicyFor + the D-007 behavior-neutral invariant', () => {
  it('protected categories default to locked; the rest default unlocked', () => {
    for (const id of AUTONOMY_CATEGORY_IDS) {
      const d = defaultPolicyFor(id);
      expect(d.locked).toBe(isProtectedCategory(id));
      expect(d.ceiling).toBe('never-auto');
      expect(d.graduatedLevel).toBe('never-auto');
      expect(d.ownerOverride).toBeNull();
    }
    const lockedByDefault = AUTONOMY_CATEGORY_IDS.filter((id) => defaultPolicyFor(id).locked);
    expect(new Set(lockedByDefault)).toEqual(new Set(PROTECTED_CATEGORIES));
  });

  it('EVERY category ships never-auto (effectiveCeiling never-auto) — identical to today', () => {
    for (const id of AUTONOMY_CATEGORY_IDS) {
      expect(effectiveCeiling(defaultPolicyFor(id))).toBe('never-auto');
      expect(autoEverAllowed(defaultPolicyFor(id))).toBe(false);
    }
  });
});
