/** Real SQL and installed mem0 linker coverage for EI-28710549925535705.
 * Only embeddings and client construction are injected; SDK extraction, store
 * insert/update, receipt observation, row locking and rollback execute normally.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalVectorStore, configureMemory, EMBEDDER_DIM_SPECS,
  MEMORY_VECTOR_STORAGE_PROFILES, relinkEntities } from '@papercusp/memory';
import { createFreshPgDb, type FreshPgDb } from '../../test/_pg-helpers';
// eslint-disable-next-line import/no-relative-packages -- inject only client construction, retaining the installed SDK
import { getMemoryClient, type MemoryClient } from '../../../../libs/generic/memory/src/mem0-client';
import { mockResolvedTyped } from '../testing/typed-mock';

vi.mock('../../../../libs/generic/memory/src/mem0-client', async original => ({
  ...await original<typeof import('../../../../libs/generic/memory/src/mem0-client')>(),
  getMemoryClient: vi.fn(),
}));

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const M3 = '33333333-3333-4333-8333-333333333333';
const JUNK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const EXISTING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const profile = EMBEDDER_DIM_SPECS.harrier;
const vector = Array.from({ length: profile.targetDims }, (_, i) => i === 0 ? 1 : 0);
const junkVector = Array.from({ length: profile.targetDims }, (_, i) => i === 1 ? 1 : 0);

describe('entity relink (real PG, canonical store and installed mem0 SDK)', () => {
  let db: FreshPgDb;
  let store: CanonicalVectorStore;
  let sdk: MemoryClient & {
    embedder: { embed: (text: string) => Promise<number[]> };
    getEntityStore: () => Promise<CanonicalVectorStore>;
  };

  async function seed(id: string, payload: Record<string, unknown>) {
    await db.sql.unsafe('INSERT INTO harness_shared.memory_canonical (id,payload) VALUES ($1,$2::text::jsonb)',
      [id, JSON.stringify(payload)]);
  }
  async function payload(id: string) {
    const rows = await db.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM harness_shared.memory_canonical WHERE id = ${id}`;
    return rows[0]?.payload;
  }
  async function expectRetryable() {
    expect(await payload(JUNK)).toMatchObject({ linkedMemoryIds: [M1] });
    for (const table of ['memory_vec_harrier', 'memory_vec_gemma']) {
      const rows = await db.sql.unsafe(`SELECT memory_id FROM harness_shared.${table} WHERE memory_id = $1`, [JUNK]);
      expect(rows).toHaveLength(1);
    }
  }
  async function expectRelink(expected: Record<string, unknown>, opts: Parameters<typeof relinkEntities>[0] = {}) {
    // mem0 intentionally swallows write failures. Keep its diagnostic beside
    // the failed assertion instead of losing it in the runner's console tail.
    const debug = vi.spyOn(console, 'debug');
    try {
      const result = await relinkEntities(opts);
      const rows = await db.sql`SELECT id,payload FROM harness_shared.memory_canonical ORDER BY id`;
      expect(result, JSON.stringify({ sdkDiagnostics: debug.mock.calls, persisted: rows })).toMatchObject(expected);
    } finally { debug.mockRestore(); }
  }

  beforeAll(async () => {
    db = await createFreshPgDb('entity-relink-sdk');
    await db.sql.unsafe(`
      CREATE EXTENSION IF NOT EXISTS vector;
      CREATE TABLE harness_shared.memory_canonical (
        id uuid PRIMARY KEY, payload jsonb NOT NULL,
        state text NOT NULL DEFAULT 'active',
        row_kind text GENERATED ALWAYS AS (CASE WHEN payload ? 'entityType' THEN 'entity' ELSE 'memory' END) STORED,
        valid_at timestamptz, invalid_at timestamptz, superseded_by uuid,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE harness_shared.memory_vec_harrier (
        memory_id uuid PRIMARY KEY REFERENCES harness_shared.memory_canonical(id),
        vector vector(${profile.targetDims}) NOT NULL, embedded_at timestamptz NOT NULL DEFAULT now(),
        row_kind text NOT NULL DEFAULT 'entity'
      );
      CREATE TABLE harness_shared.memory_vec_gemma (
        memory_id uuid PRIMARY KEY REFERENCES harness_shared.memory_canonical(id)
      );
    `);
    const url = new URL(db.url);
    store = new CanonicalVectorStore({ host: url.hostname, port: Number(url.port),
      user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), dbname: url.pathname.slice(1),
      schema: 'harness_shared', collectionName: 'relink_entities', vecTable: 'memory_vec_harrier',
      embeddingModelDims: profile.targetDims, embeddingProfile: profile, storageProfile: MEMORY_VECTOR_STORAGE_PROFILES.harrier });
    // Match mem0-client's ESM require bridge so extraction uses the real parser.
    vi.stubGlobal('require', createRequire(import.meta.url));
  }, 120_000);
  afterAll(async () => {
    await store?.dispose();
    await db?.cleanup();
    vi.unstubAllGlobals();
  });
  afterEach(() => vi.restoreAllMocks());

  beforeEach(async () => {
    await db.sql.unsafe(`
      DROP TRIGGER IF EXISTS refuse_relink_cleanup ON harness_shared.memory_vec_gemma;
      TRUNCATE harness_shared.memory_canonical CASCADE;
    `);
    configureMemory({ getAdminUrl: () => db.url, getCredentials: async () => ({}),
      resolveEmbedder: async () => ({ mode: 'disabled' }), buildEmbedderForMode: async () => async () => vector,
      schema: 'harness_shared' });
    const { Memory } = await import('mem0ai/oss');
    // Only the real entity linker may run. Public client calls must fail rather
    // than reaching unconfigured SDK dependencies or providers.
    const unexpectedClientCall = async (): Promise<never> => {
      throw new Error('Unexpected public memory client call during entity relink');
    };
    sdk = {
      add: vi.fn<MemoryClient['add']>(unexpectedClientCall),
      delete: vi.fn<MemoryClient['delete']>(unexpectedClientCall),
      get: vi.fn<MemoryClient['get']>(unexpectedClientCall),
      getAll: vi.fn<MemoryClient['getAll']>(unexpectedClientCall),
      search: vi.fn<MemoryClient['search']>(unexpectedClientCall),
      update: vi.fn<MemoryClient['update']>(unexpectedClientCall),
      embedder: { embed: async () => vector }, getEntityStore: async () => store,
    };
    Object.setPrototypeOf(sdk, Memory.prototype);
    mockResolvedTyped(vi.mocked(getMemoryClient), sdk);
    await seed(M1, { data: '"Harrier"', user_id: 'relink-test' });
    await seed(JUNK, { data: 'just before end of', user_id: 'relink-test', entityType: 'COMPOUND', linkedMemoryIds: [M1] });
    expect(await payload(JUNK)).toMatchObject({ entityType: 'COMPOUND', linkedMemoryIds: [M1] });
    await db.sql.unsafe('INSERT INTO harness_shared.memory_vec_harrier (memory_id,vector) VALUES ($1,$2::vector)',
      [JUNK, `[${junkVector.join(',')}]`]);
    await db.sql`INSERT INTO harness_shared.memory_vec_gemma (memory_id) VALUES (${JUNK})`;
    // A shared constant vector makes the SDK semantically reuse the junk row
    // (score 1), bypassing insert and invalidating insert-failure controls.
    const matches = await store.search(vector, 1, { user_id: 'relink-test' });
    expect(matches.every(row => (row.score ?? 0) < 0.95)).toBe(true);
  });

  it('persists real SDK insert receipts before deleting junk and both vectors', async () => {
    const embed = vi.spyOn(sdk.embedder, 'embed').mockImplementation(async () => {
      expect(await payload(JUNK)).toBeDefined();
      return vector;
    });
    await expectRelink({ memoriesRelinked: 1, junkDeleted: 1, errors: 0, junkRemaining: 0 });
    expect(embed).toHaveBeenCalled();
    expect(await payload(JUNK)).toBeUndefined();
    const clean = await store.list({ user_id: 'relink-test' }, 100);
    expect(clean[0].some(row => row.payload.linkedMemoryIds instanceof Array && row.payload.linkedMemoryIds.includes(M1))).toBe(true);
    for (const table of ['memory_vec_harrier', 'memory_vec_gemma']) {
      expect(await db.sql.unsafe(`SELECT memory_id FROM harness_shared.${table} WHERE memory_id = $1`, [JUNK])).toHaveLength(0);
    }
  });

  it('observes the SDK update path without losing existing entity fanout', async () => {
    await seed(EXISTING, { data: 'Harrier', user_id: 'relink-test', entityType: 'QUOTED', linkedMemoryIds: [M2] });
    const update = vi.spyOn(store, 'update');
    await expectRelink({ memoriesRelinked: 1, errors: 0, junkRemaining: 0 });
    expect(update).toHaveBeenCalled();
    expect(await payload(EXISTING)).toMatchObject({ linkedMemoryIds: [M1, M2] });
  });

  it.each(['embedding', 'insert', 'update'] as const)('retains retry markers when the real SDK swallows %s failure', async failure => {
    const reached = vi.fn();
    if (failure === 'embedding') vi.spyOn(sdk.embedder, 'embed').mockImplementation(async () => {
      reached(); throw new Error('injected embedding failure');
    });
    else if (failure === 'insert') vi.spyOn(store, 'insert').mockImplementation(async () => {
      reached(); throw new Error('injected insert failure');
    });
    else {
      await seed(EXISTING, { data: 'Harrier', user_id: 'relink-test', entityType: 'QUOTED', linkedMemoryIds: [M2] });
      vi.spyOn(store, 'update').mockImplementation(async () => {
        reached(); throw new Error('injected update failure');
      });
    }
    await expectRelink({ memoriesRelinked: 0, errors: 1, junkRemaining: 1 });
    expect(reached).toHaveBeenCalled();
    await expectRetryable();
  });

  it('rolls back both vector deletes when SQL cleanup fails between them', async () => {
    await db.sql.unsafe(`
      CREATE OR REPLACE FUNCTION harness_shared.refuse_relink_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected cleanup failure'; END $$;
      CREATE TRIGGER refuse_relink_cleanup BEFORE DELETE ON harness_shared.memory_vec_gemma
      FOR EACH ROW EXECUTE FUNCTION harness_shared.refuse_relink_cleanup();
    `);
    await expectRelink({ memoriesRelinked: 0, junkDeleted: 0, errors: 1, junkRemaining: 1 });
    const clean = await store.list({ user_id: 'relink-test' }, 100);
    expect(clean[0].some(row => row.id !== JUNK)).toBe(true);
    await expectRetryable();
  });

  it('keeps concurrently appended links while retiring only the successful memory', async () => {
    const insert = store.insert.bind(store);
    vi.spyOn(store, 'insert').mockImplementation(async (...args) => {
      await insert(...args);
      await db.sql`UPDATE harness_shared.memory_canonical
        SET payload = jsonb_set(payload, '{linkedMemoryIds}', ${db.sql.json([M1, M2, M3])}::jsonb) WHERE id = ${JUNK}`;
    });
    await expectRelink({ memoriesRelinked: 1, junkDeleted: 0, errors: 0 }, { maxMemories: 1 });
    expect(await payload(JUNK)).toMatchObject({ linkedMemoryIds: [M2, M3] });
  });

  it('refuses retirement if the memory changes while the SDK writes its replacement', async () => {
    const insert = store.insert.bind(store);
    vi.spyOn(store, 'insert').mockImplementation(async (...args) => {
      await insert(...args);
      await db.sql`UPDATE harness_shared.memory_canonical
        SET payload = jsonb_set(payload, '{data}', '"changed text"'::jsonb) WHERE id = ${M1}`;
    });
    await expectRelink({ memoriesRelinked: 0, errors: 1, junkRemaining: 1 });
    expect(await payload(M1)).toMatchObject({ data: 'changed text' });
    await expectRetryable();
  });

  it('retains the retry marker if SDK semantic dedup reuses a junk entity', async () => {
    await db.sql.unsafe('UPDATE harness_shared.memory_vec_harrier SET vector = $1::vector WHERE memory_id = $2',
      [`[${vector.join(',')}]`, JUNK]);
    const update = vi.spyOn(store, 'update');
    await expectRelink({ memoriesRelinked: 0, errors: 1, junkRemaining: 1 });
    expect(update).toHaveBeenCalledWith(JUNK, expect.any(Array), expect.any(Object));
    await expectRetryable();
  });

  it('dry-run reads real SQL without constructing the SDK or changing tenant data', async () => {
    const foreign = randomUUID();
    await seed(foreign, { data: 'just before end of', user_id: 'other', entityType: 'COMPOUND', linkedMemoryIds: [M2] });
    vi.mocked(getMemoryClient).mockClear();
    expect(await relinkEntities({ dryRun: true, userId: 'relink-test' })).toMatchObject({ affectedMemories: 1, dryRun: true });
    expect(getMemoryClient).not.toHaveBeenCalled();
    await expectRetryable();
    expect(await payload(foreign)).toBeDefined();
  });
});
