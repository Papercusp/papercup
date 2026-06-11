/**
 * plans:new search-first dedup — pure scoring tests (audit P-049 / EI-134).
 *
 * Duplicate plans split project history: the second author never finds the
 * first plan's decisions. plans:new now surfaces overlapping existing plans
 * (`similar_exists` + candidates) unless force: true.
 */

import { describe, expect, it } from 'vitest';
import { dedupTokens, findSimilarPlans } from '../new';

const ROWS = [
  { planSlug: 'locks-grant-cascade-2026-06-01', title: 'Locks grant cascade correctness', status: 'shipped', archived: false },
  { planSlug: 'plans-rail-sort-2026-05-30', title: 'Plans rail sorting', status: 'active', archived: false },
  { planSlug: 'coord-e2e-testing-2026-06-10', title: 'Coord system E2E testing', status: 'ready', archived: false },
  { planSlug: 'old-locks-cleanup-2026-04-01', title: 'Locks cleanup (superseded)', status: 'superseded', archived: true },
];

describe('dedupTokens', () => {
  it('drops the date suffix, stopwords, and short tokens; dedupes', () => {
    expect(dedupTokens('locks-grant-cascade-2026-06-01', 'Fix the locks grant cascade')).toEqual([
      'locks', 'grant', 'cascade',
    ]);
  });

  it('keeps meaningful single tokens', () => {
    expect(dedupTokens('hyperbee', 'Hyperbee')).toEqual(['hyperbee']);
  });
});

describe('findSimilarPlans', () => {
  it('surfaces plans sharing ≥2 topic tokens; 1-token overlap does not rank', () => {
    const similar = findSimilarPlans(['locks', 'grant', 'cascade'], ROWS);
    expect(similar.map((s) => s.slug)).toEqual(['locks-grant-cascade-2026-06-01']);
    expect(similar[0].sharedTokens).toEqual(['locks', 'grant', 'cascade']);
  });

  it('single-token proposals match on that one token', () => {
    const similar = findSimilarPlans(['coord'], ROWS);
    expect(similar.map((s) => s.slug)).toEqual(['coord-e2e-testing-2026-06-10']);
  });

  it('archived plans ARE candidates (the "continue, don\'t duplicate" signal)', () => {
    const similar = findSimilarPlans(['locks', 'cleanup'], ROWS);
    expect(similar.some((s) => s.slug === 'old-locks-cleanup-2026-04-01' && s.archived)).toBe(true);
  });

  it('no overlap → empty (creation proceeds)', () => {
    expect(findSimilarPlans(['totally', 'unrelated'], ROWS)).toEqual([]);
    expect(findSimilarPlans([], ROWS)).toEqual([]);
  });

  it('caps at 5 candidates', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      planSlug: `locks-grant-thing-${i}-2026-06-0${(i % 9) + 1}`,
      title: 'locks grant',
      status: 'active',
      archived: false,
    }));
    expect(findSimilarPlans(['locks', 'grant'], many)).toHaveLength(5);
  });
});
