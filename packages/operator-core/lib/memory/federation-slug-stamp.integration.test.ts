/**
 * federation-slug-stamp REAL-PG tests (EI-10432) — mig 587's BEFORE trigger, the
 * thing that decides whether a shareable memory can federate at all.
 *
 * The operator-side guard (which memories get a routing key, and which are refused)
 * is unit-tested in agent-tools/memory/remember-shareable-fed-slug.test.ts. What
 * only a real Postgres can prove is the STAMP: that a row written the way mem0
 * writes it — `INSERT (id, payload, created_at, updated_at)`, federation columns
 * entirely absent — comes out carrying harness_slug, and that a row written the way
 * the p2p projection writes it — harness_slug supplied EXPLICITLY — comes out
 * untouched. A fake sql cannot fail either way, and "the trigger silently did
 * nothing" is precisely the bug being fixed.
 *
 * This runs the ACTUAL migration file, not a re-typed copy — a test that re-declares
 * the trigger proves only that the test's own SQL works.
 *
 * `createFreshPgDb` provisions only `harness_shared` + the fed-order-key fns, so
 * (mirroring federated-vec-backfill.integration.test.ts) this hand-rolls the columns
 * the trigger reads. memory_canonical carries only those columns here; `shareable`
 * is declared with its real mig-562 GENERATED expression because the capture
 * trigger's WHEN clause keys off it, so its derivation is part of what's under test.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const SCHEMA = 'harness_shared';

const MIGRATION = join(
  __dirname, '..', '..', '..', '..',
  'libs/papercusp/libs/db/sql/587-memory-federation-slug-stamp.sql',
);

const LOCAL_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const LOCAL_PRIVATE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const REMOTE_ROW = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LOCAL_EMPTY_SLUG = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LOCAL_FLIP = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

/** Exactly the INSERT mem0's CanonicalVectorStore.insert issues: payload + timestamps, no federation columns. */
async function mem0Insert(db: FreshPgDb, id: string, payload: Record<string, unknown>) {
  await db.sql.unsafe(
    `INSERT INTO ${SCHEMA}.memory_canonical (id, payload, created_at, updated_at)
     VALUES ($1, $2::text::jsonb, now(), now())`,
    [id, JSON.stringify(payload)],
  );
}

const slugOf = async (db: FreshPgDb, id: string): Promise<string | null> => {
  const rows = await db.sql.unsafe(
    `SELECT harness_slug FROM ${SCHEMA}.memory_canonical WHERE id = $1`, [id],
  );
  return (rows as unknown as Array<{ harness_slug: string | null }>)[0]?.harness_slug ?? null;
};

describe('memory federation slug stamp — mig 587 (real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('fed-slug-stamp');
    await db.sql.unsafe(`
      CREATE TABLE IF NOT EXISTS ${SCHEMA}.memory_canonical (
        id           UUID PRIMARY KEY,
        payload      JSONB       NOT NULL,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        harness_slug TEXT,
        origin       TEXT        NOT NULL DEFAULT 'local',
        source_hive  TEXT,
        shareable    BOOLEAN
          GENERATED ALWAYS AS (COALESCE((payload->>'shareable')::boolean, false)) STORED
      );
    `);
    // Run the real migration (minus psql meta-commands, which sql.unsafe can't parse).
    const sqlText = readFileSync(MIGRATION, 'utf8')
      .split('\n').filter((l) => !l.trimStart().startsWith('\\')).join('\n');
    await db.sql.unsafe(sqlText);
  });

  afterAll(async () => {
    await db.cleanup();
  });

  beforeEach(async () => {
    await db.sql.unsafe(`TRUNCATE ${SCHEMA}.memory_canonical CASCADE`);
  });

  it('stamps harness_slug from the payload on a mem0-shaped INSERT (the bug: it was NULL)', async () => {
    await mem0Insert(db, LOCAL_A, {
      data: 'a shared project convention', user_id: 'u1',
      shareable: true, fed_harness_slug: 'my-hive',
    });
    expect(await slugOf(db, LOCAL_A)).toBe('my-hive');
  });

  it('the stamped row is DRAINABLE — it matches the drain\'s equality predicate', async () => {
    // outbox-drain.ts selects `WHERE workspace_id = $ws AND harness_slug = $slug`.
    // Under the bug the slug was NULL, and `NULL = 'my-hive'` is never true, so the
    // op could never be picked up. This is that predicate, against the stamped row.
    await mem0Insert(db, LOCAL_A, { data: 'x', shareable: true, fed_harness_slug: 'my-hive' });
    const rows = await db.sql.unsafe(
      `SELECT id::text AS id FROM ${SCHEMA}.memory_canonical WHERE harness_slug = $1`, ['my-hive'],
    );
    expect((rows as unknown as Array<{ id: string }>).map((r) => r.id)).toEqual([LOCAL_A]);
  });

  it('leaves a PRIVATE memory unrouted — federation stays opt-in (D-006)', async () => {
    await mem0Insert(db, LOCAL_PRIVATE, { data: 'my dog is Rex', user_id: 'u1' });
    expect(await slugOf(db, LOCAL_PRIVATE)).toBeNull();
    const rows = await db.sql.unsafe(
      `SELECT shareable FROM ${SCHEMA}.memory_canonical WHERE id = $1`, [LOCAL_PRIVATE],
    );
    expect((rows as unknown as Array<{ shareable: boolean }>)[0]?.shareable).toBe(false);
  });

  it('NEVER overwrites a slug the caller supplied — the p2p projection stays authoritative', async () => {
    // The receive-side projection inserts harness_slug explicitly (its remote applies
    // are bound to the peer's home slug). Clobbering it from the payload would
    // mis-route another hive's memory. Payload deliberately carries a DIFFERENT slug.
    await db.sql.unsafe(
      `INSERT INTO ${SCHEMA}.memory_canonical
         (id, payload, created_at, updated_at, harness_slug, origin, source_hive)
       VALUES ($1, $2::text::jsonb, now(), now(), 'peer-home', 'remote', 'peer-key-1')`,
      [REMOTE_ROW, JSON.stringify({ data: 'peer memory', shareable: true, fed_harness_slug: 'attacker-hive' })],
    );
    expect(await slugOf(db, REMOTE_ROW)).toBe('peer-home');
  });

  it('an empty-string routing key stamps NULL, not \'\' — the receiver rejects an empty slug', async () => {
    // p2p-memories.ts validates `isString(r.harness_slug) && r.harness_slug.length > 0`;
    // an empty slug would be an undrainable op that ALSO fails wire validation.
    await mem0Insert(db, LOCAL_EMPTY_SLUG, { data: 'x', shareable: true, fed_harness_slug: '' });
    expect(await slugOf(db, LOCAL_EMPTY_SLUG)).toBeNull();
  });

  it('stamps on the FLIP path too — a private memory later made shareable', async () => {
    // Inserted private (no routing key), then flipped. Without the UPDATE trigger the
    // capture would fire on the flip under a NULL slug and strand exactly like an insert.
    await mem0Insert(db, LOCAL_FLIP, { data: 'later shared', user_id: 'u1' });
    expect(await slugOf(db, LOCAL_FLIP)).toBeNull();

    await db.sql.unsafe(
      `UPDATE ${SCHEMA}.memory_canonical SET payload = $2::text::jsonb, updated_at = now()
        WHERE id = $1`,
      [LOCAL_FLIP, JSON.stringify({ data: 'later shared', user_id: 'u1', shareable: true, fed_harness_slug: 'my-hive' })],
    );
    expect(await slugOf(db, LOCAL_FLIP)).toBe('my-hive');
  });
});
