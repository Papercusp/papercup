/**
 * federated-vec-backfill REAL-PG tests (EI-10405) — the SELECT predicate that
 * decides which memories semantic recall currently cannot see.
 *
 * The orchestration (skip-when-disabled, batch bound, non-fatal rows) is unit-
 * tested in `federated-vec-backfill.test.ts` with injected deps. What only a real
 * Postgres can prove is the predicate itself: a `NOT EXISTS` join against the
 * active mode's vec table, the `source_hive IS NOT NULL` federation filter, and
 * the entity/archived/empty guards. A fake sql happily "passes" a predicate that
 * silently matches nothing — which is exactly the class of bug this fix is about.
 *
 * `createFreshPgDb` provisions only `harness_shared` + the fed-order-key fns, so
 * (mirroring memory-federation-privacy.integration.test.ts) this hand-rolls the
 * columns the predicate reads. Two deliberate deviations from prod DDL, neither
 * touched by the code under test: `memory_vec_local.vector` is TEXT here (pgvector
 * is not installed in a fresh test DB, and the predicate only checks memory_id
 * EXISTENCE, never the vector value), and memory_canonical carries only the
 * columns this query reads.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  backfillFederatedMemoryVectors,
  selectFederatedRowsMissingVectors,
} from './federated-vec-backfill';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const SCHEMA = 'harness_shared';
const VEC = 'memory_vec_local';

// Stable UUIDs — memory_canonical.id is a uuid, so these must parse.
const REMOTE_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REMOTE_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REMOTE_EMBEDDED = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LOCAL_ROW = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const REMOTE_ENTITY = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const REMOTE_ARCHIVED = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const REMOTE_EMPTY = '11111111-1111-4111-8111-111111111111';

describe('federated memory vector backfill — the predicate (real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('fed-vec-backfill');
    await db.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.memory_canonical (
        id          UUID PRIMARY KEY,
        payload     JSONB       NOT NULL,
        state       TEXT        NOT NULL DEFAULT 'active',
        source_hive TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.${VEC} (
        memory_id   UUID PRIMARY KEY
                    REFERENCES ${SCHEMA}.memory_canonical(id) ON DELETE CASCADE,
        vector      TEXT,
        embedded_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
  });

  afterAll(async () => {
    await db.cleanup();
  });

  beforeEach(async () => {
    await db.sql.unsafe(`TRUNCATE ${SCHEMA}.memory_canonical CASCADE`);
    // Two federated rows with no vector — the rows recall is blind to today.
    // created_at is staggered so the newest-first ordering is assertable.
    await db.sql.unsafe(`
      INSERT INTO ${SCHEMA}.memory_canonical (id, payload, state, source_hive, created_at) VALUES
        ('${REMOTE_A}', '{"data":"peer memory A","user_id":"u1"}'::jsonb, 'active', 'peer-log-key-1', now() - interval '2 min'),
        ('${REMOTE_B}', '{"data":"peer memory B","user_id":"u1"}'::jsonb, 'active', 'peer-log-key-2', now() - interval '1 min'),
        -- already embedded here: must NOT be re-embedded (idempotence).
        ('${REMOTE_EMBEDDED}', '{"data":"peer memory already embedded","user_id":"u1"}'::jsonb, 'active', 'peer-log-key-1', now()),
        -- LOCAL row (NULL partition) with no vector: out of scope by design —
        -- that is the user-initiated /reembed path, not this background sweep.
        ('${LOCAL_ROW}', '{"data":"my own local memory","user_id":"u1"}'::jsonb, 'active', NULL, now()),
        -- mem0 entity-linking row, archived row, empty-text row: never recallable memories.
        ('${REMOTE_ENTITY}', '{"data":"some entity","entityType":"COMPOUND"}'::jsonb, 'active', 'peer-log-key-1', now()),
        ('${REMOTE_ARCHIVED}', '{"data":"archived peer memory","user_id":"u1"}'::jsonb, 'archived', 'peer-log-key-1', now()),
        ('${REMOTE_EMPTY}', '{"data":"","user_id":"u1"}'::jsonb, 'active', 'peer-log-key-1', now());
      INSERT INTO ${SCHEMA}.${VEC} (memory_id, vector) VALUES ('${REMOTE_EMBEDDED}', '[0.1,0.2]');
    `);
  });

  it('selects exactly the federated rows that have no vector in the active mode table', async () => {
    const rows = await selectFederatedRowsMissingVectors(db.sql, SCHEMA, VEC, 25);
    // Newest-first: B (1 min ago) before A (2 min ago). Everything else excluded:
    // already-embedded, local-partition, entity, archived, empty-text.
    expect(rows.map((r) => r.id)).toEqual([REMOTE_B, REMOTE_A]);
    expect(rows[0]?.data).toBe('peer memory B');
  });

  it('a LOCAL row missing a vector is never touched (the sweep is federated-only)', async () => {
    const rows = await selectFederatedRowsMissingVectors(db.sql, SCHEMA, VEC, 25);
    expect(rows.map((r) => r.id)).not.toContain(LOCAL_ROW);
  });

  it('a federated row that already has a vector is not re-embedded', async () => {
    const rows = await selectFederatedRowsMissingVectors(db.sql, SCHEMA, VEC, 25);
    expect(rows.map((r) => r.id)).not.toContain(REMOTE_EMBEDDED);
  });

  it('honors the batch limit', async () => {
    const rows = await selectFederatedRowsMissingVectors(db.sql, SCHEMA, VEC, 1);
    expect(rows.map((r) => r.id)).toEqual([REMOTE_B]);
  });

  it('once a row is embedded it leaves the queue — the sweep converges', async () => {
    const embedded: string[] = [];
    // Real SQL + real predicate; the EMBEDDER is the only stub (no sidecar in a
    // unit rig) — it writes the vec row exactly as embedAndUpsertVector does.
    const embed = async (id: string) => {
      await db.sql.unsafe(
        `INSERT INTO ${SCHEMA}.${VEC} (memory_id, vector) VALUES ($1, '[0.3]')
         ON CONFLICT (memory_id) DO UPDATE SET vector = EXCLUDED.vector`,
        [id],
      );
      embedded.push(id);
      return true;
    };
    const deps = {
      sql: db.sql,
      resolveVecTable: async () => ({ mode: 'local' as const, schema: SCHEMA, table: VEC }),
      embed,
    };

    const first = await backfillFederatedMemoryVectors(deps);
    expect(first).toEqual({ scanned: 2, embedded: 2, failed: 0 });
    expect(embedded).toEqual([REMOTE_B, REMOTE_A]);

    // The whole point: those memories are now visible to the vector-join recall
    // path, and the next tick finds nothing left to do.
    const second = await backfillFederatedMemoryVectors(deps);
    expect(second).toEqual({ scanned: 0, embedded: 0, failed: 0 });
  });

  it('a failed embed leaves the row queued for the next tick (self-healing)', async () => {
    const deps = {
      sql: db.sql,
      resolveVecTable: async () => ({ mode: 'local' as const, schema: SCHEMA, table: VEC }),
      embed: async () => false, // embedder down / quota-cooled
    };
    const r = await backfillFederatedMemoryVectors(deps);
    expect(r).toEqual({ scanned: 2, embedded: 0, failed: 2 });
    // Still queued — an outage delays recall, it never permanently loses it.
    const stillQueued = await selectFederatedRowsMissingVectors(db.sql, SCHEMA, VEC, 25);
    expect(stillQueued.map((r2) => r2.id)).toEqual([REMOTE_B, REMOTE_A]);
  });
});
