/**
 * recipe-cooccurrence-leg.test.ts — the W_COOCCUR scoring leg (P-004 / D-016).
 * Mocks the dev:tool_cooccurrence miner; asserts the dep's aggregation (mean pairwise
 * confidence) + the graceful-null cases the recipe scorer relies on.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CooccurrenceEntry } from './dev-data';

const h = vi.hoisted(() => ({ entries: [] as CooccurrenceEntry[], throwIt: false }));

vi.mock('./dev-data', () => ({
  toolCooccurrence: vi.fn(async () => {
    if (h.throwIt) throw new Error('miner down');
    return { totalSpawns: 100, entries: h.entries };
  }),
}));

const { buildRecipeCooccurrenceDep } = await import('./recipe-cooccurrence-leg');

const E = (tool_a: string, tool_b: string, confidence: number): CooccurrenceEntry => ({
  tool_a,
  tool_b,
  support: 5,
  spawns_a: 10,
  spawns_b: 10,
  confidence,
  lift: 1,
});

beforeEach(() => {
  h.entries = [];
  h.throwIt = false;
});

describe('buildRecipeCooccurrenceDep', () => {
  it('returns null when the miner has no data (leg skipped)', async () => {
    h.entries = [];
    expect(await buildRecipeCooccurrenceDep('ws')).toBeNull();
  });

  it('returns null when the miner errors (graceful skip, never throws)', async () => {
    h.throwIt = true;
    expect(await buildRecipeCooccurrenceDep('ws')).toBeNull();
  });

  it('scores a tool-set as the mean pairwise confidence of its in-set pairs', async () => {
    h.entries = [E('a:x', 'b:y', 0.9), E('a:x', 'c:z', 0.5), E('b:y', 'c:z', 0.2), E('q:1', 'q:2', 1.0)];
    const dep = await buildRecipeCooccurrenceDep('ws');
    expect(dep).not.toBeNull();
    // {a:x,b:y,c:z}: (0.9 + 0.5 + 0.2)/3
    expect(await dep!(['a:x', 'b:y', 'c:z'])).toBeCloseTo((0.9 + 0.5 + 0.2) / 3, 3);
    // a 2-tool subset uses just its pair (order-independent)
    expect(await dep!(['b:y', 'a:x'])).toBeCloseTo(0.9, 3);
  });

  it('returns null for a single-tool recipe (no co-occurrence)', async () => {
    h.entries = [E('a:x', 'b:y', 0.9)];
    const dep = await buildRecipeCooccurrenceDep('ws');
    expect(await dep!(['a:x'])).toBeNull();
  });

  it('returns null when no pair of the tool-set is in the corpus', async () => {
    h.entries = [E('a:x', 'b:y', 0.9)];
    const dep = await buildRecipeCooccurrenceDep('ws');
    expect(await dep!(['m:1', 'n:2'])).toBeNull();
  });
});
