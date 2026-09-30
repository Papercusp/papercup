/**
 * The planner's row estimate for a parent-key filter on the shared chunk store
 * (generic-rag-chunking-2026-09-29 P-015, acceptance bar R-33, migration 1266).
 *
 * Every chunk-aware vector leg joins chunks to parents through
 * `parent.<key_i> = c.parent_key[i]`. A constant parent filter (a workspace, a
 * harness) makes the planner derive `c.parent_key[i] = <constant>`. Without
 * statistics on that expression it assumes 0.005 selectivity per position, so a
 * two-position filter over 21,257 plan chunks was estimated at 1 row. Trusting that,
 * it sorted every chunk of the surface exactly instead of using the HNSW index:
 * ~150-190 ms per leg on the live DB instead of ~2-8 ms. Migration 1266 adds one
 * expression-statistics object per key position.
 *
 * Against the real migrated schema, inside transactions that always roll back:
 *   1. a statistics object exists on `parent_key[i]` for every position of the
 *      widest key registered on the shared table, so a collection registered with a wider key fails
 *      here instead of silently regressing to exact scans;
 *   2. with those objects, the estimate for a two-position constant filter over
 *      a seeded surface is within a factor of 2 of the seeded row count;
 *   3. the control: after dropping them in the same transaction, the identical
 *      query's estimate collapses to a few rows, so (2) measures the statistics
 *      and not some other source of the estimate.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';
import { CHUNK_SURFACES, TEXT_CHUNKS_TABLE, surfaceStoreTable } from './registry';

/** Thrown to unwind a transaction after its assertions ran. */
class Rollback extends Error {}

async function inRolledBackTx(sql: postgres.Sql, fn: (tx: postgres.TransactionSql) => Promise<void>): Promise<void> {
  await sql
    .begin(async (tx) => {
      await fn(tx);
      throw new Rollback();
    })
    .catch((e: unknown) => {
      if (!(e instanceof Rollback)) throw e;
    });
}

const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SURFACE = `zzz_pk_stats_${STAMP}`;
const WS = `zzz-ws-${STAMP}`;
const HARNESS = `zzz-h-${STAMP}`;
const SEEDED = 600;

/** Statistics objects on harness_shared.text_chunks, as their expression text. */
async function parentKeyStatsExpressions(tx: postgres.TransactionSql): Promise<string[]> {
  const rows = await tx<Array<{ def: string }>>`
    SELECT pg_get_statisticsobjdef(s.oid) AS def
      FROM pg_statistic_ext s
     WHERE s.stxrelid = 'harness_shared.text_chunks'::regclass`;
  return rows.map((r) => r.def);
}

/** Seed SEEDED chunk rows of one fixture surface under one (workspace, harness). */
async function seed(tx: postgres.TransactionSql): Promise<void> {
  // NULL embeddings: the estimate under test does not depend on vectors, and a
  // NULL is not added to the HNSW index, which keeps the insert cheap.
  await tx`
    INSERT INTO harness_shared.text_chunks
      (surface, parent_key, chunk_idx, content, parent_sha, chunk_sha, splitter_version)
    SELECT ${SURFACE}, ARRAY[${WS}::text, ${HARNESS}::text, 'plan-' || (g / 4)::text], g % 4,
           'fixture', 'p', 'c' || g::text, 'fixture'
      FROM generate_series(0, ${SEEDED - 1}) g`;
  await tx`ANALYZE harness_shared.text_chunks`;
}

/** The planner's estimated row count for the derived two-position filter. */
async function estimate(tx: postgres.TransactionSql): Promise<number> {
  const [row] = await tx.unsafe<Array<{ 'QUERY PLAN': Array<{ Plan: { 'Plan Rows': number } }> }>>(
    `EXPLAIN (FORMAT JSON)
     SELECT 1 FROM harness_shared.text_chunks c
      WHERE c.surface = $1 AND c.parent_key[1] = $2 AND c.parent_key[2] = $3`,
    [SURFACE, WS, HARNESS],
  );
  return row['QUERY PLAN'][0].Plan['Plan Rows'];
}

describe('harness_shared.text_chunks parent-key statistics (live SQL)', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    const dsn = inject('baselineSchemaDsn');
    await assertPgReachable(dsn, 'text-chunks-parent-key-stats.integration');
    sql = postgres(dsn, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('has a statistics object on parent_key[i] for every position of the widest registered key', async () => {
    // Only surfaces stored in the shared table: session turns keep their own store
    // (session_turn_chunks, typed key columns), which this migration does not cover.
    const shared = CHUNK_SURFACES.filter((s) => surfaceStoreTable(s) === TEXT_CHUNKS_TABLE);
    expect(shared.length, 'no registered surface uses the shared chunk table').toBeGreaterThan(0);
    const widest = Math.max(...shared.map((s) => s.parent.key.length));
    await inRolledBackTx(sql, async (tx) => {
      const defs = await parentKeyStatsExpressions(tx);
      for (let i = 1; i <= widest; i++) {
        expect(
          defs.some((d) => d.includes(`(parent_key[${i}])`)),
          `no statistics on parent_key[${i}]; a surface keyed on ${widest} columns is registered (see migration 1266)`,
        ).toBe(true);
      }
    });
  });

  it('estimates a constant two-position parent-key filter within a factor of 2 of the real count', async () => {
    await inRolledBackTx(sql, async (tx) => {
      await seed(tx);
      const est = await estimate(tx);
      expect(est).toBeGreaterThanOrEqual(SEEDED / 2);
      expect(est).toBeLessThanOrEqual(SEEDED * 2);
    });
  });

  it('control: without the statistics the same estimate collapses to a few rows', async () => {
    await inRolledBackTx(sql, async (tx) => {
      const names = await tx<Array<{ name: string }>>`
        SELECT stxnamespace::regnamespace::text || '.' || stxname AS name
          FROM pg_statistic_ext WHERE stxrelid = 'harness_shared.text_chunks'::regclass`;
      expect(names.length, 'the control has nothing to drop, so it cannot show anything').toBeGreaterThan(0);
      for (const { name } of names) await tx.unsafe(`DROP STATISTICS ${name}`);
      await seed(tx);
      const est = await estimate(tx);
      expect(est).toBeLessThan(SEEDED / 20);
    });
  });
});
