/**
 * Rank fusion with a BM25 lexical leg (plan bm25-lexical-search-evoke-adoption-2026-10-10:
 * requirement R-13, decision D-004).
 *
 * R-13 is judged live by `search/bench/bm25-hybrid-recall-cli.ts` (fused recall@10 of
 * `runHybridSearch` with the BM25 leg vs the legacy leg, same process, same sample). This
 * suite pins two properties that verdict relies on: fusion is by POSITION, so BM25's
 * unbounded score fuses exactly like ts_rank's [0,1) one; and (D-016) the exact list
 * recovers the verbatim-fragment target BM25 alone ranks out of the top results.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { bm25Leg, mergeExactAndBm25, rrfTerm } from './rank';
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

describe('the exact list beside the BM25 list (R-13, plan D-016)', () => {
  // The measured R-13 failure, in miniature: a verbatim fragment of a LONG document whose
  // terms are individually common. Short distractors repeat all but one of the fragment's
  // lexemes, so BM25 (no AND, no proximity) ranks every distractor above the target; the
  // AND list admits only the target. Rows live in workspace 'w9', apart from the seed.
  const FRAGMENT = "third consecutive wake where the carry-note's";
  const TARGET = 5001;

  beforeAll(async () => {
    const filler = Array.from({ length: 400 }, (_, i) => `ledger${i % 37} harbour${i % 23}`).join(' ');
    const rows = [
      { id: TARGET, ws: 'w9', title: 'stale pointer audit', summary: 'routine summary',
        notes: `${filler} This is the third consecutive wake where the carry-note's pointer was stale. ${filler}` },
      ...Array.from({ length: 40 }, (_, i) => ({
        id: TARGET + 1 + i, ws: 'w9', title: `wake third ${i}`,
        summary: 'third consecutive wake wake', notes: 'consecutive note note wake' })),
    ];
    await sql`INSERT INTO harness_shared.work_items ${sql(rows)}`;
  }, 120_000);

  async function bm25List(): Promise<{ id: number; rank: number }[]> {
    const leg = bm25Leg(sql, bm25Corpus('work_items'), FRAGMENT, 'w');
    return sql<{ id: number; rank: number }[]>`
      SELECT w.id, ${leg.score} AS rank FROM harness_shared.work_items w
       WHERE w.ws = 'w9' AND ${leg.match} ORDER BY ${leg.order}, w.id LIMIT 10`;
  }

  async function exactList(): Promise<{ id: number; rank: number }[]> {
    const tsv = sql`to_tsvector('english', coalesce(w.title, '') || ' ' || coalesce(w.summary, '') || ' ' || coalesce(w.notes, ''))`;
    const q = sql`plainto_tsquery('english', ${FRAGMENT})`;
    return sql<{ id: number; rank: number }[]>`
      SELECT w.id, ts_rank_cd(${tsv}, ${q})::float8 AS rank FROM harness_shared.work_items w
       WHERE w.ws = 'w9' AND ${tsv} @@ ${q} ORDER BY rank DESC, w.id LIMIT 10`;
  }

  it('BM25 alone ranks the fragment target out of its top 10 (the mechanism R-13 measured)', async () => {
    const ids = (await bm25List()).map(r => r.id);
    expect(ids).toHaveLength(10);
    expect(ids).not.toContain(TARGET);
  });

  it('the AND list admits only the target, and the merged list ranks it first', async () => {
    const exact = await exactList();
    expect(exact.map(r => r.id)).toEqual([TARGET]);
    const merged = mergeExactAndBm25(exact, await bm25List(), r => String(r.id), 10);
    expect(merged[0].id).toBe(TARGET);
    expect(merged).toHaveLength(10);
  });
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
