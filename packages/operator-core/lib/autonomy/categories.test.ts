/**
 * categories.test.ts — pins the canonical autonomy taxonomy (B-04 / P-020).
 * These are CONTRACT assertions: B-03's store, the capability→category map, and
 * the P-090 invariants all key on this exact set, so a drift here is a break.
 */
import { describe, it, expect } from 'vitest';
import {
  CATEGORIES,
  AUTONOMY_CATEGORY_IDS,
  PROTECTED_CATEGORIES,
  isAutonomyCategory,
  getCategory,
  isProtectedCategory,
  type AutonomyCategory,
} from './categories';

describe('autonomy categories (D-009 taxonomy)', () => {
  it('is exactly the 14-category partition, in table order', () => {
    expect(AUTONOMY_CATEGORY_IDS).toEqual([
      'inbox-triage',
      'escalations',
      'plan-governance',
      'work-prioritization',
      'ideation-intake',
      'implementation',
      'review-merge',
      'release-deploy',
      'spend-budget',
      'agent-lifecycle',
      'credentials-auth',
      'knowledge-curation',
      'schedule-arm',
      'system-control',
    ]);
    expect(CATEGORIES).toHaveLength(14);
  });

  it('has no duplicate ids', () => {
    expect(new Set(AUTONOMY_CATEGORY_IDS).size).toBe(AUTONOMY_CATEGORY_IDS.length);
  });

  it('the PROTECTED set is exactly the D-005 never-auto four', () => {
    expect([...PROTECTED_CATEGORIES].sort()).toEqual(
      ['credentials-auth', 'release-deploy', 'spend-budget', 'system-control'].sort(),
    );
  });

  it('protected categories carry the protected flag and posture; the rest do not', () => {
    for (const c of CATEGORIES) {
      const protectedById = (PROTECTED_CATEGORIES as readonly string[]).includes(c.id);
      expect(c.protected).toBe(protectedById);
      // a protected category's suggested posture is permanent 'protected'
      if (c.protected) expect(c.suggestedPosture).toBe('protected');
      else expect(c.suggestedPosture).not.toBe('protected');
    }
  });

  it('every category has a non-empty label + covers prose', () => {
    for (const c of CATEGORIES) {
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.covers.length).toBeGreaterThan(0);
    }
  });

  it('isProtectedCategory matches the protected flag', () => {
    for (const c of CATEGORIES) {
      expect(isProtectedCategory(c.id)).toBe(c.protected);
    }
  });

  it('isAutonomyCategory accepts every id and rejects non-members', () => {
    for (const id of AUTONOMY_CATEGORY_IDS) expect(isAutonomyCategory(id)).toBe(true);
    expect(isAutonomyCategory('not-a-category')).toBe(false);
    expect(isAutonomyCategory('')).toBe(false);
    expect(isAutonomyCategory('inbox')).toBe(false); // a prefix is not the id
  });

  it('getCategory round-trips every id and is undefined for an unknown id', () => {
    for (const id of AUTONOMY_CATEGORY_IDS) {
      expect(getCategory(id)?.id).toBe(id);
    }
    expect(getCategory('nope' as AutonomyCategory)).toBeUndefined();
  });
});
