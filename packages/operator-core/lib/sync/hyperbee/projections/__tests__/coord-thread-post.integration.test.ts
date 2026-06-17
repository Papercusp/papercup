/**
 * coord-thread-post.integration.test.ts — D2 PG-level coverage for the
 * coord_thread_posts projection on REAL Postgres.
 *
 * The unit suite (coord-thread-post.test.ts) pins validation / key / provenance
 * stamping with a mock SQL spy. This integration suite proves the SQL the spy
 * can't see:
 *   - a federated post WRITES and LANDS (the partial-unique upsert on
 *     (workspace_id, post_msg_id) where harness_slug + post_msg_id are non-null);
 *   - the ts-guarded DELETE is PG-level LWW — a STALE del (older than the row's
 *     fed_ts) matches nothing; an equal/newer del removes the post.
 *
 * Docker-gated (`*.integration.test.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { buildHarnessProjectionApply } from '../register-all';
import type { OpEnvelope } from '../../op-envelope-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../../..');
const SQL_DIR = resolve(REPO_ROOT, 'libs/papercusp/libs/db/sql');
const MIGRATION_RUNNER = resolve(
  REPO_ROOT,
  'libs/papercusp/packages/embedded-postgres-server/src/migration-runner.js',
);

const BOOT_PREREQS_DDL = `
  DO $pg$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_app')   THEN CREATE ROLE harness_app   LOGIN PASSWORD 'harness_app_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_admin') THEN CREATE ROLE harness_admin LOGIN SUPERUSER PASSWORD 'harness_admin_pwd'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='harness_zero')  THEN CREATE ROLE harness_zero  LOGIN REPLICATION SUPERUSER PASSWORD 'harness_zero_pwd'; END IF;
  END $pg$;
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  CREATE EXTENSION IF NOT EXISTS vector;
`;

const WS = 'ws-ctp';
const HARNESS = 'ctp';
const AUTHOR = 'c'.repeat(64);

let db: MigratedTestDb;
let sql: postgres.Sql;
let apply: (op: OpEnvelope) => Promise<boolean>;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'ctp',
    provision: async (url) => {
      const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
        applyPendingMigrations: (opts: {
          client: postgres.Sql;
          sqlDir: string;
        }) => Promise<{ appliedCount: number; totalKnown: number }>;
      };
      const s = postgres(url, { max: 1, onnotice: () => {} });
      try {
        await s.unsafe(BOOT_PREREQS_DDL);
        await applyPendingMigrations({ client: s, sqlDir: SQL_DIR });
      } finally {
        await s.end({ timeout: 5 });
      }
    },
  });
  sql = postgres(db.url, { max: 4, onnotice: () => {}, prepare: false });
  apply = buildHarnessProjectionApply({ workspaceId: WS, harnessSlug: HARNESS, sql });
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

function postPut(postMsgId: string, threadId: string, body: string, ts: number): OpEnvelope {
  return {
    type: 'put',
    table: 'coord-thread-posts',
    hbKey: postMsgId,
    value: {
      harness_slug: HARNESS,
      post_msg_id: postMsgId,
      thread_id: threadId,
      author_id: 'su-1',
      body,
      created_at: ts,
    },
    ts,
    schema_version: 1,
    writerPubkey: AUTHOR,
  };
}

function postDel(postMsgId: string, ts: number): OpEnvelope {
  return { type: 'del', table: 'coord-thread-posts', hbKey: postMsgId, ts, schema_version: 1, writerPubkey: AUTHOR };
}

async function postRow(postMsgId: string): Promise<{ body: string; thread_id: string; fed_ts: string | null } | null> {
  const rows = await sql<{ body: string; thread_id: string; fed_ts: string | null }[]>`
    SELECT body, thread_id, fed_ts FROM harness_shared.coord_thread_posts
    WHERE workspace_id = ${WS} AND post_msg_id = ${postMsgId}`;
  return rows[0] ?? null;
}

describe('D2 — coord_thread_posts projection writes + deletes on real PG', () => {
  it('a federated post lands with its content + stamped fed_ts', async () => {
    expect(await apply(postPut('post-1', 'thr-1', 'hello world', 2000))).toBe(true);
    const r = await postRow('post-1');
    expect(r).not.toBeNull();
    expect(r!.body).toBe('hello world');
    expect(r!.thread_id).toBe('thr-1');
    expect(Number(r!.fed_ts)).toBe(2000);
  });

  it('a NEWER put updates the body (upsert on the partial-unique post_msg_id)', async () => {
    await apply(postPut('post-2', 'thr-1', 'v1', 1000));
    expect((await postRow('post-2'))!.body).toBe('v1');
    await apply(postPut('post-2', 'thr-1', 'v2', 2000));
    expect((await postRow('post-2'))!.body).toBe('v2');
  });

  it('an OLDER put does NOT clobber a newer post (PG-level put-side LWW)', async () => {
    await apply(postPut('post-3', 'thr-1', 'newer', 3000));
    await apply(postPut('post-3', 'thr-1', 'older', 1000));
    expect((await postRow('post-3'))!.body).toBe('newer');
  });

  it('a STALE delete is BLOCKED by the ts-guard; an equal/newer delete removes the post', async () => {
    expect(await apply(postPut('post-4', 'thr-1', 'live', 2000))).toBe(true);
    expect(await postRow('post-4')).not.toBeNull();

    // Stale del (delTs=1000 < fed_ts=2000) → DELETE matches nothing.
    await apply(postDel('post-4', 1000));
    expect(await postRow('post-4')).not.toBeNull();

    // Equal/newer del (delTs >= fed_ts) → removed.
    await apply(postDel('post-4', 2000));
    expect(await postRow('post-4')).toBeNull();
  });
});
