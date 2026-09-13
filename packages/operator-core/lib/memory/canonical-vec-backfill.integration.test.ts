/**
 * canonical-vec-backfill REAL-PG tests (EI-10405, WI-7326) — the SELECT predicate
 * that decides which memories semantic recall currently cannot see.
 *
 * The orchestration (skip-when-disabled, batch bound, non-fatal rows) is unit-
 * tested in `canonical-vec-backfill.test.ts` with injected deps. What only a real
 * Postgres can prove is the predicate itself: a `NOT EXISTS` join against the
 * active mode's vec table, the entity/archived/empty guards, and — since WI-7326 —
 * the ABSENCE of any `source_hive` filter. A fake sql happily "passes" a predicate
 * that silently matches nothing, which is exactly the class of bug this is about.
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
  backfillCanonicalMemoryVectors,
  selectRowsMissingVectors,
} from './canonical-vec-backfill';
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

// Newest-first, which is the order the predicate returns and every expectation
// below relies on: LOCAL_ROW (now) > REMOTE_B (-1min) > REMOTE_A (-2min).
const ALL_ELIGIBLE = [LOCAL_ROW, REMOTE_B, REMOTE_A];

describe('canonical memory vector backfill — the predicate (real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('canon-vec-backfill');
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
    // WI-5188 (same class as WI-5194/WI-5195): guard against `db` never being
    // assigned when beforeAll itself fails (dev-PG crash-recovery / a dropped
    // testcontainer connection) — an unconditional db.cleanup() cascades into a
    // confusing secondary NPE that masks the real infra error.
    if (db) await db.cleanup();
  });

  beforeEach(async () => {
    await db.sql.unsafe(`TRUNCATE ${SCHEMA}.memory_canonical CASCADE`);
    // Federated and local rows with no vector — the rows recall is blind to today.
    // created_at is staggered so the newest-first ordering is assertable.
    await db.sql.unsafe(`
      INSERT INTO ${SCHEMA}.memory_canonical (id, payload, state, source_hive, created_at) VALUES
        ('${REMOTE_A}', '{"data":"peer memory A","user_id":"u1"}'::jsonb, 'active', 'peer-log-key-1', now() - interval '2 min'),
        ('${REMOTE_B}', '{"data":"peer memory B","user_id":"u1"}'::jsonb, 'active', 'peer-log-key-2', now() - interval '1 min'),
        -- already embedded here: must NOT be re-embedded (idempotence).
        ('${REMOTE_EMBEDDED}', '{"data":"peer memory already embedded","user_id":"u1"}'::jsonb, 'active', 'peer-log-key-1', now()),
        -- LOCAL row (NULL partition) with no vector: IN scope since WI-7326 —
        -- nothing else will ever embed it (see the dedicated test below).
        ('${LOCAL_ROW}', '{"data":"my own local memory","user_id":"u1"}'::jsonb, 'active', NULL, now()),
        -- mem0 entity-linking row, archived row, empty-text row: never recallable memories.
        ('${REMOTE_ENTITY}', '{"data":"some entity","entityType":"COMPOUND"}'::jsonb, 'active', 'peer-log-key-1', now()),
        ('${REMOTE_ARCHIVED}', '{"data":"archived peer memory","user_id":"u1"}'::jsonb, 'archived', 'peer-log-key-1', now()),
        ('${REMOTE_EMPTY}', '{"data":"","user_id":"u1"}'::jsonb, 'active', 'peer-log-key-1', now());
      INSERT INTO ${SCHEMA}.${VEC} (memory_id, vector) VALUES ('${REMOTE_EMBEDDED}', '[0.1,0.2]');
    `);
  });

  it('selects exactly the rows that have no vector in the active mode table', async () => {
    const rows = await selectRowsMissingVectors(db.sql, SCHEMA, VEC, 25);
    // Newest-first. Everything else excluded: already-embedded, entity,
    // archived, empty-text.
    expect(rows.map((r) => r.id)).toEqual(ALL_ELIGIBLE);
    expect(rows[1]?.data).toBe('peer memory B');
  });

  /**
   * WI-7326 — the regression this sweep's scope was WIDENED to fix. This
   * assertion is deliberately the exact INVERSE of the one it replaces ("a LOCAL
   * row missing a vector is never touched"), so re-narrowing the predicate reds
   * here instead of silently killing recall.
   *
   * The old `source_hive IS NOT NULL` filter was justified by: local rows missing
   * a vector are mode-switch residue, and belong to the user-initiated /reembed
   * pass — "federated rows have no such path, NOTHING ELSE WILL EVER EMBED THEM."
   * That last clause is the real criterion, and migration 727 falsified it for
   * local rows: widening `memory_vec_gemma`/`memory_vec_openai` to 768 had to
   * DELETE every row (the columns are NOT NULL and pgvector cannot cast widths),
   * which is a SAME-MODE wipe that no path repairs —
   *
   *   - `reembedMemories` throws `reembed_noop_same_mode` when from === to, and
   *     otherwise needs a `JOIN <fromTable>`: it copies a vector between modes, it
   *     cannot rebuild one from text.
   *   - embed-backfill's TARGETS sweep only ever UPDATEs rows that still exist.
   *
   * Live effect when it fired: 32,641 canonical rows, ZERO federated, so this
   * predicate matched nothing at all and workspace semantic recall silently ran
   * lexical-only.
   */
  it('a LOCAL row missing a vector IS selected — nothing else will ever embed it (WI-7326)', async () => {
    const rows = await selectRowsMissingVectors(db.sql, SCHEMA, VEC, 25);
    expect(
      rows.map((r) => r.id),
      'A local (source_hive IS NULL) row with no vector must be swept. Re-adding a ' +
        'federation filter here strands every local row after any same-mode vector ' +
        'wipe — a width migration or a mode switch — with no error and no log line.',
    ).toContain(LOCAL_ROW);
  });

  /**
   * The predicate must key on the ACTIVE mode's table, so a corpus that is fully
   * embedded in one mode still reads as entirely unvectored in another. This is
   * the state migration 727 produced (memory_vec_local populated, gemma/openai
   * emptied) and the reason the sweep has to be able to rebuild a whole mode.
   */
  it('a row embedded in ANOTHER mode is still selected for the active mode', async () => {
    const OTHER = 'memory_vec_other';
    await db.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.${OTHER} (
        memory_id UUID PRIMARY KEY REFERENCES ${SCHEMA}.memory_canonical(id) ON DELETE CASCADE,
        vector    TEXT
      );
      INSERT INTO ${SCHEMA}.${OTHER} (memory_id, vector) VALUES ('${LOCAL_ROW}', '[0.9]');
    `);
    // Asking about the ACTIVE table: the other mode's vector is irrelevant.
    const rows = await selectRowsMissingVectors(db.sql, SCHEMA, VEC, 25);
    expect(rows.map((r) => r.id)).toContain(LOCAL_ROW);
    await db.sql.unsafe(`DROP TABLE ${SCHEMA}.${OTHER}`);
  });

  it('a row that already has a vector is not re-embedded', async () => {
    const rows = await selectRowsMissingVectors(db.sql, SCHEMA, VEC, 25);
    expect(rows.map((r) => r.id)).not.toContain(REMOTE_EMBEDDED);
  });

  /**
   * EI-19404620261958999 — the guard that makes the tempting migration "fix"
   * fail LOUDLY instead of silently destroying semantic recall.
   *
   * Migration 727 widens these vector columns with `ALTER ... TYPE vector(768)
   * USING NULL`. `memory_vec_gemma.vector` and `memory_vec_openai.vector` are
   * NOT NULL, so that aborted and left 727 permanently pending — which froze the
   * fleet's gate, because release:checkpoint-run refuses on a failed migration.
   *
   * The obvious recovery is to drop the NOT NULL so `USING NULL` succeeds. It
   * applies cleanly and looks successful. It is catastrophic, and THIS test is
   * why: the predicate keys on ROW ABSENCE (`NOT EXISTS ... WHERE v.memory_id =
   * c.id`), never on the vector VALUE. A row that survives the widening holding
   * a NULL vector therefore satisfies EXISTS, is never selected, and never gets
   * a vector again — semantic recall for that mode degrades to nothing with no
   * error and no log line. `reembed.ts` uses the same NOT EXISTS shape, so there
   * is no second path that would rescue it.
   *
   * The correct treatment (landed in 727) is to DELETE the rows: the text lives
   * in memory_canonical and vec-write.ts's `ON CONFLICT (memory_id)` upsert
   * re-INSERTs them, so absence is recoverable where a NULL is not.
   *
   * If this test ever fails, someone has made the predicate value-aware — which
   * is a legitimate design change, but it MUST land together with the migration
   * change, or the two disagree about what "missing a vector" means.
   */
  it('a NULL-vector row is INVISIBLE to the sweep — so nulling a column strands it forever', async () => {
    // Exactly the state a `DROP NOT NULL` + `USING NULL` widening would leave:
    // the row survives, its vector does not.
    await db.sql.unsafe(
      `INSERT INTO ${SCHEMA}.${VEC} (memory_id, vector) VALUES ('${REMOTE_A}', NULL)`,
    );

    const rows = await selectRowsMissingVectors(db.sql, SCHEMA, VEC, 25);

    expect(
      rows.map((r) => r.id),
      'A row holding a NULL vector is NOT re-embedded: the predicate tests row ' +
        'EXISTENCE, not the vector value. This is why migration 727 must DELETE ' +
        'rows rather than drop the NOT NULL — nulling them is a permanent, silent ' +
        'loss of semantic recall, not a temporary degradation.',
    ).not.toContain(REMOTE_A);

    // ...and the contrast that proves the row was otherwise eligible: with the
    // row absent instead of NULL, the very same memory IS selected. Without this
    // leg the assertion above would also pass if REMOTE_A were excluded for some
    // unrelated reason (archived, entity, empty text).
    await db.sql.unsafe(`DELETE FROM ${SCHEMA}.${VEC} WHERE memory_id = '${REMOTE_A}'`);
    const afterDelete = await selectRowsMissingVectors(db.sql, SCHEMA, VEC, 25);
    expect(
      afterDelete.map((r) => r.id),
      'Sanity leg: the same memory IS picked up once its vec row is ABSENT, ' +
        'confirming the exclusion above is caused by the surviving NULL row.',
    ).toContain(REMOTE_A);
  });

  it('honors the batch limit', async () => {
    const rows = await selectRowsMissingVectors(db.sql, SCHEMA, VEC, 1);
    expect(rows.map((r) => r.id)).toEqual([LOCAL_ROW]);
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
      resolveVecTable: async () => ({ mode: 'local' as const, profileId: 'local-bge-small-en-v1.5@v1' as const, schema: SCHEMA, table: VEC }),
      embed,
    };

    // `mode`/`table` are part of the result contract since EI-19409840792445272
    // (the caller must be able to log WHICH table a zero-yield sweep looked at);
    // both are fixed here by this test's own resolveVecTable, so asserting them
    // is deterministic rather than brittle.
    const first = await backfillCanonicalMemoryVectors(deps);
    expect(first).toEqual({ scanned: 3, embedded: 3, failed: 0, mode: 'local', table: VEC });
    expect(embedded).toEqual(ALL_ELIGIBLE);

    // The whole point: those memories are now visible to the vector-join recall
    // path, and the next tick finds nothing left to do.
    // toMatchObject, not toEqual: the zero-row path also returns `zeroYield`
    // (the idle-vs-broken probe), whose shape is that probe's business, not this
    // test's — pinning it here would red this file every time the probe changes.
    const second = await backfillCanonicalMemoryVectors(deps);
    expect(second).toMatchObject({ scanned: 0, embedded: 0, failed: 0, mode: 'local', table: VEC });
  });

  it('a failed embed leaves the row queued for the next tick (self-healing)', async () => {
    const deps = {
      sql: db.sql,
      resolveVecTable: async () => ({ mode: 'local' as const, profileId: 'local-bge-small-en-v1.5@v1' as const, schema: SCHEMA, table: VEC }),
      embed: async () => false, // embedder down / quota-cooled
    };
    const r = await backfillCanonicalMemoryVectors(deps);
    expect(r).toEqual({ scanned: 3, embedded: 0, failed: 3, mode: 'local', table: VEC });
    // Still queued — an outage delays recall, it never permanently loses it.
    const stillQueued = await selectRowsMissingVectors(db.sql, SCHEMA, VEC, 25);
    expect(stillQueued.map((r2) => r2.id)).toEqual(ALL_ELIGIBLE);
  });
});
