/** Real-Postgres proof for the coverage-check + selector transaction. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FreshPgDb } from '../../test/_pg-helpers';

const h = vi.hoisted(() => ({ sql: null as FreshPgDb['sql'] | null }));
const syncInvalidate = vi.hoisted(() => vi.fn(async () => {}));
const invalidateMemoryClient = vi.hoisted(() => vi.fn());

vi.mock('@papercusp/db-org', async (orig) => ({
  ...(await orig<typeof import('@papercusp/db-org')>()),
  getOrgPg: () => ({ sql: h.sql }),
}));
vi.mock('../workspace-registry', async (orig) => ({
  ...(await orig<typeof import('../workspace-registry')>()),
  activeWorkspaceId: () => 'ws-profile-cutover',
}));
vi.mock('../sync-sse', () => ({ notifySyncInvalidate: syncInvalidate }));
vi.mock('@papercusp/memory', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@papercusp/memory')>()),
  invalidateMemoryClient,
}));

const { createFreshPgDb } = await import('../../test/_pg-helpers');
const { cutoverMemoryProfile, MemoryProfileCutoverError } = await import('./profile-cutover');

const SOURCE_PROFILE = 'openai-text-embedding-3-small-768@v1';
const TARGET_PROFILE = 'local-bge-small-en-v1.5@v1';
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('memory profile cutover (real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('memory-profile-cutover');
    h.sql = db.sql;
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.memory_canonical (
        id uuid PRIMARY KEY,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb
      );
      CREATE TABLE harness_shared.memory_vec_openai (
        memory_id uuid PRIMARY KEY REFERENCES harness_shared.memory_canonical(id),
        vector text NOT NULL
      );
      CREATE TABLE harness_shared.memory_vec_local (
        memory_id uuid PRIMARY KEY REFERENCES harness_shared.memory_canonical(id),
        vector text NOT NULL
      );
      CREATE TABLE harness_shared.operator_voice_prefs (
        workspace_id text PRIMARY KEY,
        payload jsonb NOT NULL,
        updated_at bigint NOT NULL DEFAULT 0
      );
      CREATE TABLE harness_shared.user_preferences (
        user_id text NOT NULL,
        workspace_id text NOT NULL,
        payload jsonb NOT NULL DEFAULT '{}'::jsonb,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (user_id, workspace_id)
      );
    `);
  });

  afterAll(async () => {
    if (db) await db.cleanup();
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.sql.unsafe(`
      TRUNCATE harness_shared.memory_canonical CASCADE;
      TRUNCATE harness_shared.operator_voice_prefs;
      TRUNCATE harness_shared.user_preferences;
      INSERT INTO harness_shared.memory_canonical (id, payload) VALUES
        ('${A}', '{"data":"alpha"}'::jsonb),
        ('${B}', '{"data":"beta"}'::jsonb);
      INSERT INTO harness_shared.memory_vec_openai (memory_id, vector) VALUES
        ('${A}', '[0.1]'), ('${B}', '[0.2]');
      INSERT INTO harness_shared.operator_voice_prefs (workspace_id, payload)
      VALUES (
        'ws-profile-cutover',
        '{"memoryEmbedderMode":"openai"}'::jsonb
      );
    `);
  });

  it('refuses an incomplete target without changing the serving selector', async () => {
    await db.sql.unsafe(
      `INSERT INTO harness_shared.memory_vec_local (memory_id, vector) VALUES ($1, '[0.3]')`,
      [A],
    );

    const error = await cutoverMemoryProfile({
      userId: 'user-a',
      fromMode: 'openai',
      toMode: 'local',
      fromProfileId: SOURCE_PROFILE,
      toProfileId: TARGET_PROFILE,
    }).catch((caught) => caught);

    expect(error).toBeInstanceOf(MemoryProfileCutoverError);
    expect(error).toMatchObject({
      code: 'target_coverage_incomplete',
      coverage: { eligible: 2, source: 2, target: 1, missing: 1 },
    });
    const [pref] = await db.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM harness_shared.operator_voice_prefs
       WHERE workspace_id = 'ws-profile-cutover'
    `;
    expect(pref?.payload).toMatchObject({
      memoryEmbedderMode: 'openai',
    });
    expect(invalidateMemoryClient).not.toHaveBeenCalled();
  });

  it('creates a user selector and retains the prior vector population for rollback', async () => {
    await db.sql.unsafe(`
      INSERT INTO harness_shared.memory_vec_local (memory_id, vector) VALUES
        ('${A}', '[0.3]'), ('${B}', '[0.4]')
    `);

    const result = await cutoverMemoryProfile({
      userId: 'user-a',
      fromMode: 'openai',
      toMode: 'local',
      fromProfileId: SOURCE_PROFILE,
      toProfileId: TARGET_PROFILE,
    });

    expect(result).toEqual({
      coverage: { eligible: 2, source: 2, target: 2, missing: 0 },
      servingMode: 'local',
      servingProfileId: TARGET_PROFILE,
      previousMode: 'openai',
      previousProfileId: SOURCE_PROFILE,
      selectionLayer: 'user',
    });
    const [pref] = await db.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM harness_shared.user_preferences
       WHERE user_id = 'user-a' AND workspace_id = 'ws-profile-cutover'
    `;
    expect(pref?.payload).toMatchObject({
      memoryEmbedderMode: 'local',
      previousMemoryEmbedderMode: 'openai',
      previousMemoryEmbedderProfileId: SOURCE_PROFILE,
    });
    const [counts] = await db.sql<{ source: number; target: number }[]>`
      SELECT
        (SELECT count(*)::int FROM harness_shared.memory_vec_openai) AS source,
        (SELECT count(*)::int FROM harness_shared.memory_vec_local) AS target
    `;
    expect(counts).toEqual({ source: 2, target: 2 });
    expect(invalidateMemoryClient).toHaveBeenCalledTimes(1);
    expect(syncInvalidate).toHaveBeenCalledWith('voicePrefs.effective', {});
  });

  it('updates an existing user selector without changing the workspace default', async () => {
    await db.sql.unsafe(`
      UPDATE harness_shared.operator_voice_prefs
         SET payload = '{"memoryEmbedderMode":"harrier"}'::jsonb
       WHERE workspace_id = 'ws-profile-cutover';
      INSERT INTO harness_shared.user_preferences (user_id, workspace_id, payload)
      VALUES ('user-a', 'ws-profile-cutover', '{"memoryEmbedderMode":"openai","keep":"me"}'::jsonb);
      INSERT INTO harness_shared.memory_vec_local (memory_id, vector) VALUES
        ('${A}', '[0.3]'), ('${B}', '[0.4]');
    `);

    const result = await cutoverMemoryProfile({
      userId: 'user-a',
      fromMode: 'openai',
      toMode: 'local',
      fromProfileId: SOURCE_PROFILE,
      toProfileId: TARGET_PROFILE,
    });

    expect(result.selectionLayer).toBe('user');
    const [userPref] = await db.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM harness_shared.user_preferences
       WHERE user_id = 'user-a' AND workspace_id = 'ws-profile-cutover'
    `;
    expect(userPref?.payload).toMatchObject({
      keep: 'me',
      memoryEmbedderMode: 'local',
      previousMemoryEmbedderMode: 'openai',
      previousMemoryEmbedderProfileId: SOURCE_PROFILE,
    });
    const [workspacePref] = await db.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM harness_shared.operator_voice_prefs
       WHERE workspace_id = 'ws-profile-cutover'
    `;
    expect(workspacePref?.payload.memoryEmbedderMode).toBe('harrier');
  });
});
