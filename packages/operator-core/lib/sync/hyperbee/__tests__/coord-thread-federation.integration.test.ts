/**
 * Integration test for coord_threads + coord_thread_posts federation (Track A,
 * distributed-coordination-shared-harness-2026-06-04). Real Postgres + the REAL
 * PgThreadStore (so the writer changes — post_msg_id minting + harness_slug
 * inheritance via subquery — are exercised, not mocked).
 *
 * Proves: a harness-scoped thread + its posts capture to the outbox; an
 * operator-scope (no harness) thread/post does NOT; the op-key reshape builds the
 * thread/post ops; and a two-peer A→B convergence through the real
 * reshape→decode→project chain lands both the thread header and the posts on B.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ensureCoordCapabilityTables, PgThreadStore } from '@papercusp/coordination/capabilities';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { outboxRowToLocalWriteOp, type OutboxRow } from '../feature-issue-op-keys';
import { buildCoordThreadProjection, type CoordThreadRow } from '../projections/coord-thread';
import { buildCoordThreadPostProjection, type CoordThreadPostRow } from '../projections/coord-thread-post';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql');
const OUTBOX_MIGRATION = resolve(SQL_DIR, 'archive/102-substrate-outbox.sql');
const FED_MIGRATION = resolve(SQL_DIR, '149-coord-threads-federation.sql');

function stripMeta(sql: string): string {
  return sql.split('\n').filter((l) => {
    const t = l.trim();
    return !t.startsWith('\\') && !/^(begin|commit);$/i.test(t);
  }).join('\n');
}

const WS = 'ws_thr';
const HARNESS = 'fed';

async function stubRoles(sql: FreshPgDb['sql']) {
  await sql.unsafe(`
    DO $r$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
    END $r$;`);
}

interface OutboxDbRow { table_name: string; op: string; key: string; row: Record<string, unknown> | null; ts: number; harness_slug: string }

describe('coord_threads + coord_thread_posts federation (real PG + real PgThreadStore)', () => {
  let db: FreshPgDb;
  let threads: PgThreadStore;

  beforeAll(async () => {
    db = await createFreshPgDb('coord_thr_fed');
    await stubRoles(db.sql);
    await ensureCoordCapabilityTables(db.sql);
    // Consolidated stubs for the 102 triggers.
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.harness_features_consolidated (
        workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL, feature_id TEXT NOT NULL,
        author_pubkey TEXT, origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, feature_id));
      CREATE TABLE harness_shared.harness_issues_consolidated (
        workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL, issue_id TEXT NOT NULL,
        author_pubkey TEXT, origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, issue_id));`);
    await db.sql.unsafe(readFileSync(OUTBOX_MIGRATION, 'utf8'));
    await db.sql.unsafe(stripMeta(readFileSync(FED_MIGRATION, 'utf8')));
    // EI-79 step 2 (mig 181): the PG-level LWW guard column the writers stamp.
    await db.sql.unsafe(`ALTER TABLE harness_shared.coord_threads ADD COLUMN IF NOT EXISTS fed_ts BIGINT`);
    await db.sql.unsafe(`ALTER TABLE harness_shared.coord_threads ADD COLUMN IF NOT EXISTS fed_hlc TEXT`);
    await db.sql.unsafe(`ALTER TABLE harness_shared.coord_thread_posts ADD COLUMN IF NOT EXISTS fed_ts BIGINT`);
    await db.sql.unsafe(`ALTER TABLE harness_shared.coord_thread_posts ADD COLUMN IF NOT EXISTS fed_hlc TEXT`);
    threads = new PgThreadStore({ getSql: () => db.sql, ensureSchema: async () => {}, workspaceId: WS });
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  async function outbox(table?: string): Promise<OutboxDbRow[]> {
    const rows = await db.sql<OutboxDbRow[]>`
      SELECT table_name, op, key, row, ts, harness_slug FROM harness_shared.substrate_outbox ORDER BY id`;
    return table ? rows.filter((r) => r.table_name === table) : rows;
  }
  async function clearOutbox() { await db.sql`DELETE FROM harness_shared.substrate_outbox`; }

  it('a harness-scoped thread + post capture to the outbox (post_msg_id minted, harness inherited)', async () => {
    await clearOutbox();
    const thread = await threads.getOrCreateThread(
      { kind: 'conversation', ref: 'conv-1' },
      { thread_id: 'thr-conv-1', title: 'Q1', created_by: 'su-A', created_ts: new Date(1_700_000_000_000).toISOString(), harness_slug: HARNESS },
    );
    expect(thread.thread_id).toBe('thr-conv-1');
    const post = await threads.addPost({ thread_id: 'thr-conv-1', author_id: 'su-A', body: 'first reply', created_ts: new Date(1_700_000_050_000).toISOString() });
    expect(post.thread_id).toBe('thr-conv-1');

    const threadRows = await outbox('coord_threads');
    const postRows = await outbox('coord_thread_posts');
    // 2 thread captures: the create (INSERT) + the post_count bump from addPost
    // (UPDATE) — the remote needs the refreshed post_count/last_post_at.
    expect(threadRows).toHaveLength(2);
    expect(threadRows.every((r) => r.key === 'thr-conv-1' && r.harness_slug === HARNESS)).toBe(true);
    expect(postRows).toHaveLength(1);
    expect(postRows[0].harness_slug).toBe(HARNESS); // inherited from the thread
    // the post's federation key is the minted post_msg_id (not the bigserial id)
    expect(postRows[0].key).toBe(String(postRows[0].row?.post_msg_id));
    expect(postRows[0].key.length).toBeGreaterThan(0);
  });

  it('an operator-scope thread + post (no harness_slug) capture NOTHING', async () => {
    await clearOutbox();
    await threads.getOrCreateThread(
      { kind: 'conversation', ref: 'conv-op' },
      { thread_id: 'thr-conv-op', created_by: 'su-A', created_ts: new Date().toISOString() }, // no harness_slug
    );
    await threads.addPost({ thread_id: 'thr-conv-op', author_id: 'su-A', body: 'local reply', created_ts: new Date().toISOString() });
    expect(await outbox()).toHaveLength(0);
  });

  it('two-peer convergence: a thread + its posts written on A land on B via the real reshape→decode→project chain', async () => {
    const dbB = await createFreshPgDb('coord_thr_fed_b');
    try {
      await stubRoles(dbB.sql);
      await ensureCoordCapabilityTables(dbB.sql);
      // EI-79 step 2 (mig 181): the PG-level LWW guard column the writers stamp.
      await dbB.sql.unsafe(`ALTER TABLE harness_shared.coord_threads ADD COLUMN IF NOT EXISTS fed_ts BIGINT`);
      await dbB.sql.unsafe(`ALTER TABLE harness_shared.coord_threads ADD COLUMN IF NOT EXISTS fed_hlc TEXT`);
      await dbB.sql.unsafe(`ALTER TABLE harness_shared.coord_thread_posts ADD COLUMN IF NOT EXISTS fed_ts BIGINT`);
      await dbB.sql.unsafe(`ALTER TABLE harness_shared.coord_thread_posts ADD COLUMN IF NOT EXISTS fed_hlc TEXT`);
      // B needs the post fed-unique index for the post projection's ON CONFLICT.
      await dbB.sql.unsafe(`CREATE UNIQUE INDEX coord_thread_posts_fed_uq ON harness_shared.coord_thread_posts (workspace_id, post_msg_id) WHERE harness_slug IS NOT NULL AND post_msg_id IS NOT NULL`);
      const projThread = buildCoordThreadProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: dbB.sql });
      const projPost = buildCoordThreadPostProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: dbB.sql });
      async function applyOnB(r: OutboxDbRow) {
        const op = outboxRowToLocalWriteOp({ table_name: r.table_name, op: r.op as 'put', key: r.key, ts: r.ts, row: r.row } as OutboxRow);
        const proj = r.table_name === 'coord_threads' ? projThread : projPost;
        if (op.type === 'del') return proj.deleteFromPg(op.hbKey);
        const decoded = proj.decodeValue((op as { value: unknown }).value);
        expect(decoded, `reshaped ${r.table_name} must satisfy the projection decoder`).not.toBeNull();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (proj.writeToPg as any)(decoded, { authorPubkey: 'peerA', origin: 'remote' });
      }

      await clearOutbox();
      await threads.getOrCreateThread(
        { kind: 'conversation', ref: 'conv-2' },
        { thread_id: 'thr-conv-2', title: 'cross-machine', created_by: 'su-A', created_ts: new Date(1_700_000_000_000).toISOString(), harness_slug: HARNESS },
      );
      await threads.addPost({ thread_id: 'thr-conv-2', author_id: 'su-A', body: 'reply one', created_ts: new Date(1_700_000_010_000).toISOString() });
      await threads.addPost({ thread_id: 'thr-conv-2', author_id: 'su-B', body: 'reply two', created_ts: new Date(1_700_000_020_000).toISOString() });
      for (const r of await outbox()) await applyOnB(r);

      const [threadOnB] = await dbB.sql<{ title: string | null; origin: string; post_count: number }[]>`
        SELECT title, origin, post_count FROM harness_shared.coord_threads WHERE thread_id='thr-conv-2'`;
      expect(threadOnB.title).toBe('cross-machine');
      expect(threadOnB.origin).toBe('remote');
      const postsOnB = await dbB.sql<{ body: string; origin: string }[]>`
        SELECT body, origin FROM harness_shared.coord_thread_posts WHERE thread_id='thr-conv-2' ORDER BY created_at`;
      expect(postsOnB.map((p) => p.body)).toEqual(['reply one', 'reply two']);
      expect(postsOnB.every((p) => p.origin === 'remote')).toBe(true);
    } finally {
      await dbB.cleanup();
    }
  });
});
