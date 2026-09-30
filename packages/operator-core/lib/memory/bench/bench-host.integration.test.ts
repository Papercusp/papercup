/**
 * WI-10004107 recurrence guard, real-PG half: `ensureBenchSchema` must produce a
 * bench schema whose tables ACCEPT the writes the live tables accept.
 *
 * For four weeks after migration 1093 it did not. The bench cloned
 * `memory_vec_<mode>` with `LIKE ... INCLUDING ALL`, which kept the new
 * `row_kind NOT NULL` and dropped the trigger that fills it. Every vector insert
 * failed, seedCorpus counted the failures without reporting them, and every
 * hybrid-pg bench scored an empty store. This file runs against a database built
 * from the real migrations, so the next migration that adds a trigger (or another
 * constraint a clone cannot satisfy) fails here instead of inside a bench number.
 *
 * The first case is the direct regression: on the pre-fix ensureBenchSchema the
 * vec insert throws `null value in column "row_kind"`.
 */
import { Client } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOrgTestDb, type OrgTestDb } from '../../../test/_org-test-db';
import { dropBenchSchema, ensureBenchSchema } from './bench-host';
import { BENCH_TRIGGER_FUNCTION_POLICY } from './bench-triggers';

const SCHEMA = `bench_memory_${process.pid}`;
const VEC = 'memory_vec_harrier'; // 1024-dim, the active embedding mode
const DIMS = 1024;

interface TriggerRow {
  table: string;
  trigger: string;
  fn: string;
  fnSchema: string;
  def: string;
}

async function triggersIn(client: Client, schema: string): Promise<TriggerRow[]> {
  const { rows } = await client.query<TriggerRow>(
    `SELECT c.relname AS "table", t.tgname AS "trigger", p.proname AS fn, pn.nspname AS "fnSchema",
            pg_get_triggerdef(t.oid) AS def
       FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_proc p ON p.oid = t.tgfoid
       JOIN pg_namespace pn ON pn.oid = p.pronamespace
      WHERE NOT t.tgisinternal AND n.nspname = $1
        AND (c.relname = 'memory_canonical' OR c.relname LIKE 'memory\\_vec\\_%')
      ORDER BY 1, 2`,
    [schema],
  );
  return rows;
}

describe('ensureBenchSchema reproduces the live memory tables (real PG, WI-10004107)', () => {
  let db: OrgTestDb;
  let client: Client;

  beforeAll(async () => {
    db = await createOrgTestDb();
    client = new Client({ connectionString: db.adminDsn });
    await client.connect();
    await ensureBenchSchema(client, SCHEMA);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await dropBenchSchema(client, SCHEMA).catch(() => {});
      await client.end().catch(() => {});
    }
    await db?.cleanup();
  });

  it('accepts a vector row and stamps row_kind from the BENCH canonical row (the 1093 regression)', async () => {
    const canon = await client.query<{ id: string; row_kind: string }>(
      `INSERT INTO ${SCHEMA}.memory_canonical (payload, state, created_at, updated_at)
       VALUES ($1::jsonb, 'active', now(), now()) RETURNING id::text, row_kind`,
      [JSON.stringify({ user_id: 'bench-it', data: 'the bench vector row must land' })],
    );
    const id = canon.rows[0].id;
    expect(canon.rows[0].row_kind).toBeTruthy();

    // No row_kind supplied, exactly like CanonicalVectorStore.insert.
    await client.query(
      `INSERT INTO ${SCHEMA}.${VEC} (memory_id, vector) VALUES ($1, array_fill(0.01::real, ARRAY[${DIMS}])::vector)`,
      [id],
    );
    const vec = await client.query<{ row_kind: string }>(`SELECT row_kind FROM ${SCHEMA}.${VEC} WHERE memory_id = $1`, [id]);
    expect(vec.rows).toEqual([{ row_kind: canon.rows[0].row_kind }]);
  });

  it('CONTROL: the pre-fix LIKE-only clone rejects the same insert (the case above can fail)', async () => {
    const ctl = `bench_memory_ctl_${process.pid}`;
    try {
      await client.query(`DROP SCHEMA IF EXISTS ${ctl} CASCADE`);
      await client.query(`CREATE SCHEMA ${ctl}`);
      for (const t of ['memory_canonical', VEC]) {
        await client.query(`CREATE TABLE ${ctl}.${t} (LIKE harness_shared.${t} INCLUDING ALL)`);
      }
      const canon = await client.query<{ id: string }>(
        `INSERT INTO ${ctl}.memory_canonical (payload, state, created_at, updated_at)
         VALUES ($1::jsonb, 'active', now(), now()) RETURNING id::text`,
        [JSON.stringify({ user_id: 'bench-it', data: 'control row' })],
      );
      await expect(
        client.query(
          `INSERT INTO ${ctl}.${VEC} (memory_id, vector) VALUES ($1, array_fill(0.01::real, ARRAY[${DIMS}])::vector)`,
          [canon.rows[0].id],
        ),
      ).rejects.toThrow(/null value in column "row_kind"/);
    } finally {
      await client.query(`DROP SCHEMA IF EXISTS ${ctl} CASCADE`);
    }
  });

  it('installs every live trigger the policy clones, and none it skips', async () => {
    const live = await triggersIn(client, 'harness_shared');
    const bench = await triggersIn(client, SCHEMA);
    // Positive control: the migrated DB really carries 1093's stamp triggers, so an
    // empty comparison below could not pass vacuously.
    expect(live.filter((t) => t.fn === 'stamp_memory_vec_row_kind').length).toBeGreaterThanOrEqual(4);

    const expected = live
      .filter((t) => BENCH_TRIGGER_FUNCTION_POLICY[t.fn]?.action === 'clone')
      .map((t) => `${t.table}.${t.trigger}`);
    expect(bench.map((t) => `${t.table}.${t.trigger}`)).toEqual(expected);
  });

  it('confines every bench trigger to the bench schema', async () => {
    const bench = await triggersIn(client, SCHEMA);
    expect(bench.length).toBeGreaterThan(0);
    for (const t of bench) {
      expect(t.fnSchema).toBe(SCHEMA);
      expect(t.def).not.toMatch(/harness_shared/);
    }
  });

  it('every live trigger function on these tables is classified (so the bench cannot refuse at run time)', async () => {
    const live = await triggersIn(client, 'harness_shared');
    const unclassified = [...new Set(live.map((t) => t.fn))].filter((fn) => !BENCH_TRIGGER_FUNCTION_POLICY[fn]);
    expect(unclassified).toEqual([]);
  });
});
