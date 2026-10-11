/**
 * Rank fusion with a BM25 lexical leg (plan bm25-lexical-search-evoke-adoption-2026-10-10:
 * requirement R-13, decision D-004).
 *
 * R-13 is judged on the corpus-leg lexical acceptance bench before and after the swap. This
 * suite pins the property the swap relies on: fusion is by POSITION, so BM25's unbounded
 * score fuses exactly like ts_rank's [0,1) one, and rescaling a leg changes nothing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { bm25Leg, rrfTerm } from './rank';
import { bm25Corpus } from './corpora';
import { seedBm25Corpus, startBm25TestDb, type Bm25TestDb } from './test-pg/bm25-test-db';

let db: Bm25TestDb;
let sql: Sql;

beforeAll(async () => {
  db = await startBm25TestDb();
  sql = db.sql;
  await seedBm25Corpus(sql);
}, 600_000);

afterAll(async () => {
  await db?.close();
});

describe('rank fusion with a BM25 leg (plan D-004)', () => {
  // BM25 matches items 1 (quokka) and 2 (marmoset) only; the stand-in second leg matches
  // items 2 and 3, best = 3. The OR in WHERE keeps the planner off the BM25 index scan, so
  // the distance is computed per row inside the window.
  async function fused(scale: number): Promise<{ id: number; score: number }[]> {
    const leg = bm25Leg(sql, bm25Corpus('work_items'), 'quokka marmoset', 'w');
    const otherMatch = sql`w.id IN (2, 3)`;
    return sql<{ id: number; score: number }[]>`
      SELECT w.id,
             (${rrfTerm(sql, leg.match, leg.score)} + ${rrfTerm(sql, otherMatch, sql`w.id * ${scale}::float8`)})::float8 AS score
        FROM harness_shared.work_items w
       WHERE ${leg.match} OR ${otherMatch}
       ORDER BY score DESC, w.id`;
  }

  it('ranks the row both legs match first and admits only rows some leg matches', async () => {
    const rows = await fused(1);
    expect(rows.map(r => r.id).sort()).toEqual([1, 2, 3]);
    expect(rows[0]?.id).toBe(2);
    // Item 2 is second in the other leg and first or second (a tie with item 1) in BM25.
    expect(rows[0]!.score).toBeGreaterThanOrEqual(1 / 62 + 1 / 62 - 1e-12);
    expect(rows[0]!.score).toBeLessThanOrEqual(1 / 61 + 1 / 62 + 1e-12);
    for (const r of rows.slice(1)) expect(r.score).toBeGreaterThan(0);
  });

  it('depends on positions only, so rescaling a leg changes nothing', async () => {
    expect(await fused(1_000_000)).toEqual(await fused(1));
  });
});
