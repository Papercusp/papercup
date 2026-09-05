import { describe, expect, it } from 'vitest';

import {
  assessSourceCoverage,
  assessSurfaceCoverage,
  SEARCH_SOURCE_SURFACES,
  type CoverageSnapshot,
} from './coverage-gate';

/**
 * WI-9393 / D-018. `assessSurfaceCoverage` is the door for cosine consumers that are NOT
 * a SearchSource (work-item dupe guard, work-item similarity, plan semantic-dedup, memory
 * recall). These tests pin the two properties those consumers depend on:
 *
 *   1. it applies the SAME verdict logic as the search path (so wiring a consumer cannot
 *      quietly acquire a second, more forgiving standard), and
 *   2. absence of evidence renders `unknown`, NEVER `healthy` — the binding D-018
 *      constraint, and the whole reason a consumer is worth wiring at all.
 */

const WORK_ITEMS = 'harness_shared.work_items.embedding';

function snapshotWith(pct: number, opts: { stale?: boolean } = {}): CoverageSnapshot {
  return new Map([
    [
      WORK_ITEMS,
      {
        surface: WORK_ITEMS,
        observedAt: new Date(),
        eligibleRows: 1000,
        embeddedRows: Math.round(pct * 1000),
        pct,
        recentPct: null,
        stale: opts.stale ?? false,
        ageMs: 0,
      },
    ],
  ]);
}

describe('assessSurfaceCoverage (the non-SearchSource door)', () => {
  describe('D-018: absence of evidence is never healthy', () => {
    it('reports unknown for an EMPTY snapshot, not healthy', () => {
      const v = assessSurfaceCoverage('work-item-dupe-guard', [WORK_ITEMS], new Map());
      expect(v.verdict).toBe('unknown');
      expect(v.coverage).toBeNull();
      expect(v.unknownSurfaces).toEqual([WORK_ITEMS]);
    });

    it('reports unknown when the only sample is STALE, not healthy', () => {
      const v = assessSurfaceCoverage('work-item-dupe-guard', [WORK_ITEMS], snapshotWith(0.99, {
        stale: true,
      }));
      expect(v.verdict).toBe('unknown');
      // A stale reading must not be laundered into a coverage number.
      expect(v.coverage).toBeNull();
    });

    it('keeps not-semantic DISTINCT from unknown for a consumer with no embedding leg', () => {
      const v = assessSurfaceCoverage('bm25-only-consumer', [], new Map());
      expect(v.verdict).toBe('not-semantic');
      expect(v.verdict).not.toBe('unknown');
    });
  });

  describe('parity with the search path', () => {
    it('returns the IDENTICAL verdict as assessSourceCoverage for the same surfaces', () => {
      // work_item is a real SearchSource backed by exactly the dupe guard's surface, so the
      // two doors must agree — that agreement is what stops a wired consumer from drifting
      // onto a second, more forgiving standard than search:semantic uses.
      const snapshot = snapshotWith(0.5);
      const viaSource = assessSourceCoverage('work_item', snapshot);
      const viaSurface = assessSurfaceCoverage(
        'work_item',
        SEARCH_SOURCE_SURFACES.work_item,
        snapshot,
      );
      expect(viaSurface.verdict).toBe(viaSource.verdict);
      expect(viaSurface.coverage).toBe(viaSource.coverage);
      expect(viaSurface.note).toBe(viaSource.note);
    });

    it('flags a below-floor surface as degraded', () => {
      const v = assessSurfaceCoverage('work-item-dupe-guard', [WORK_ITEMS], snapshotWith(0.5));
      expect(v.verdict).toBe('degraded');
      expect(v.coverage).toBe(0.5);
    });

    it('labels the assessment with the CONSUMER name, not a search source', () => {
      const v = assessSurfaceCoverage('plan-semantic-dedup', [WORK_ITEMS], snapshotWith(0.5));
      expect(v.source).toBe('plan-semantic-dedup');
      expect(v.note).toContain('plan-semantic-dedup');
    });
  });

  describe('the search-source map stays search-only', () => {
    it('does NOT carry consumer keys — those pass their surfaces directly', () => {
      // Guards the reuse-first decision recorded on WI-9393: consumers must not be added
      // to SEARCH_SOURCE_SURFACES, because coverage-gate.test.ts asserts it exhaustive in
      // both directions against SEARCH_SOURCES. If someone adds one here, this fails
      // BEFORE the exhaustiveness suite does, with a message naming the reason.
      for (const consumer of [
        'work-item-dupe-guard',
        'work-item-similarity',
        'plan-semantic-dedup',
        'memory-recall',
      ]) {
        expect(SEARCH_SOURCE_SURFACES[consumer]).toBeUndefined();
      }
    });
  });
});
