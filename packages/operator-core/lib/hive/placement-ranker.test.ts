/**
 * Unit tests for the placement ranker — the ONE ranker, two views
 * (queen-autonomous-execution B-08 / P-011, P-031). Pure: features score off
 * the candidate's own fields, so no PG / no IO here.
 */
import { describe, expect, it } from 'vitest';
import {
  PLACEMENT_FEATURES,
  PLACEMENT_WEIGHTS,
  placementRankerSpec,
  rankPlacements,
  type PlacementCandidate,
} from './placement-ranker';

const base = (over: Partial<PlacementCandidate>): PlacementCandidate => ({
  id: 'x',
  view: 'work-item',
  harness: 'h',
  title: 't',
  ...over,
});

describe('rankPlacements', () => {
  it('returns [] for an empty queue', async () => {
    expect(await rankPlacements([])).toEqual([]);
  });

  it('orders by importance (urgent > high > normal > low) all else equal', async () => {
    const ranked = await rankPlacements([
      base({ id: 'low', importance: 'low' }),
      base({ id: 'urgent', importance: 'urgent' }),
      base({ id: 'normal', importance: 'normal' }),
      base({ id: 'high', importance: 'high' }),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(['urgent', 'high', 'normal', 'low']);
  });

  it('weights blocking-impact by consume-edges B-08 per-edge weights (blocksOut=12, inboundRef=3)', async () => {
    const [blocks] = await rankPlacements([base({ id: 'b', importance: 'low', blocksOut: 1 })]);
    const bi = blocks.rank.features.find((f) => f.feature === 'blocking-impact')!;
    // 1 blocks-out edge × weight 12 (BLOCKING_IMPACT_WEIGHTS.blocksOut) × feature weight 1.
    expect(bi.value).toBe(12);
    expect(bi.contribution).toBe(12 * PLACEMENT_WEIGHTS.blockingImpact);
    expect(bi.reasons.some((r) => /blocks 1/.test(r))).toBe(true);

    const [refs] = await rankPlacements([base({ id: 'r', importance: 'low', inboundRefs: 2 })]);
    expect(refs.rank.features.find((f) => f.feature === 'blocking-impact')!.value).toBe(6); // 2 × 3
  });

  it('ANTI-STARVATION (P-031): an aged low-importance item outranks a fresh normal one', async () => {
    const ranked = await rankPlacements([
      base({ id: 'fresh-normal', importance: 'normal', ageDays: 0 }),
      base({ id: 'aged-low', importance: 'low', ageDays: 60 }),
    ]);
    // fresh-normal: importance 1×4 = 4, no staleness. aged-low: importance 0,
    // staleness ≈1.79×3 ≈ 5.37 → the long-unplaced item self-promotes above it.
    expect(ranked[0].id).toBe('aged-low');
    expect(ranked[0].rank.features.find((f) => f.feature === 'staleness')!.value).toBeGreaterThan(0);
    expect(ranked[1].rank.features.find((f) => f.feature === 'staleness')!.value).toBe(0); // fresh → 0
  });

  it('boosts items with open escalations / needs-human pressure', async () => {
    const ranked = await rankPlacements([
      base({ id: 'calm', importance: 'normal' }),
      base({ id: 'escalated', importance: 'normal', escalations: 2 }),
    ]);
    expect(ranked[0].id).toBe('escalated');
    expect(ranked[0].rank.features.find((f) => f.feature === 'escalation-pressure')!.contribution).toBe(
      2 * PLACEMENT_WEIGHTS.escalationPressure,
    );
  });

  it('breaks ties on op_priority (lower = sooner), then id', async () => {
    const ranked = await rankPlacements([
      base({ id: 'no-prio', importance: 'normal' }),
      base({ id: 'prio-5', importance: 'normal', opPriority: 5 }),
      base({ id: 'prio-1', importance: 'normal', opPriority: 1 }),
    ]);
    // identical feature scores → op_priority ascending, unset (∞) last.
    expect(ranked.map((r) => r.id)).toEqual(['prio-1', 'prio-5', 'no-prio']);
  });

  it('carries a full breakdown: all four features in registry order', async () => {
    const [c] = await rankPlacements([base({ id: 'c', importance: 'high' })]);
    expect(c.rank.features.map((f) => f.feature)).toEqual([
      'plan-importance',
      'blocking-impact',
      'staleness',
      'escalation-pressure',
    ]);
    expect(c.rank.score).toBe(c.rank.features.reduce((s, f) => s + f.contribution, 0));
  });

  it('is view-agnostic: one registry ranks a plan and a work-item together (D-004)', async () => {
    const ranked = await rankPlacements([
      base({ id: 'wi', view: 'work-item', importance: 'normal' }),
      base({ id: 'plan', view: 'plan', importance: 'urgent' }),
    ]);
    expect(ranked[0].id).toBe('plan'); // urgent plan outranks the normal work-item
    expect(ranked.every((r) => r.rank.features.length === PLACEMENT_FEATURES.length)).toBe(true);
  });

  it('exposes the registry as data (name/weight/description)', () => {
    const spec = placementRankerSpec();
    expect(spec.map((s) => s.name)).toEqual([
      'plan-importance',
      'blocking-impact',
      'staleness',
      'escalation-pressure',
    ]);
    expect(spec.every((s) => typeof s.weight === 'number' && s.description.length > 0)).toBe(true);
  });
});
