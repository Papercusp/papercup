/** Real-Postgres guards for temporal-lite's immutable-winner contract. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CanonicalVectorStore } from '../../../../libs/generic/memory/src/canonical-store';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const SCHEMA = 'harness_shared';
const OLD_ID = '11111111-1111-4111-8111-111111111111';
const WINNER_A = '22222222-2222-4222-8222-222222222222';
const WINNER_B = '33333333-3333-4333-8333-333333333333';

describe('temporal supersession convergence (real PG)', () => {
  let db: FreshPgDb;
  let store: CanonicalVectorStore;

  beforeAll(async () => {
    db = await createFreshPgDb('memory-temporal-convergence');
    await db.sql.unsafe(`
      CREATE TABLE ${SCHEMA}.memory_canonical (
        id uuid PRIMARY KEY,
        payload jsonb NOT NULL,
        state text NOT NULL DEFAULT 'active',
        valid_at timestamptz,
        invalid_at timestamptz,
        superseded_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    store = new CanonicalVectorStore({
      host: 'unused', port: 5432, user: 'unused', password: 'unused', dbname: 'unused',
      schema: SCHEMA, collectionName: 'operator_memory_local',
      vecTable: 'memory_vec_local', embeddingModelDims: 3,
    });
    (store as unknown as { pool: unknown }).pool = {
      query: async (text: string, params: unknown[] = []) => {
        const rows = await db.sql.unsafe(text, params);
        return { rows: [...rows], rowCount: rows.count };
      },
      on: () => {},
      end: async () => {},
    };
  });

  afterAll(async () => {
    await db.cleanup();
  });

  beforeEach(async () => {
    await db.sql.unsafe(`TRUNCATE ${SCHEMA}.memory_canonical`);
    await db.sql.unsafe(
      `INSERT INTO ${SCHEMA}.memory_canonical (id, payload) VALUES ($1, $2::jsonb)`,
      [OLD_ID, JSON.stringify({ data: 'old fact', user_id: 'scope-a' })],
    );
  });

  it('two concurrent closers produce exactly one immutable winner', async () => {
    const outcomes = await Promise.all([
      store.invalidate(OLD_ID, { supersededBy: WINNER_A }),
      store.invalidate(OLD_ID, { supersededBy: WINNER_B }),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    const [{ invalid_at, superseded_by }] = await db.sql.unsafe(
      `SELECT invalid_at, superseded_by::text FROM ${SCHEMA}.memory_canonical WHERE id = $1`,
      [OLD_ID],
    );
    expect(invalid_at).not.toBeNull();
    expect([WINNER_A, WINNER_B]).toContain(superseded_by);
    expect(await store.invalidate(OLD_ID, { supersededBy: WINNER_A })).toBe(false);
  });

  it('entity rows are never closed and get exposes canonical validity metadata', async () => {
    await db.sql.unsafe(
      `UPDATE ${SCHEMA}.memory_canonical SET payload = $2::jsonb WHERE id = $1`,
      [OLD_ID, JSON.stringify({ data: 'old fact', user_id: 'scope-a', entityType: 'person' })],
    );
    const [{ is_entity }] = await db.sql.unsafe(
      `SELECT payload ? 'entityType' AS is_entity FROM ${SCHEMA}.memory_canonical WHERE id = $1`,
      [OLD_ID],
    );
    expect(is_entity).toBe(true);
    expect(await store.invalidate(OLD_ID, { supersededBy: WINNER_A })).toBe(false);

    await db.sql.unsafe(
      `UPDATE ${SCHEMA}.memory_canonical
          SET payload = payload - 'entityType', invalid_at = now(), superseded_by = $2
        WHERE id = $1`,
      [OLD_ID, WINNER_A],
    );
    const row = await store.get(OLD_ID);
    expect(row?.payload).toMatchObject({
      data: 'old fact',
      user_id: 'scope-a',
      validity: { status: 'superseded', superseded_by: WINNER_A },
    });
  });
});
