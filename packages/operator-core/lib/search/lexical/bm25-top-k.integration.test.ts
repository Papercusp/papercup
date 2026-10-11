/**
 * `bm25TopK` (plan bm25-lexical-search-evoke-adoption-2026-10-10, R-18 / D-019): the BM25
 * top-k shape the work_item and session_turn search sources read their lexical list from.
 *
 * Two properties carry the R-18 latency fix, and both are pinned here:
 *  1. SAME ROWS as the seam's filter-then-limit form (`WHERE leg.match ORDER BY leg.order
 *     LIMIT k`), for limits below, at and above the match count, and never a non-match.
 *  2. The `<@>` distance is NOT a per-row Filter on the plan (it is selected once and tested
 *     after the LIMIT). The filter-then-limit form is the both-ways control: its plan does
 *     carry that Filter, so this assertion is not vacuous.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { bm25Leg, bm25TopK, type SqlFragment } from './rank';
import { bm25Corpus } from './corpora';
import { seedBm25Corpus, startBm25TestDb, type Bm25TestDb } from './test-pg/bm25-test-db';

let db: Bm25TestDb;
let sql: Sql;

// Workspace 'tk': MATCHES rows carry the probe term 1..MATCHES times (distinct BM25
// distances, checked below), NON_MATCHES rows never do.
const WS = 'tk';
const TERM = 'zebu';
const MATCHES = 12;
const NON_MATCHES = 20;
const BASE_ID = 7001;

beforeAll(async () => {
  db = await startBm25TestDb();
  sql = db.sql;
  await seedBm25Corpus(sql);
  const rows = [
    ...Array.from({ length: MATCHES }, (_, i) => ({
      id: BASE_ID + i, ws: WS, title: `probe row ${i}`, summary: 'plain summary',
      notes: `${Array.from({ length: i + 1 }, () => TERM).join(' ')} filler text`,
    })),
    ...Array.from({ length: NON_MATCHES }, (_, i) => ({
      id: BASE_ID + 100 + i, ws: WS, title: `other row ${i}`, summary: 'plain summary', notes: 'filler text only',
    })),
  ];
  await sql`INSERT INTO harness_shared.work_items ${sql(rows)}`;
}, 600_000);

afterAll(async () => {
  await db?.close();
});

function leg() {
  const l = bm25Leg(sql, bm25Corpus('work_items'), TERM, 'w');
  if (!l.distance) throw new Error('bm25Leg returned no distance');
  return { ...l, distance: l.distance };
}

function topK(limit: number) {
  const l = leg();
  return bm25TopK(sql, {
    distance: l.distance,
    columns: sql`w.id`,
    from: sql`harness_shared.work_items w`,
    where: sql`w.ws = ${WS}`,
    limit,
  });
}

/** The seam's filter-then-limit form: the reference the top-k shape must equal. */
function filterThenLimit(limit: number) {
  const l = leg();
  return sql`
    SELECT w.id, ${l.distance} AS bm25_d FROM harness_shared.work_items w
     WHERE w.ws = ${WS} AND ${l.match}
  ORDER BY ${l.order} LIMIT ${limit}`;
}

describe('bm25TopK — same rows as filter-then-limit', () => {
  it('the probe rows have distinct distances (precondition for an order comparison)', async () => {
    const rows = await sql<{ bm25_d: number }[]>`${filterThenLimit(100)}`;
    expect(rows).toHaveLength(MATCHES);
    expect(new Set(rows.map((r) => r.bm25_d)).size).toBe(MATCHES);
  });

  for (const limit of [5, MATCHES, 30]) {
    it(`limit ${limit}: identical ids in identical order, matches only`, async () => {
      const got = await sql<{ id: number; bm25_d: number }[]>`SELECT s.id, s.bm25_d FROM (${topK(limit)}) s ORDER BY s.bm25_d`;
      const want = await sql<{ id: number }[]>`${filterThenLimit(limit)}`;
      expect(got.map((r) => r.id)).toEqual(want.map((r) => r.id));
      expect(got).toHaveLength(Math.min(limit, MATCHES));
      expect(got.every((r) => r.bm25_d < 0)).toBe(true);
    });
  }
});

describe('bm25TopK — the distance is evaluated once, not as a per-row filter', () => {
  async function planLines(q: SqlFragment): Promise<string[]> {
    const rows = await sql<{ 'QUERY PLAN': string }[]>`EXPLAIN (VERBOSE, COSTS OFF) ${q}`;
    return rows.map((r) => r['QUERY PLAN']);
  }
  const distanceFilter = (lines: string[]) => lines.filter((l) => /Filter:.*<@>/.test(l));

  it('control: the filter-then-limit plan re-evaluates <@> as a row Filter', async () => {
    expect(distanceFilter(await planLines(filterThenLimit(10)))).not.toHaveLength(0);
  });

  it('the top-k plan has no <@> row Filter (the match test runs on the selected value)', async () => {
    const lines = await planLines(sql`SELECT s.id FROM (${topK(10)}) s ORDER BY s.bm25_d`);
    expect(distanceFilter(lines)).toEqual([]);
    expect(lines.some((l) => /Filter:.*bm25_d < /.test(l))).toBe(true);
  });
});
