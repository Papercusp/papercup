/**
 * policy.test.ts — pure unit tests for the autonomy risk vocabulary + the
 * per-category gate arithmetic (queen-autonomy-policy-2026-06-13 B-03). No DB.
 *
 * Covers: the risk-tier / ceiling rank order; the `risk_tier ≤ ceiling`
 * primitive; effectiveCeiling (lock ⇒ none, graduation clamp); and the D-007
 * behavior-neutral invariant — EVERY category's default policy is never-auto.
 */
import { describe, expect, it } from 'vitest';

import {
  CEILING_LEVELS,
  RISK_TIERS,
  compareRisk,
  isCeilingLevel,
  isRiskTier,
  minCeiling,
  riskRank,
  withinCeiling,
} from './risk-tiers';
import {
  type AutonomyCategoryPolicy,
  autoEverAllowed,
  defaultPolicyFor,
  effectiveCeiling,
} from './policy';
import { AUTONOMY_CATEGORY_IDS, PROTECTED_CATEGORIES, isProtectedCategory } from './categories';

describe('risk-tiers vocabulary', () => {
  it('has 5 item tiers and 6 ceiling levels (none + tiers), ranked 0..5', () => {
    expect(RISK_TIERS).toEqual(['trivial', 'low', 'moderate', 'high', 'critical']);
    expect(CEILING_LEVELS).toEqual(['none', 'trivial', 'low', 'moderate', 'high', 'critical']);
    expect(riskRank('none')).toBe(0);
    expect(riskRank('trivial')).toBe(1);
    expect(riskRank('critical')).toBe(5);
  });

  it('type guards separate item tiers from ceiling levels (none is a ceiling, not a tier)', () => {
    expect(isRiskTier('critical')).toBe(true);
    expect(isRiskTier('none')).toBe(false);
    expect(isCeilingLevel('none')).toBe(true);
    expect(isCeilingLevel('critical')).toBe(true);
    expect(isCeilingLevel('ludicrous')).toBe(false);
  });

  it('compareRisk / minCeiling order by rank', () => {
    expect(compareRisk('low', 'high')).toBeLessThan(0);
    expect(compareRisk('high', 'high')).toBe(0);
    expect(minCeiling('low', 'high')).toBe('low');
    expect(minCeiling('critical', 'none')).toBe('none');
  });

  it('withinCeiling: an item is auto-eligible only at/below the ceiling; `none` ⇒ never', () => {
    expect(withinCeiling('trivial', 'none')).toBe(false); // never-auto floor
    expect(withinCeiling('low', 'low')).toBe(true);
    expect(withinCeiling('high', 'low')).toBe(false);
    expect(withinCeiling('trivial', 'critical')).toBe(true);
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

  it('is `none` when locked, regardless of ceiling/graduation (D-005)', () => {
    expect(effectiveCeiling({ ...base, locked: true, ceiling: 'critical', graduatedLevel: 'critical' })).toBe(
      'none',
    );
  });

  it('autoEverAllowed is false at the never-auto floor, true once effective > none', () => {
    expect(autoEverAllowed({ ...base, ceiling: 'none', graduatedLevel: 'none' })).toBe(false);
    expect(autoEverAllowed(base)).toBe(true);
    expect(autoEverAllowed({ ...base, locked: true })).toBe(false);
  });
});

describe('defaultPolicyFor + the D-007 behavior-neutral invariant', () => {
  it('protected categories default to locked; the rest default unlocked', () => {
    for (const id of AUTONOMY_CATEGORY_IDS) {
      const d = defaultPolicyFor(id);
      expect(d.locked).toBe(isProtectedCategory(id));
      expect(d.ceiling).toBe('none');
      expect(d.graduatedLevel).toBe('none');
      expect(d.ownerOverride).toBeNull();
    }
    const lockedByDefault = AUTONOMY_CATEGORY_IDS.filter((id) => defaultPolicyFor(id).locked);
    expect(new Set(lockedByDefault)).toEqual(new Set(PROTECTED_CATEGORIES));
  });

  it('EVERY category ships never-auto (effectiveCeiling none) — identical to today', () => {
    for (const id of AUTONOMY_CATEGORY_IDS) {
      expect(effectiveCeiling(defaultPolicyFor(id))).toBe('none');
      expect(autoEverAllowed(defaultPolicyFor(id))).toBe(false);
    }
  });
});
