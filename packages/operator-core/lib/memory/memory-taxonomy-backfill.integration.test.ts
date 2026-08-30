/**
 * memory-taxonomy-backfill REAL-PG tests — migration 747 (plan
 * memory-corpus-hygiene-and-release-distribution-2026-08-03, P-005).
 *
 * The migration backfills `payload.scope` (derived from the pool prefix mem0
 * stores in `payload.user_id`) and `payload.kind` (defaulted to 'reference')
 * on real memories that carry neither. What only a real Postgres can prove is
 * the DERIVATION and — far more importantly — the EXCLUSION:
 *
 *   `harness_shared.memory_canonical` holds two populations. 4,096 rows are
 *   memories; 29,538 are mem0 ENTITY-GRAPH NODES, the graph index over those
 *   memories, discriminated only by `payload->'entityType'`. Entity nodes
 *   correctly carry no taxonomy and must never be given one. A backfill that
 *   quietly taxonomised them would look successful — the gap would close, the
 *   counts would move the right way — while corrupting ~88% of the table into
 *   rows that Phase 2 distribution selection would then treat as shippable
 *   facts. That failure is invisible to any test that only asserts the gap
 *   closed, which is why the entity-node canary here is the load-bearing case.
 *
 * This runs the ACTUAL migration file, not a re-typed copy — a test that
 * re-declares the UPDATE proves only that the test's own SQL works.
 *
 * `createFreshPgDb` provisions only `harness_shared`, so (mirroring
 * federation-slug-stamp.integration.test.ts) this hand-rolls the columns the
 * migration touches: payload, plus `updated_at`, which it bumps.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const SCHEMA = 'harness_shared';

const MIGRATION = join(
  __dirname, '..', '..', '..', '..',
  'libs/papercusp/libs/db/sql/747-backfill-memory-taxonomy-scope-kind.sql',
);

const MIGRATION_SQL = readFileSync(MIGRATION, 'utf8')
  .split('\n').filter((l) => !l.trimStart().startsWith('\\')).join('\n');

const HARNESS_ROW = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const HIVE_ROW = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const BENCH_ROW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const USER_ROW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ENTITY_ROW = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TAXONOMISED_ROW = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const NO_USER_ROW = '11111111-1111-4111-8111-111111111111';

/** Exactly the INSERT mem0's canonical vector store issues: payload + timestamps. */
async function insertRow(db: FreshPgDb, id: string, payload: Record<string, unknown>) {
  await db.sql.unsafe(
    `INSERT INTO ${SCHEMA}.memory_canonical (id, payload, created_at, updated_at)
     VALUES ($1, $2::text::jsonb, now(), now())`,
    [id, JSON.stringify(payload)],
  );
}

async function payloadOf(db: FreshPgDb, id: string): Promise<Record<string, unknown>> {
  const rows = await db.sql.unsafe(
    `SELECT payload FROM ${SCHEMA}.memory_canonical WHERE id = $1`, [id],
  );
  return (rows as unknown as Array<{ payload: Record<string, unknown> }>)[0]?.payload ?? {};
}

const applyMigration = (db: FreshPgDb) => db.sql.unsafe(MIGRATION_SQL);

describe('memory taxonomy backfill — migration 747 (real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('memory-taxonomy-backfill');
    await db.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.memory_canonical (
        id         UUID PRIMARY KEY,
        payload    JSONB       NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.sql.unsafe(`TRUNCATE ${SCHEMA}.memory_canonical CASCADE`);
  });

  it('derives scope from the pool prefix mem0 stored in user_id', async () => {
    await insertRow(db, HARNESS_ROW, { data: 'a', hash: 'h1', user_id: 'harness:papercusp', kind: 'reference' });
    await insertRow(db, HIVE_ROW, { data: 'b', hash: 'h2', user_id: 'hive:some-hive', kind: 'feedback' });
    await insertRow(db, USER_ROW, { data: 'c', hash: 'h3', user_id: '120f421b-25c9-47f7-8e3b-329c0edd4bf2', kind: 'project' });

    await applyMigration(db);

    expect((await payloadOf(db, HARNESS_ROW)).scope).toBe('harness');
    expect((await payloadOf(db, HIVE_ROW)).scope).toBe('hive');
    expect((await payloadOf(db, USER_ROW)).scope).toBe('user');
  });

  it('keeps bench FIXTURES in their own scope — never laundered into a real pool', async () => {
    // 342 live rows are recall-benchmark fixtures (BENCH_SCOPE = 'bench',
    // bench/run-bench.ts) seeded into the canonical table and never swept.
    // Giving them 'user'/'harness' would make them eligible for Phase 2
    // distribution — i.e. another project's fixture text shipped in a public
    // release. A distinct value makes a selector that admits only real pools
    // exclude them by construction rather than by remembering to.
    await insertRow(db, BENCH_ROW, {
      data: 'fixture text from another project', hash: 'h4',
      user_id: 'bench', kind: 'reference', corpus_key: 'restart-corpus',
    });

    await applyMigration(db);

    const p = await payloadOf(db, BENCH_ROW);
    expect(p.scope).toBe('bench');
    expect(p.scope).not.toBe('user');
    expect(p.scope).not.toBe('harness');
  });

  it('NEVER taxonomises a mem0 entity-graph node (the load-bearing exclusion, D-013)', async () => {
    // Entity nodes are the graph INDEX over memories, not facts. They are ~88%
    // of the table, so a backfill that caught them would close the gap and
    // still be catastrophic: Phase 2 would read them as shippable knowledge.
    await insertRow(db, ENTITY_ROW, {
      data: 'papercusp', hash: 'h5', user_id: 'harness:papercusp',
      entityType: 'COMPOUND', linkedMemoryIds: [HARNESS_ROW],
    });

    await applyMigration(db);

    const p = await payloadOf(db, ENTITY_ROW);
    expect(p.scope).toBeUndefined();
    expect(p.kind).toBeUndefined();
    expect(p.scope_provenance).toBeUndefined();
    expect(p.kind_provenance).toBeUndefined();
    // untouched, not merely un-taxonomised
    expect(p.entityType).toBe('COMPOUND');
    expect(p.data).toBe('papercusp');
  });

  it("defaults a missing kind to 'reference' and stamps it as DERIVED, not authored", async () => {
    await insertRow(db, HARNESS_ROW, { data: 'a runbook pointer', hash: 'h6', user_id: 'harness:papercusp' });

    await applyMigration(db);

    const p = await payloadOf(db, HARNESS_ROW);
    expect(p.kind).toBe('reference');
    // Provenance is what lets Phase 2 tell an inferred taxonomy from a chosen one.
    expect(p.kind_provenance).toBe('migration-747:defaulted-reference');
    expect(p.scope_provenance).toBe('migration-747:derived-from-user_id');
  });

  it('never overwrites a taxonomy the writing agent actually chose', async () => {
    await insertRow(db, TAXONOMISED_ROW, {
      data: 'an authored fact', hash: 'h7',
      user_id: 'harness:papercusp', scope: 'workspace', kind: 'feedback',
    });

    await applyMigration(db);

    const p = await payloadOf(db, TAXONOMISED_ROW);
    // 'workspace' is an out-of-enum value 24 live rows carry; the backfill must
    // leave it alone rather than "correcting" it to the derived 'harness'.
    expect(p.scope).toBe('workspace');
    expect(p.kind).toBe('feedback');
    expect(p.scope_provenance).toBeUndefined();
    expect(p.kind_provenance).toBeUndefined();
  });

  it('leaves scope MISSING when it is genuinely underivable (no user_id) rather than guessing', async () => {
    await insertRow(db, NO_USER_ROW, { data: 'orphan', hash: 'h8' });

    // The postcondition must not fire for this row either — an underivable
    // scope is a known-unknown, not a failed backfill.
    await expect(applyMigration(db)).resolves.toBeDefined();

    const p = await payloadOf(db, NO_USER_ROW);
    expect(p.scope).toBeUndefined();
    expect(p.kind).toBe('reference'); // kind needs no user_id
  });

  it('is idempotent — re-applying changes nothing', async () => {
    await insertRow(db, HARNESS_ROW, { data: 'a', hash: 'h9', user_id: 'harness:papercusp' });

    await applyMigration(db);
    const first = await payloadOf(db, HARNESS_ROW);
    const firstUpdatedAt = await db.sql.unsafe(
      `SELECT updated_at FROM ${SCHEMA}.memory_canonical WHERE id = $1`, [HARNESS_ROW],
    );

    await applyMigration(db);
    const second = await payloadOf(db, HARNESS_ROW);
    const secondUpdatedAt = await db.sql.unsafe(
      `SELECT updated_at FROM ${SCHEMA}.memory_canonical WHERE id = $1`, [HARNESS_ROW],
    );

    expect(second).toEqual(first);
    // The second pass must not even touch the row (the WHERE no longer matches).
    expect(secondUpdatedAt).toEqual(firstUpdatedAt);
  });

  it('preserves the memory CONTENT — no re-embedding is implied', async () => {
    const created = '2026-06-11T10:00:00.000Z';
    await insertRow(db, HARNESS_ROW, {
      data: 'the exact body', hash: 'deadbeef',
      user_id: 'harness:papercusp', createdAt: created, updatedAt: created,
    });

    await applyMigration(db);

    const p = await payloadOf(db, HARNESS_ROW);
    expect(p.data).toBe('the exact body');
    expect(p.hash).toBe('deadbeef');
    // mem0's own timestamps are not the row's; the backfill must not move them.
    expect(p.createdAt).toBe(created);
    expect(p.updatedAt).toBe(created);
  });

  it('closes the gap it exists to close — the postcondition is real', async () => {
    await insertRow(db, HARNESS_ROW, { data: 'a', hash: 'i1', user_id: 'harness:papercusp' });
    await insertRow(db, BENCH_ROW, { data: 'b', hash: 'i2', user_id: 'bench' });
    await insertRow(db, USER_ROW, { data: 'c', hash: 'i3', user_id: 'u-1' });
    await insertRow(db, ENTITY_ROW, { data: 'e', hash: 'i4', user_id: 'harness:papercusp', entityType: 'PROPER' });

    await applyMigration(db);

    const rows = await db.sql.unsafe(`
      SELECT count(*) FILTER (WHERE NOT (payload ? 'scope')) AS missing_scope,
             count(*) FILTER (WHERE NOT (payload ? 'kind'))  AS missing_kind
        FROM ${SCHEMA}.memory_canonical
       WHERE NOT (payload ? 'entityType')
    `);
    const r = (rows as unknown as Array<{ missing_scope: string; missing_kind: string }>)[0];
    expect(Number(r.missing_scope)).toBe(0);
    expect(Number(r.missing_kind)).toBe(0);
  });
});
