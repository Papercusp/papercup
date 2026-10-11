/**
 * BM25 under sustained concurrent writes (plan bm25-lexical-search-evoke-adoption-2026-10-10,
 * item P-008; requirements R-6 and R-7; decision D-010).
 *
 * WRITERS insert and update work items continuously, the way the fleet does. Meanwhile:
 *  - R-6: a probe commits one item carrying a word no other row has (alternately an INSERT and
 *    a title UPDATE) and searches that word through the lexical seam until the item comes back.
 *    Every probe must be found within 5 s of its commit.
 *  - the real maintenance body (`runBm25Maintenance`, the DBOS tick's body) runs every second.
 * When the writers stop, maintenance runs until it has nothing left to do, then R-7: every BM25
 * index in harness_shared must be at most 1.5x the size of its own REINDEX.
 *
 * The load is sized from a measurement (pg_textsearch 1.5.1): distinct-token rows spill the
 * memtable about every 3,000 rows, and 20,000 of them make a ~7 MB index, so 30,000 inserts plus
 * updates take the work_items index past the 8 MiB reclaim floor. The test asserts it did, so
 * the R-7 check cannot pass by never exercising the reclaim path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Sql } from 'postgres';
import { BM25_RECLAIM_MIN_BYTES, runBm25Maintenance, type Bm25Reclaim } from './bm25-maintenance';
import { readBm25Indexes, resetBm25Availability } from './rank';
import { rankWorkItemIds, seedBm25Corpus, startBm25TestDb, type Bm25TestDb } from './test-pg/bm25-test-db';

const VISIBILITY_BOUND_MS = 5_000;
const SIZE_BOUND = 1.5;
const WRITERS = 4;
const BATCHES_PER_WRITER = 30;
const MAX_BATCHES_PER_WRITER = 120;
const MIN_PROBES = 20;
const BATCH_ROWS = 250;
const UPDATES_PER_BATCH = 100;
const WRITER_ID_BASE = 1_000_000;
const PROBE_ID_BASE = 900_000_000;
const SEED_ROWS = 400;

let db: Bm25TestDb;
let sql: Sql;

beforeAll(async () => {
  db = await startBm25TestDb({ max: 10 });
  sql = db.sql;
  await seedBm25Corpus(sql);
  resetBm25Availability();
}, 600_000);

afterAll(async () => {
  await db?.close();
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A word no seeded or loaded row contains: letters only, fixed affixes the stemmer leaves alone. */
function probeWord(n: number): string {
  const body = [...n.toString(26)].map(c => String.fromCharCode(97 + parseInt(c, 26))).join('');
  return `xq${body}vz`;
}

/**
 * Writes BATCHES_PER_WRITER batches, then keeps going while `more()` holds (up to
 * MAX_BATCHES_PER_WRITER), so every probe runs under load however fast the host is.
 * Returns the number of batches written.
 */
async function writer(w: number, more: () => boolean): Promise<number> {
  const base = WRITER_ID_BASE * (w + 1);
  let b = 0;
  for (; b < BATCHES_PER_WRITER || (more() && b < MAX_BATCHES_PER_WRITER); b++) {
    const from = base + b * BATCH_ROWS;
    const to = from + BATCH_ROWS - 1;
    await sql`
      INSERT INTO harness_shared.work_items (id, ws, title, summary)
      SELECT g, 'w' || (g % 2), 'load item ' || g || ' ' || md5(g::text), 'load summary ' || md5((g * 7)::text)
        FROM generate_series(${from}::int, ${to}::int) g`;
    if (b > 0) {
      // Rewrite rows this writer inserted earlier, so the index also takes dead postings.
      const lo = base + (b - 1) * BATCH_ROWS;
      await sql`
        UPDATE harness_shared.work_items SET summary = 'revised summary ' || md5(id::text || ${String(b)})
         WHERE id BETWEEN ${lo}::int AND ${lo + UPDATES_PER_BATCH - 1}::int`;
    }
  }
  return b;
}

/** Commits one probe item and returns how long after the commit a search first found it. */
async function probe(n: number): Promise<{ kind: 'insert' | 'update'; ms: number }> {
  const word = probeWord(n);
  let id: number;
  let kind: 'insert' | 'update';
  if (n % 2 === 0) {
    kind = 'insert';
    id = PROBE_ID_BASE + n;
    await sql`INSERT INTO harness_shared.work_items (id, ws, title, summary)
              VALUES (${id}, 'w0', ${`probe ${word}`}, 'probe summary')`;
  } else {
    kind = 'update';
    id = 9 + (n % (SEED_ROWS - 9));
    await sql`UPDATE harness_shared.work_items SET title = ${`item ${id} ${word}`} WHERE id = ${id}`;
  }
  const committed = performance.now();
  for (;;) {
    const ids = await rankWorkItemIds(sql, word);
    const ms = performance.now() - committed;
    if (ids.includes(id)) return { kind, ms };
    if (ms > VISIBILITY_BOUND_MS) return { kind, ms: Number.POSITIVE_INFINITY };
    await sleep(25);
  }
}

async function indexBytes(qualified: string): Promise<number> {
  const [{ bytes }] = await sql<{ bytes: string }[]>`SELECT pg_relation_size(${qualified}::regclass) AS bytes`;
  return Number(bytes);
}

describe('BM25 under sustained concurrent writes (P-008)', () => {
  it('finds every committed item within 5 s, and every index ends within 1.5x of a fresh rebuild', async () => {
    expect([...(await readBm25Indexes(sql))]).toContain('work_items_bm25');

    let loading = true;
    const probes: Array<{ kind: 'insert' | 'update'; ms: number }> = [];
    const reclaims: Bm25Reclaim[] = [];
    const maintenanceErrors: string[] = [];
    let maxWorkItemsBytes = 0;

    const probeLoop = (async () => {
      for (let n = 0; loading; n++) {
        probes.push(await probe(n));
        await sleep(100);
      }
    })();
    const maintenanceLoop = (async () => {
      while (loading) {
        const r = await runBm25Maintenance(sql);
        maintenanceErrors.push(...r.errors);
        if (r.reclaimed) reclaims.push(r.reclaimed);
        maxWorkItemsBytes = Math.max(maxWorkItemsBytes, await indexBytes('harness_shared.work_items_bm25'));
        await sleep(1_000);
      }
    })();

    const started = performance.now();
    let batches = 0;
    try {
      const done = await Promise.all(Array.from({ length: WRITERS }, (_, w) => writer(w, () => probes.length < MIN_PROBES)));
      batches = done.reduce((a, b) => a + b, 0);
    } finally {
      loading = false;
      await Promise.all([probeLoop, maintenanceLoop]);
    }
    const loadMs = performance.now() - started;

    // Settle: run maintenance until a run neither compacts, reclaims, nor leaves work pending.
    for (let i = 0; i < 10; i++) {
      maxWorkItemsBytes = Math.max(maxWorkItemsBytes, await indexBytes('harness_shared.work_items_bm25'));
      const r = await runBm25Maintenance(sql);
      maintenanceErrors.push(...r.errors);
      if (r.reclaimed) reclaims.push(r.reclaimed);
      const busy = r.reclaimed || r.pendingReclaims.length > 0 || r.compacted.some(c => c.stillNeeds || c.steps > 0);
      if (!busy) break;
    }

    // R-7: each index against its own REINDEX.
    const sizes: Array<{ index: string; before: number; after: number; ratio: number }> = [];
    for (const name of [...(await readBm25Indexes(sql))].sort()) {
      const qualified = `harness_shared.${name}`;
      const before = await indexBytes(qualified);
      await sql.unsafe(`REINDEX INDEX ${qualified}`);
      const after = await indexBytes(qualified);
      sizes.push({ index: qualified, before, after, ratio: before / after });
    }

    const found = probes.filter(p => Number.isFinite(p.ms)).map(p => p.ms).sort((a, b) => a - b);
    console.info(JSON.stringify({
      p008: 'bm25-write-load',
      loadMs: Math.round(loadMs),
      inserts: batches * BATCH_ROWS,
      probes: probes.length,
      probeP50Ms: found.length ? Math.round(found[Math.floor(found.length / 2)]!) : null,
      probeMaxMs: found.length ? Math.round(found[found.length - 1]!) : null,
      maxWorkItemsBytes,
      reclaims,
      sizes,
    }));

    expect(maintenanceErrors).toEqual([]);
    // R-6
    expect(probes.length).toBeGreaterThanOrEqual(MIN_PROBES);
    expect(probes.filter(p => p.kind === 'update').length).toBeGreaterThanOrEqual(10);
    expect(probes.filter(p => !Number.isFinite(p.ms) || p.ms > VISIBILITY_BOUND_MS)).toEqual([]);
    // The load really took work_items past the reclaim floor, and maintenance reclaimed it.
    expect(maxWorkItemsBytes).toBeGreaterThanOrEqual(BM25_RECLAIM_MIN_BYTES);
    expect(reclaims.some(r => r.index === 'harness_shared.work_items_bm25')).toBe(true);
    // R-7
    expect(sizes.map(s => s.index)).toContain('harness_shared.work_items_bm25');
    expect(sizes.filter(s => s.ratio > SIZE_BOUND)).toEqual([]);
  }, 900_000);
});
