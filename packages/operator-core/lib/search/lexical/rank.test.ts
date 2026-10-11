/**
 * fuseByPosition — merging best-first lists from different corpora by position, never by
 * raw score (plan bm25-lexical-search-evoke-adoption-2026-10-10 D-006).
 */
import { describe, expect, it } from 'vitest';
import { RRF_K_DEFAULT } from '@papercusp/rrf';
import { fuseByPosition, usesWebsearchOperators } from './rank';

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
