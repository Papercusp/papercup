/** Real-Postgres guards for temporal-lite's immutable-winner contract. */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CanonicalVectorStore } from '../../../../libs/generic/memory/src/canonical-store';
import { EMBEDDER_DIM_SPECS, type EmbedderProfileSpec } from '../../../../libs/generic/memory/src/embedder-dims';
import { MEMORY_VECTOR_STORAGE_PROFILES, type MemoryVectorStorageProfile } from '../../../../libs/generic/memory/src/vec-write';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';

const SCHEMA = 'harness_shared';
const OLD_ID = '11111111-1111-4111-8111-111111111111';
const WINNER_A = '22222222-2222-4222-8222-222222222222';
const WINNER_B = '33333333-3333-4333-8333-333333333333';
const TEST_PROFILE: EmbedderProfileSpec = {
  ...EMBEDDER_DIM_SPECS.local,
  profileId: 'temporal-convergence-test@v1',
  model: 'temporal-convergence-test',
  modelRevision: 'test-revision',
  nativeDims: 3,
  mrl: 'none',
  trainedDims: [3],
  targetDims: 3,
};
const TEST_STORAGE: MemoryVectorStorageProfile = {
  ...MEMORY_VECTOR_STORAGE_PROFILES.local,
  acceptedProfileIds: [TEST_PROFILE.profileId],
  dimensions: 3,
};

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
      embeddingProfile: TEST_PROFILE, storageProfile: TEST_STORAGE,
    });
    (store as unknown as { pool: unknown }).pool = {
      query: async (text: string, params: unknown[] = []) => {
        const rows = await db.sql.unsafe(text, params as never[]);
        return { rows: [...rows], rowCount: rows.count };
      },
      on: () => {},
      end: async () => {},
    };
  });

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    await db.sql.unsafe(`TRUNCATE ${SCHEMA}.memory_canonical`);
    await db.sql.unsafe(
      `INSERT INTO ${SCHEMA}.memory_canonical (id, payload) VALUES ($1, $2::jsonb)`,
      [OLD_ID, { data: 'old fact', user_id: 'scope-a' }],
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
      [OLD_ID, { data: 'old fact', user_id: 'scope-a', entityType: 'person' }],
    );
    const [{ payload }] = await db.sql.unsafe(
      `SELECT payload FROM ${SCHEMA}.memory_canonical WHERE id = $1`,
      [OLD_ID],
    );
    expect(payload).toMatchObject({ entityType: 'person' });
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

  it('list enforces UTC half-open boundaries and as_of wins over include_superseded', async () => {
    await db.sql.unsafe(
      `UPDATE ${SCHEMA}.memory_canonical
          SET valid_at = '2026-06-01T00:00:00Z', invalid_at = '2026-07-01T00:00:00Z', superseded_by = $2
        WHERE id = $1`,
      [OLD_ID, WINNER_A],
    );
    await db.sql.unsafe(
      `INSERT INTO ${SCHEMA}.memory_canonical (id, payload, valid_at)
       VALUES ($1, $2::jsonb, '2026-07-01T00:00:00Z')`,
      [WINNER_A, { data: 'new fact', user_id: 'scope-a' }],
    );

    const [before, beforeCount] = await store.list({ user_id: 'scope-a', as_of: '2026-06-30T23:59:59.999Z' }, 10);
    expect(before.map((row) => row.id)).toEqual([OLD_ID]);
    expect(beforeCount).toBe(1);

    const [boundary, boundaryCount] = await store.list({
      user_id: 'scope-a',
      as_of: '2026-07-01T00:00:00Z',
      include_superseded: true,
    }, 10);
    expect(boundary.map((row) => row.id)).toEqual([WINNER_A]);
    expect(boundaryCount).toBe(1);

    const [lifecycle, lifecycleCount] = await store.list({ user_id: 'scope-a', include_superseded: true }, 10);
    expect(lifecycle.map((row) => row.id).sort()).toEqual([OLD_ID, WINNER_A].sort());
    expect(lifecycleCount).toBe(2);
  });
});
