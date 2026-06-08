/**
 * outcome-feedback.test.ts — Scout P-013 (D-009) unit tests.
 *
 * Pins the attribution chain (routed-idea provenance × change feed → lens
 * outcomes → weights), the smoothing + diversity floor on the weights, and the
 * D-004/D-009 blend in ideator allocation.
 */

import { describe, it, expect, vi } from 'vitest';
import type { ChangeFeedEntry } from '../curation/change-feed';
import { CREATIVE_LENSES, type CreativeLens } from './types';
import {
  classifyIdeaOutcome,
  computeLensOutcomes,
  allocateIdeators,
  gatherLensOutcomes,
  type RoutedIdeaProvenance,
  type ScoutOutcomeReaders,
} from './outcome-feedback';

function prov(p: Partial<RoutedIdeaProvenance> & { lens: CreativeLens; routedRef: string }): RoutedIdeaProvenance {
  return { ideaId: p.ideaId ?? `idea-${p.routedRef}`, rail: p.rail ?? 'improvement', ...p };
}

function entry(p: Partial<ChangeFeedEntry> & { ref: string; kind: ChangeFeedEntry['kind'] }): ChangeFeedEntry {
  return { id: p.id ?? p.ref, title: p.title ?? p.ref, ts: p.ts ?? '2026-06-08T00:00:00Z', ...p };
}

describe('Scout outcome-feedback (P-013 / D-009)', () => {
  describe('classifyIdeaOutcome', () => {
    const feed = new Map<string, ChangeFeedEntry>([
      ['plan:foo', entry({ ref: 'plan:foo', kind: 'plan-run', title: 'Plan completed: foo' })],
      ['wi:EI-1', entry({ ref: 'wi:EI-1', kind: 'completion', detail: 'Status: resolved' })],
      ['gym:a', entry({ ref: 'gym:a', kind: 'proposal', title: 'Accepted prompt for worker', detail: 'Status: accepted' })],
      ['gym:b', entry({ ref: 'gym:b', kind: 'proposal', title: 'Rejected prompt for worker', detail: 'Status: rejected' })],
      ['gym:c', entry({ ref: 'gym:c', kind: 'proposal', title: 'Superseded prompt for worker', detail: 'Status: superseded' })],
      // status only in the title (detail absent) — fallback path
      ['gym:d', entry({ ref: 'gym:d', kind: 'proposal', title: 'Accepted prompt for scoper' })],
    ]);

    it('pending when the routed artifact is not yet in the feed', () => {
      expect(classifyIdeaOutcome(prov({ lens: 'analogical', routedRef: 'plan:missing', rail: 'plan' }), feed)).toBe('pending');
    });

    it('plan-run present = won', () => {
      expect(classifyIdeaOutcome(prov({ lens: 'analogical', routedRef: 'plan:foo', rail: 'plan' }), feed)).toBe('won');
    });

    it('work-item completion present = won', () => {
      expect(classifyIdeaOutcome(prov({ lens: 'reframing', routedRef: 'wi:EI-1', rail: 'improvement' }), feed)).toBe('won');
    });

    it('gym accepted = won, rejected/superseded = lost', () => {
      expect(classifyIdeaOutcome(prov({ lens: 'first-principles', routedRef: 'gym:a', rail: 'gym' }), feed)).toBe('won');
      expect(classifyIdeaOutcome(prov({ lens: 'first-principles', routedRef: 'gym:b', rail: 'gym' }), feed)).toBe('lost');
      expect(classifyIdeaOutcome(prov({ lens: 'first-principles', routedRef: 'gym:c', rail: 'gym' }), feed)).toBe('lost');
    });

    it('reads gym status from the title when detail is absent', () => {
      expect(classifyIdeaOutcome(prov({ lens: 'constraint-removal', routedRef: 'gym:d', rail: 'gym' }), feed)).toBe('won');
    });
  });

  describe('computeLensOutcomes', () => {
    it('always reports all four lenses, even with no data', () => {
      const r = computeLensOutcomes([], []);
      expect(Object.keys(r.byLens).sort()).toEqual([...CREATIVE_LENSES].sort());
      expect(r.total).toBe(0);
      for (const l of CREATIVE_LENSES) {
        expect(r.byLens[l].routed).toBe(0);
        expect(r.byLens[l].winRate).toBeNull();
      }
    });

    it('weights sum to 1 with no data and are equal (neutral prior)', () => {
      const r = computeLensOutcomes([], []);
      const total = CREATIVE_LENSES.reduce((a, l) => a + r.byLens[l].weight, 0);
      expect(total).toBeCloseTo(1, 9);
      const w0 = r.byLens[CREATIVE_LENSES[0]].weight;
      for (const l of CREATIVE_LENSES) expect(r.byLens[l].weight).toBeCloseTo(w0, 9);
    });

    it('tallies won/lost/pending per lens and computes winRate over decided only', () => {
      const completions: ChangeFeedEntry[] = [
        entry({ ref: 'gym:w1', kind: 'proposal', detail: 'Status: accepted' }),
        entry({ ref: 'gym:w2', kind: 'proposal', detail: 'Status: accepted' }),
        entry({ ref: 'gym:l1', kind: 'proposal', detail: 'Status: rejected' }),
        entry({ ref: 'plan:p1', kind: 'plan-run' }),
      ];
      const provenance: RoutedIdeaProvenance[] = [
        prov({ lens: 'analogical', routedRef: 'gym:w1', rail: 'gym' }),
        prov({ lens: 'analogical', routedRef: 'gym:w2', rail: 'gym' }),
        prov({ lens: 'analogical', routedRef: 'gym:l1', rail: 'gym' }),
        prov({ lens: 'analogical', routedRef: 'gym:pending', rail: 'gym' }), // not in feed
        prov({ lens: 'reframing', routedRef: 'plan:p1', rail: 'plan' }),
      ];
      const r = computeLensOutcomes(provenance, completions);
      const a = r.byLens.analogical;
      expect(a.routed).toBe(4);
      expect(a.won).toBe(2);
      expect(a.lost).toBe(1);
      expect(a.pending).toBe(1);
      expect(a.winRate).toBeCloseTo(2 / 3, 9); // decided = 3, pending excluded
      expect(r.byLens.reframing.won).toBe(1);
      expect(r.byLens.reframing.winRate).toBe(1);
      expect(r.total).toBe(5);
    });

    it('a winning lens outweighs a losing lens, but the floor keeps the loser alive', () => {
      const completions: ChangeFeedEntry[] = [
        entry({ ref: 'gym:win1', kind: 'proposal', detail: 'Status: accepted' }),
        entry({ ref: 'gym:win2', kind: 'proposal', detail: 'Status: accepted' }),
        entry({ ref: 'gym:win3', kind: 'proposal', detail: 'Status: accepted' }),
        entry({ ref: 'gym:lose1', kind: 'proposal', detail: 'Status: rejected' }),
        entry({ ref: 'gym:lose2', kind: 'proposal', detail: 'Status: rejected' }),
        entry({ ref: 'gym:lose3', kind: 'proposal', detail: 'Status: rejected' }),
      ];
      const provenance: RoutedIdeaProvenance[] = [
        ...['gym:win1', 'gym:win2', 'gym:win3'].map((ref) => prov({ lens: 'analogical', routedRef: ref, rail: 'gym' })),
        ...['gym:lose1', 'gym:lose2', 'gym:lose3'].map((ref) => prov({ lens: 'reframing', routedRef: ref, rail: 'gym' })),
      ];
      const r = computeLensOutcomes(provenance, completions, { minShare: 0.05 });
      expect(r.byLens.analogical.weight).toBeGreaterThan(r.byLens.reframing.weight);
      // The losing lens is floored, never zeroed (diversity guarantee).
      expect(r.byLens.reframing.weight).toBeGreaterThanOrEqual(0.05 - 1e-9);
      // Weights still normalize to 1.
      const total = CREATIVE_LENSES.reduce((a, l) => a + r.byLens[l].weight, 0);
      expect(total).toBeCloseTo(1, 9);
      // ranked is best-first.
      expect(r.ranked[0].lens).toBe('analogical');
    });

    it('respects the minShare floor', () => {
      const completions: ChangeFeedEntry[] = Array.from({ length: 10 }, (_, i) =>
        entry({ ref: `gym:w${i}`, kind: 'proposal', detail: 'Status: accepted' }),
      );
      const provenance = completions.map((e) => prov({ lens: 'analogical', routedRef: e.ref, rail: 'gym' }));
      const r = computeLensOutcomes(provenance, completions, { minShare: 0.1 });
      for (const l of CREATIVE_LENSES) expect(r.byLens[l].weight).toBeGreaterThanOrEqual(0.1 - 1e-9);
    });
  });

  describe('allocateIdeators (D-004 forced diversity × D-009 weighting)', () => {
    const completions: ChangeFeedEntry[] = [
      entry({ ref: 'gym:a1', kind: 'proposal', detail: 'Status: accepted' }),
      entry({ ref: 'gym:a2', kind: 'proposal', detail: 'Status: accepted' }),
      entry({ ref: 'gym:a3', kind: 'proposal', detail: 'Status: accepted' }),
    ];
    const provenance = completions.map((e) => prov({ lens: 'analogical', routedRef: e.ref, rail: 'gym' }));
    const report = computeLensOutcomes(provenance, completions);

    it('n == 0 → empty', () => {
      expect(allocateIdeators(report, 0)).toEqual([]);
    });

    it('n >= lensCount → every lens gets at least one slot (exploration guarantee)', () => {
      const alloc = allocateIdeators(report, 8);
      expect(alloc).toHaveLength(8);
      for (const l of CREATIVE_LENSES) expect(alloc).toContain(l);
      // The winning lens gets MORE than its 1 guaranteed slot.
      const counts = countBy(alloc);
      expect(counts.analogical).toBeGreaterThan(1);
    });

    it('n < lensCount → the top-n lenses by weight', () => {
      const alloc = allocateIdeators(report, 2);
      expect(alloc).toHaveLength(2);
      expect(alloc[0]).toBe('analogical'); // highest weight first
      expect(new Set(alloc).size).toBe(2); // distinct
    });

    it('is deterministic', () => {
      expect(allocateIdeators(report, 7)).toEqual(allocateIdeators(report, 7));
    });
  });

  describe('gatherLensOutcomes', () => {
    it('reads both sources and computes the report', async () => {
      const readers: ScoutOutcomeReaders = {
        async routedIdeas() {
          return [prov({ lens: 'first-principles', routedRef: 'plan:x', rail: 'plan' })];
        },
        async completions() {
          return [entry({ ref: 'plan:x', kind: 'plan-run' })];
        },
      };
      const r = await gatherLensOutcomes(readers);
      expect(r.total).toBe(1);
      expect(r.byLens['first-principles'].won).toBe(1);
    });

    it('survives a reader throwing (degrades to empty, no throw)', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      const readers: ScoutOutcomeReaders = {
        async routedIdeas() {
          throw new Error('PG down');
        },
        async completions() {
          return [];
        },
      };
      const r = await gatherLensOutcomes(readers);
      expect(r.total).toBe(0);
    });
  });
});

function countBy(arr: CreativeLens[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of arr) out[x] = (out[x] ?? 0) + 1;
  return out;
}
