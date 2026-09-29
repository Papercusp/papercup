/**
 * Registering a chunked collection needs no schema migration
 * (generic-rag-chunking-2026-09-29 P-003, acceptance bar R-9).
 *
 * Migration 1242 creates ONE shared chunk store, harness_shared.text_chunks,
 * keyed by (surface, parent_key text[], chunk_idx). The claim that makes it
 * shared: a new collection is a surface name plus its parents' key values, so
 * adding one is DML against the migrated schema and never DDL. A store shaped
 * around one parent's key (as migration 749's session_turn_chunks is) fails
 * that claim for every other collection.
 *
 * So, against the real migrated schema:
 *   1. the table, its key and its indexes are what the migration promises;
 *   2. two fixture collections with DIFFERENT key shapes store, embed, rank and
 *      join back to their parents while a fingerprint of the harness_shared
 *      catalog stays unchanged, i.e. no DDL was needed;
 *   3. a positive control: a real DDL statement DOES change that fingerprint,
 *      so the unchanged reading in (2) comes from an instrument that can see DDL.
 *
 * Every write happens inside a transaction that always rolls back, so the shared
 * baseline database is never left holding fixture rows or the control's DDL.
 */
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import postgres from 'postgres';
import { assertPgReachable } from '@papercusp/test-config/pg';
import { PROSE_VECTOR_COLUMNS, PROSE_VECTOR_DIMS } from '../prose-vector-dims';

const vector = (period: number): string =>
  `[${Array.from({ length: PROSE_VECTOR_DIMS }, (_, i) => ((i % period) + 1) / 10).join(',')}]`;

/** Thrown to unwind a transaction after its assertions ran. */
class Rollback extends Error {}

/** Run `fn` in a transaction that never commits. */
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

/** Every relation, column and index in harness_shared, hashed. Any DDL there moves it. */
async function schemaFingerprint(tx: postgres.TransactionSql): Promise<string> {
  const [row] = await tx.unsafe<Array<{ fp: string; n: number }>>(
    `SELECT md5(string_agg(item, E'\\n' ORDER BY item)) AS fp, count(*)::int AS n FROM (
       SELECT 'col:' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) AS item
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
        WHERE n.nspname = 'harness_shared'
       UNION ALL
       SELECT 'idx:' || indexname || ':' || indexdef FROM pg_indexes WHERE schemaname = 'harness_shared'
       UNION ALL
       SELECT 'con:' || conrelid::regclass::text || '.' || conname
         FROM pg_constraint WHERE connamespace = 'harness_shared'::regnamespace
     ) items`,
  );
  expect(row.n, 'the fingerprint measured an empty catalog').toBeGreaterThan(100);
  return row.fp;
}

describe('harness_shared.text_chunks — one store, any collection, no DDL (live SQL)', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    const dsn = inject('baselineSchemaDsn');
    await assertPgReachable(dsn, 'text-chunks-migration.integration');
    sql = postgres(dsn, { max: 1, onnotice: () => {} });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
  });

  it('is keyed by (surface, parent_key, chunk_idx), with the vector and mode indexes', async () => {
    const [pk] = await sql.unsafe<Array<{ cols: string[] }>>(
      `SELECT array_agg(a.attname ORDER BY k.ord) AS cols
         FROM pg_constraint c
         CROSS JOIN LATERAL unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord)
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum
        WHERE c.conrelid = 'harness_shared.text_chunks'::regclass AND c.contype = 'p'`,
    );
    expect(pk.cols).toEqual(['surface', 'parent_key', 'chunk_idx']);

    const [col] = await sql.unsafe<Array<{ type: string }>>(
      `SELECT format_type(atttypid, atttypmod) AS type FROM pg_attribute
        WHERE attrelid = 'harness_shared.text_chunks'::regclass AND attname = 'embedding'`,
    );
    expect(col.type).toBe(`vector(${PROSE_VECTOR_DIMS})`);
    expect(PROSE_VECTOR_COLUMNS).toContainEqual({ table: 'harness_shared.text_chunks', column: 'embedding' });

    const indexes = await sql.unsafe<Array<{ indexdef: string }>>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'harness_shared' AND tablename = 'text_chunks'`,
    );
    const defs = indexes.map((i) => i.indexdef);
    expect(defs.some((d) => /USING hnsw \(embedding vector_cosine_ops\)/.test(d))).toBe(true);
    expect(defs.some((d) => /\(embedding_mode\) WHERE \(embedding_mode IS NOT NULL\)/.test(d))).toBe(true);
  });

  it('stores two collections with different key shapes without any DDL', async () => {
    await inRolledBackTx(sql, async (tx) => {
      const before = await schemaFingerprint(tx);

      // Collection A keys its parents by one column, collection B by two.
      await tx.unsafe(
        `INSERT INTO harness_shared.text_chunks
           (surface, parent_key, chunk_idx, anchor, header, content, parent_sha, chunk_sha, splitter_version,
            embedding, embedding_mode)
         VALUES
           ('r9_fixture_a', ARRAY['plan-1'],        0, NULL,    'Plan 1', 'first window',  'pa', 'ca0', 'window@1',   $1::vector, 'gemma'),
           ('r9_fixture_a', ARRAY['plan-1'],        1, NULL,    'Plan 1', 'second window', 'pa', 'ca1', 'window@1',   $2::vector, 'gemma'),
           ('r9_fixture_a', ARRAY['plan-gone'],     0, NULL,    'Gone',   'orphan chunk',  'pg', 'cg0', 'window@1',   $1::vector, 'gemma'),
           ('r9_fixture_b', ARRAY['ws-1', 'WI-7'],  0, 'intro', 'WI-7',   'a section',     'pb', 'cb0', 'markdown@1', $2::vector, 'gemma')`,
        [vector(7), vector(5)],
      );

      // Rank by the query vector, joining back to each collection's parents.
      // The parents are VALUES lists, so the fixture itself needs no table either.
      const ranked = await tx.unsafe<Array<{ surface: string; parent_key: string[]; chunk_idx: number }>>(
        `WITH parents_a(id) AS (VALUES ('plan-1')),
              parents_b(ws, id) AS (VALUES ('ws-1', 'WI-7'))
         SELECT c.surface, c.parent_key, c.chunk_idx
           FROM harness_shared.text_chunks c
          WHERE (c.surface = 'r9_fixture_a' AND EXISTS (SELECT 1 FROM parents_a p WHERE c.parent_key = ARRAY[p.id]))
             OR (c.surface = 'r9_fixture_b' AND EXISTS (SELECT 1 FROM parents_b p WHERE c.parent_key = ARRAY[p.ws, p.id]))
          ORDER BY c.embedding <=> $1::vector, c.surface, c.chunk_idx`,
        [vector(7)],
      );
      expect(ranked.map((r) => [r.surface, r.parent_key, r.chunk_idx])).toEqual([
        ['r9_fixture_a', ['plan-1'], 0],
        ['r9_fixture_a', ['plan-1'], 1],
        ['r9_fixture_b', ['ws-1', 'WI-7'], 0],
      ]);
      // The orphan's parent is not in parents_a, so the join-back never returns it.
      expect(ranked.some((r) => r.parent_key[0] === 'plan-gone')).toBe(false);

      expect(await schemaFingerprint(tx)).toBe(before);
    });
  });

  it('the embed-backfill key round-trip binds an array parent_key', async () => {
    // embed-backfill reads a target's keys as `<col> AS k<i>` and writes back with
    // `<col> = $n` bound to the value it read. For parent_key that value is a JS
    // array, so this is the shape the TARGETS entry for this table relies on.
    await inRolledBackTx(sql, async (tx) => {
      await tx.unsafe(
        `INSERT INTO harness_shared.text_chunks
           (surface, parent_key, chunk_idx, content, parent_sha, chunk_sha, splitter_version)
         VALUES ('r9_fixture_b', ARRAY['ws-1', 'WI-7'], 0, 'a section', 'pb', 'cb0', 'markdown@1')`,
      );
      const [row] = await tx.unsafe<Array<{ k0: string; k1: string[]; k2: number }>>(
        `SELECT surface AS k0, parent_key AS k1, chunk_idx AS k2 FROM harness_shared.text_chunks
          WHERE surface = 'r9_fixture_b' AND embedding IS NULL`,
      );
      expect(row.k1).toEqual(['ws-1', 'WI-7']);
      const updated = await tx.unsafe(
        `UPDATE harness_shared.text_chunks SET embedding = $1::vector, embedding_mode = 'gemma'
          WHERE surface = $2 AND parent_key = $3 AND chunk_idx = $4`,
        [vector(3), row.k0, row.k1, row.k2],
      );
      expect(updated.count).toBe(1);
    });
  });

  it('positive control: DDL in harness_shared does move the fingerprint', async () => {
    await inRolledBackTx(sql, async (tx) => {
      const before = await schemaFingerprint(tx);
      await tx.unsafe(`CREATE INDEX r9_control_idx ON harness_shared.text_chunks (splitter_version)`);
      expect(await schemaFingerprint(tx)).not.toBe(before);
    });
  });

  it('refuses rows that no collection could own', async () => {
    const bad = [
      [`''`, `ARRAY['x']`, 0],
      [`'s'`, `ARRAY[]::text[]`, 0],
      [`'s'`, `ARRAY['x']`, -1],
    ] as const;
    for (const [surface, key, idx] of bad) {
      await expect(
        inRolledBackTx(sql, async (tx) => {
          await tx.unsafe(
            `INSERT INTO harness_shared.text_chunks
               (surface, parent_key, chunk_idx, content, parent_sha, chunk_sha, splitter_version)
             VALUES (${surface}, ${key}, ${idx}, 'c', 'p', 'c', 'v')`,
          );
        }),
        `${surface} ${key} ${idx}`,
      ).rejects.toThrow(/violates check constraint/);
    }
  });
});
