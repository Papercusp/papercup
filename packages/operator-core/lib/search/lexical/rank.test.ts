/**
 * fuseByPosition — merging best-first lists from different corpora by position, never by
 * raw score (plan bm25-lexical-search-evoke-adoption-2026-10-10 D-006).
 */
import { describe, expect, it } from 'vitest';
import { RRF_K_DEFAULT } from '@papercusp/rrf';
import { EXACT_LIST_MAX_AND_ROWS, fuseByPosition, mergeExactAndBm25, usesWebsearchOperators } from './rank';

describe('mergeExactAndBm25 (R-13, D-016)', () => {
  type R = { id: string; rank: number };
  const id = (r: R) => r.id;

  it('counts a row both lists found ONCE, with both contributions, ahead of single-list rows', () => {
    const exact: R[] = [{ id: 'target', rank: 0.9 }, { id: 'e2', rank: 0.5 }];
    const bm25: R[] = [{ id: 'b1', rank: 30 }, { id: 'target', rank: 20 }, { id: 'b3', rank: 10 }];
    const merged = mergeExactAndBm25(exact, bm25, id, 10);
    expect(merged.map(r => r.id)).toEqual(['target', 'b1', 'e2', 'b3']);
    expect(merged.filter(r => r.id === 'target')).toHaveLength(1);
    expect(merged[0].rank).toBeCloseTo(1 / (RRF_K_DEFAULT + 1) + 1 / (RRF_K_DEFAULT + 2), 12);
  });

  it('keeps a fragment target the exact list ranks first inside the top results even when BM25 never found it', () => {
    // The R-13 failure shape: BM25 ranks the target past its whole list, the exact list ranks it 1.
    const bm25: R[] = Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, rank: 100 - i }));
    const exact: R[] = [{ id: 'target', rank: 0.4 }];
    const merged = mergeExactAndBm25(exact, bm25, id, 10);
    expect(merged.map(r => r.id).indexOf('target')).toBe(0);
  });

  it('breaks a tie in favour of the exact list and scores rows by fused rank, not by either scale', () => {
    const merged = mergeExactAndBm25([{ id: 'e', rank: 0.001 }], [{ id: 'b', rank: 999 }], id, 10);
    expect(merged.map(r => r.id)).toEqual(['e', 'b']);
    expect(merged[0].rank).toBe(merged[1].rank);
  });

  it('returns the BM25 list unchanged in order when the exact list is empty, and honours limit', () => {
    const bm25: R[] = [{ id: 'a', rank: 3 }, { id: 'b', rank: 2 }, { id: 'c', rank: 1 }];
    expect(mergeExactAndBm25([], bm25, id, 2).map(r => r.id)).toEqual(['a', 'b']);
    expect(mergeExactAndBm25([], bm25, id, 0)).toEqual([]);
  });

  it('caps the exact list at a population that admits every measured R-13 loss (largest AND set 3,925)', () => {
    expect(EXACT_LIST_MAX_AND_ROWS).toBeGreaterThanOrEqual(3925);
  });
});

describe('usesWebsearchOperators (plan D-007)', () => {
  it.each(['"exact phrase"', 'report -draft', '-draft report', 'gate or deploy', 'gate OR deploy', 'a "b c" d'])(
    'detects websearch syntax in %j',
    (q) => expect(usesWebsearchOperators(q)).toBe(true),
  );

  it.each(['plain words only', 'pre-release gate', 'oracle orbit', 'or', 'error-or-warning', 'x - y', ''])(
    'treats %j as a plain query',
    (q) => expect(usesWebsearchOperators(q)).toBe(false),
  );
});

type Row = { id: string; score: number };
const key = (r: Row) => r.id;

describe('fuseByPosition', () => {
  it('interleaves lists by position whatever their score scales', () => {
    const bm25: Row[] = [{ id: 'a', score: 14 }, { id: 'b', score: 9 }, { id: 'c', score: 7 }];
    const tsRank: Row[] = [{ id: 'x', score: 0.09 }, { id: 'y', score: 0.01 }];
    const fused = fuseByPosition([{ name: 'bm25', rows: bm25, key }, { name: 'ts', rows: tsRank, key }]);
    expect(fused.map(f => f.row.id)).toEqual(['a', 'x', 'b', 'y', 'c']);
    expect(fused[0]).toMatchObject({ list: 'bm25', position: 1, score: 1 / (RRF_K_DEFAULT + 1) });
    expect(fused[3]).toMatchObject({ list: 'ts', position: 2, score: 1 / (RRF_K_DEFAULT + 2) });
  });

  it('is invariant to rescaling any list', () => {
    const a: Row[] = [{ id: 'a1', score: 3 }, { id: 'a2', score: 2 }];
    const b: Row[] = [{ id: 'b1', score: 0.3 }, { id: 'b2', score: 0.2 }];
    const scaled = b.map(r => ({ ...r, score: r.score * 1000 }));
    const order = (rows: Row[]) => fuseByPosition([{ name: 'a', rows: a, key }, { name: 'b', rows, key }]).map(f => f.row.id);
    expect(order(scaled)).toEqual(order(b));
  });

  it('keeps rows of different lists that share a key apart', () => {
    const fused = fuseByPosition([
      { name: 'goals', rows: [{ id: 'same', score: 1 }], key },
      { name: 'audit', rows: [{ id: 'same', score: 1 }], key },
    ]);
    expect(fused.map(f => `${f.list}:${f.row.id}`)).toEqual(['goals:same', 'audit:same']);
  });

  it('returns nothing for empty input', () => {
    expect(fuseByPosition<Row>([])).toEqual([]);
    expect(fuseByPosition<Row>([{ name: 'a', rows: [], key }])).toEqual([]);
  });
});
