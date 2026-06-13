/**
 * action-surface.test.ts — pins the P-015 audit invariants (the substrate the
 * D-010 completeness claim + the P-090 coverage invariant verify against):
 *   1. COMPLETENESS  — every action maps to a valid category, and every category
 *      is exercised by ≥1 action (a total partition, D-010).
 *   2. CONSISTENCY   — every COVERED action's Queen verb(s) resolve, via the
 *      capability→category map, to the SAME category the audit assigned (taxonomy
 *      and runtime map cannot drift apart).
 *   3. COVERAGE      — gaps have no verbs (and vice versa); covered actions have
 *      verbs; the coverage-gap list (P-016) is queryable + stable.
 *   4. AXES          — reversibility/authority vocab is valid; PROTECTED-category
 *      actions are owner-authority (never auto).
 */
import { describe, it, expect } from 'vitest';
import {
  ACTION_SURFACE,
  coverageGaps,
  partialCoverage,
  categoriesInAudit,
} from './action-surface';
import { categoryForAction } from './capability-category-map';
import {
  AUTONOMY_CATEGORY_IDS,
  isAutonomyCategory,
  isProtectedCategory,
} from './categories';

const REVERSIBILITY = new Set(['reversible', 'irreversible', 'unknown']);
const AUTHORITY = new Set(['owner', 'system']);
const COVERAGE = new Set(['covered', 'partial', 'gap']);

describe('action surface — completeness (D-010)', () => {
  it('every action has a unique id', () => {
    const ids = ACTION_SURFACE.map((a) => a.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every action maps to exactly one VALID category', () => {
    for (const a of ACTION_SURFACE) {
      expect(isAutonomyCategory(a.category), `${a.id} → ${a.category}`).toBe(true);
    }
  });

  it('is a TOTAL partition — every one of the 13 categories is exercised', () => {
    const seen = new Set(categoriesInAudit());
    for (const id of AUTONOMY_CATEGORY_IDS) {
      expect(seen.has(id), `category "${id}" has no audited action`).toBe(true);
    }
  });
});

describe('action surface — map↔audit consistency', () => {
  // For every COVERED action, each listed Queen verb must resolve (via the
  // runtime capability→category map) to the SAME category the audit assigned.
  // This is the guard that keeps action-surface.ts and capability-category-map.ts
  // from drifting. Partial/gap rows are excluded by design (a partial row is one
  // whose available verb doesn't cleanly realize the category — that's WHY it is
  // partial), but they are checked for category validity above.
  it('every covered action’s verbs resolve to its assigned category', () => {
    for (const a of ACTION_SURFACE) {
      if (a.coverage !== 'covered') continue;
      expect(a.queenVerbs.length, `${a.id} is covered but lists no verb`).toBeGreaterThan(0);
      for (const verb of a.queenVerbs) {
        expect(categoryForAction(verb), `${a.id}: verb ${verb}`).toBe(a.category);
      }
    }
  });
});

describe('action surface — coverage (P-016)', () => {
  it('gap ⇔ no verbs; covered/partial ⇒ has verbs (except the documented automation-only partials)', () => {
    for (const a of ACTION_SURFACE) {
      if (a.coverage === 'gap') {
        expect(a.queenVerbs.length, `${a.id} is a gap but lists verbs`).toBe(0);
        expect(a.notes, `${a.id} gap must carry a note`).toBeTruthy();
      } else if (a.coverage === 'covered') {
        expect(a.queenVerbs.length, `${a.id} covered but no verbs`).toBeGreaterThan(0);
      }
      // 'partial' may legitimately have zero verbs (e.g. automation-only
      // promote-to-green) or some verbs that don't fully realize the category;
      // it always carries an explanatory note.
      if (a.coverage === 'partial') {
        expect(a.notes, `${a.id} partial must carry a note`).toBeTruthy();
      }
    }
  });

  it('coverageGaps() returns exactly the gap rows', () => {
    const gaps = coverageGaps();
    expect(gaps.every((g) => g.coverage === 'gap')).toBe(true);
    expect(gaps.length).toBe(ACTION_SURFACE.filter((a) => a.coverage === 'gap').length);
  });

  it('the known coverage gap (review&merge approval) is present and filed', () => {
    const gapIds = coverageGaps().map((g) => g.id);
    expect(gapIds).toContain('review.approve-code-review-merge');
  });

  it('partialCoverage() returns only partial rows', () => {
    expect(partialCoverage().every((p) => p.coverage === 'partial')).toBe(true);
  });
});

describe('action surface — axes (reversibility · authority)', () => {
  it('uses valid reversibility / authority / coverage vocab', () => {
    for (const a of ACTION_SURFACE) {
      expect(REVERSIBILITY.has(a.reversibility), `${a.id}.reversibility`).toBe(true);
      expect(AUTHORITY.has(a.authority), `${a.id}.authority`).toBe(true);
      expect(COVERAGE.has(a.coverage), `${a.id}.coverage`).toBe(true);
    }
  });

  it('every PROTECTED-category action is owner-authority (never auto by right)', () => {
    for (const a of ACTION_SURFACE) {
      if (isProtectedCategory(a.category)) {
        expect(a.authority, `${a.id} is in a protected category`).toBe('owner');
      }
    }
  });
});
