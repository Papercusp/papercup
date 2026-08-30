/**
 * Recurrence guard for the ~8x memory OVER-COUNT — migration 757, plan
 * memory-corpus-hygiene-and-release-distribution-2026-08-03 item P-020,
 * decision D-013, WI-9355.
 *
 * ── What went wrong, and why a test exists at all ────────────────────────────
 *
 * `harness_shared.memory_canonical` holds TWO populations. Measured live
 * 2026-08-03: 4,108 real memories and 29,789 mem0 ENTITY-GRAPH NODES (the graph
 * index over those memories). Entity rows outnumber memories ~7:1, and until
 * migration 757 the ONLY thing separating them was the presence of a jsonb key.
 *
 * A consumer that reads this table as "the memories" therefore over-counts by
 * ~8x. That is not a hypothetical: the owning plan did exactly this, concluded
 * it had a 28k-row "fragment debris class", and drafted a purge (P-003) that
 * would have deleted the entity index and silently degraded recall. It was
 * caught by measurement, not by a test — there was no test that could fail.
 *
 * This is that test.
 *
 * ── Why it drives the REAL function and the REAL migration ───────────────────
 *
 * The load-bearing case below calls the production `readStoreCounts` — the
 * canonical "how many memories do we have" read — rather than re-typing its
 * SQL, and applies the actual 757 file rather than a re-typed copy. A guard
 * that re-declares the thing it is guarding proves only that the test's own
 * copy works: it goes green while production drifts away from it, which is the
 * failure mode this whole plan item is about.
 *
 * ⚠ `readStoreCounts` memoises GLOBALLY (one cache key, 60s TTL), so every case
 * that calls it must first `__resetStoreCountsCache()` or it will assert against
 * a previous case's numbers and pass for the wrong reason.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrationForTest, createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
import { __resetStoreCountsCache, readStoreCounts } from './knowledge-read';

const SCHEMA = 'harness_shared';

/**
 * Overridable so `scripts/mutation-probe.sh` can point this at a MUTATED COPY
 * outside the tree and prove the guard actually fails (tier 2 — never mutate
 * the shared working tree; git-sync would commit the mutant mid-probe).
 * Falsifiability was verified this way: inverting the CASE arms in the
 * migration makes cases 1 and 3 fail. Re-run:
 *   scripts/mutation-probe.sh \
 *     --file libs/papercusp/libs/db/sql/757-memory-canonical-row-kind-discriminator.sql \
 *     --mutate "s/THEN 'entity' ELSE 'memory'/THEN 'memory' ELSE 'entity'/" \
 *     --test 'PROBE_MIGRATION_757={} npm run test:file -- packages/operator-core/lib/memory/memory-entity-discriminator.integration.test.ts'
 */
const MIGRATION_757 = process.env.PROBE_MIGRATION_757 ?? join(
  __dirname, '..', '..', '..', '..',
  'libs/papercusp/libs/db/sql/757-memory-canonical-row-kind-discriminator.sql',
);

/** Mirrors the live ~7:1 skew, so a dropped filter yields an obviously wrong number. */
const ENTITY_ROWS = 7;
const MEMORY_ROWS = 1;

async function insertRow(db: FreshPgDb, payload: Record<string, unknown>) {
  await db.sql.unsafe(
    `INSERT INTO ${SCHEMA}.memory_canonical (id, payload, created_at, updated_at)
     VALUES (gen_random_uuid(), $1::text::jsonb, now(), now())`,
    [JSON.stringify(payload)],
  );
}

describe('memory_canonical row_kind discriminator — migration 757 (real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('memory-entity-discriminator');
    // `createFreshPgDb` provisions only the schema, so hand-roll the columns the
    // migration and readStoreCounts touch (same approach as the sibling
    // memory-taxonomy-backfill / federation-slug-stamp fixtures).
    await db.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.memory_canonical (
        id         UUID PRIMARY KEY,
        payload    JSONB       NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.memory_feedback (
        id         BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    await applyMigrationForTest(db.sql, MIGRATION_757);
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.sql.unsafe(`TRUNCATE ${SCHEMA}.memory_canonical CASCADE`);
    __resetStoreCountsCache();
  });

  /**
   * THE load-bearing case. If someone drops the row_kind filter from the
   * canonical count, totalMemories becomes 8 instead of 1 and this fails.
   */
  it('the canonical "how many memories" read EXCLUDES entity-graph nodes', async () => {
    for (let i = 0; i < MEMORY_ROWS; i += 1) {
      await insertRow(db, { data: 'a real memory, long enough to be a fact', user_id: 'harness:papercusp' });
    }
    for (let i = 0; i < ENTITY_ROWS; i += 1) {
      await insertRow(db, {
        data: `entity_${i}`,
        entityType: 'COMPOUND',
        linkedMemoryIds: ['00000000-0000-4000-8000-000000000000'],
      });
    }

    const counts = await readStoreCounts(db.sql);

    expect(counts.totalMemories).toBe(MEMORY_ROWS);
    expect(counts.entityRows).toBe(ENTITY_ROWS);
    // State the trap explicitly: the naive read is the total, and it is wrong.
    const [{ naive }] = (await db.sql.unsafe(
      `SELECT count(*)::int AS naive FROM ${SCHEMA}.memory_canonical`,
    )) as unknown as Array<{ naive: number }>;
    expect(naive).toBe(MEMORY_ROWS + ENTITY_ROWS);
    expect(counts.totalMemories).not.toBe(naive);
  });

  /**
   * The anti-drift property. A PLAIN row_kind column would have to be set by
   * every writer, which reintroduces exactly the silent-misclassification bug
   * this migration exists to kill. Postgres refusing the write is what makes
   * drift structurally impossible — if a future migration converts this to an
   * ordinary column, this case fails and says why.
   */
  it('row_kind is GENERATED — no writer can set it, so it cannot drift', async () => {
    await expect(
      db.sql.unsafe(
        `INSERT INTO ${SCHEMA}.memory_canonical (id, payload, row_kind)
         VALUES (gen_random_uuid(), '{}'::jsonb, 'memory')`,
      ),
    ).rejects.toThrow(/non-DEFAULT value into column "row_kind"|generated column/i);

    await insertRow(db, { data: 'x', entityType: 'PROPER', linkedMemoryIds: [] });
    await expect(
      db.sql.unsafe(`UPDATE ${SCHEMA}.memory_canonical SET row_kind = 'memory'`),
    ).rejects.toThrow(/column "row_kind" can only be updated to DEFAULT|generated column/i);
  });

  /**
   * The column must stay byte-for-byte equivalent to the PRODUCER-side rule in
   * libs/generic/memory/src/canonical-store.ts (`storeKindCond`), which is the
   * generic lib's own contract and still authoritative for other deployments.
   * If the two ever disagree the populations silently re-merge, so assert they
   * agree — including on the shapes that are easy to get wrong.
   */
  it('agrees with the producer-side `payload ? entityType` rule on every row shape', async () => {
    await insertRow(db, { data: 'plain memory' });
    await insertRow(db, { data: 'entity', entityType: 'COMPOUND' });
    // Key PRESENT but null — `?` tests key existence, not truthiness, so this is
    // an entity row. A `->>` based rule would wrongly call it a memory.
    await insertRow(db, { data: 'null-typed entity', entityType: null });
    // Key absent but a similarly-named one present — must NOT be an entity.
    await insertRow(db, { data: 'decoy', entity_type: 'COMPOUND', entityTypes: ['x'] });
    // Empty payload — no key, so a memory.
    await insertRow(db, {});

    const [{ disagreements }] = (await db.sql.unsafe(
      `SELECT count(*)::int AS disagreements FROM ${SCHEMA}.memory_canonical
        WHERE (row_kind = 'entity') <> (payload ? 'entityType')`,
    )) as unknown as Array<{ disagreements: number }>;
    expect(disagreements).toBe(0);

    const rows = (await db.sql.unsafe(
      `SELECT row_kind, count(*)::int AS n FROM ${SCHEMA}.memory_canonical
        GROUP BY row_kind ORDER BY row_kind`,
    )) as unknown as Array<{ row_kind: string; n: number }>;
    expect(rows).toEqual([
      { row_kind: 'entity', n: 2 },
      { row_kind: 'memory', n: 3 },
    ]);
  });
});
