/**
 * delete-lww-guard.integration.test.ts — the DELETE-side partner of
 * `fed-ts-lww-guard.integration.test.ts` (which covers the PUT side) for the
 * composite-key projections, on REAL Postgres.
 *
 * Every mutating projection deleter is PG-level last-write-wins via its `fed_ts`
 * column guard `AND (<delTs> IS NULL OR fed_ts IS NULL OR fed_ts <= <delTs>)`:
 * a STALE del (one whose wire ts is OLDER than the standing row's fed_ts) must
 * match NOTHING, so a late / out-of-order / backfilled delete can never erase a
 * row a newer put recreated. The put-side guard's template tests `features-by-id`;
 * this file tests the symmetric DELETE floor on the COMPOSITE-key tables —
 * feature_queue, feature_working_set, shared_presence — whose `<userId>/<tail>`
 * key parsing + recompute side-effects the single-key template never exercises.
 *
 * D1 (delete stale-rejection): insert fed_ts=2000; del delTs=1000 → row REMAINS;
 *   del delTs=2000 → row gone.
 * D6 (working-set recompute idempotency): put→recompute→[users]; re-apply same
 *   put→recompute stays stable; a second user appends ordered; re-apply no dup.
 *
 * Docker-gated (`*.integration.test.ts`) — needs a real migrated PG; the guards
 * are pure SQL, invisible to the SQL-mocked unit tests.
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

const WS = 'ws-del-lww';
const HARNESS = 'del-lww';
const AUTHOR = 'd'.repeat(64);

let db: MigratedTestDb;
let sql: postgres.Sql;
let apply: (op: OpEnvelope) => Promise<boolean>;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'delww',
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

// ── op builders ────────────────────────────────────────────────────────────

function queuePut(userId: number, featureId: string, ts: number): OpEnvelope {
  return {
    type: 'put',
    table: 'queue',
    hbKey: `${userId}/${featureId}`,
    value: {
      harness_slug: HARNESS,
      github_user_id: userId,
      feature_id: featureId,
      queued_at: ts,
      removed_at: null,
      schema_version: 1,
    },
    ts,
    schema_version: 1,
    writerPubkey: AUTHOR,
  };
}

function workingPut(userId: number, featureId: string, ts: number): OpEnvelope {
  return {
    type: 'put',
    table: 'working-set',
    hbKey: `${userId}/${featureId}`,
    value: {
      harness_slug: HARNESS,
      github_user_id: userId,
      feature_id: featureId,
      started_at: ts,
      cleared_at: null,
      schema_version: 1,
    },
    ts,
    schema_version: 1,
    writerPubkey: AUTHOR,
  };
}

function presencePut(userId: number, machine: string, ts: number): OpEnvelope {
  return {
    type: 'put',
    table: 'presence',
    hbKey: `${userId}/${machine}`,
    value: {
      harness_slug: HARNESS,
      github_user_id: userId,
      machine_label: machine,
      device_pubkey: 'dev-' + userId,
      intent: 'working',
      current_view: null,
      last_seen_at: ts,
      schema_version: 1,
      hive_slug: null,
    },
    ts,
    schema_version: 1,
    writerPubkey: AUTHOR,
  };
}

function del(table: string, key: string, ts: number): OpEnvelope {
  return { type: 'del', table, hbKey: key, ts, schema_version: 1, writerPubkey: AUTHOR };
}

// ── row probes ─────────────────────────────────────────────────────────────

async function queueExists(userId: number, featureId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM harness_shared.feature_queue
    WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
      AND github_user_id = ${userId} AND feature_id = ${featureId}`;
  return rows.length > 0;
}

async function workingExists(userId: number, featureId: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM harness_shared.feature_working_set
    WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
      AND github_user_id = ${userId} AND feature_id = ${featureId}`;
  return rows.length > 0;
}

async function presenceExists(userId: number, machine: string): Promise<boolean> {
  const rows = await sql`
    SELECT 1 FROM harness_shared.shared_presence
    WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
      AND github_user_id = ${userId} AND machine_label = ${machine}`;
  return rows.length > 0;
}

/** The canonical working_users[] BIGINT[] the UI reads (D-016). Seeds a
 *  consolidated row first so the recompute UPDATE has a target. */
async function seedConsolidated(featureId: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.harness_features_consolidated
      (workspace_id, harness_slug, feature_id, title, status)
    VALUES (${WS}, ${HARNESS}, ${featureId}, ${'feat ' + featureId}, 'queued')
    ON CONFLICT (harness_slug, feature_id) DO NOTHING`;
}

async function workingUsersOf(featureId: string): Promise<number[]> {
  const rows = await sql<{ working_users: number[] | null }[]>`
    SELECT working_users FROM harness_shared.harness_features_consolidated
    WHERE harness_slug = ${HARNESS} AND feature_id = ${featureId}`;
  const arr = rows[0]?.working_users ?? [];
  // postgres-js returns BIGINT[] as strings; normalize to numbers.
  return arr.map((x) => Number(x));
}

// ── D1: DELETE-side stale-del rejection (composite-key projections) ──────────

describe('D1 — composite-key deleter is PG-level LWW (a stale del must not erase a newer row)', () => {
  it('feature_queue: del(delTs older than fed_ts) keeps the row; del(delTs >= fed_ts) removes it', async () => {
    const u = 1001;
    const f = 'F-q-1';
    expect(await apply(queuePut(u, f, 2000))).toBe(true);
    expect(await queueExists(u, f)).toBe(true);

    // Stale delete (older than the standing fed_ts=2000) → ts-guard matches nothing.
    await apply(del('queue', `${u}/${f}`, 1000));
    expect(await queueExists(u, f)).toBe(true);

    // An equal-or-newer delete DOES remove it (fed_ts <= delTs).
    await apply(del('queue', `${u}/${f}`, 2000));
    expect(await queueExists(u, f)).toBe(false);
  });

  it('feature_working_set: stale del keeps the row; newer del removes it', async () => {
    const u = 1002;
    const f = 'F-w-1';
    expect(await apply(workingPut(u, f, 2000))).toBe(true);
    expect(await workingExists(u, f)).toBe(true);

    await apply(del('working-set', `${u}/${f}`, 1000));
    expect(await workingExists(u, f)).toBe(true);

    await apply(del('working-set', `${u}/${f}`, 2000));
    expect(await workingExists(u, f)).toBe(false);
  });

  it('feature_working_set: a stale del also leaves working_users[] intact (recompute sees the surviving row)', async () => {
    const u = 1003;
    const f = 'F-w-recompute';
    await seedConsolidated(f);
    expect(await apply(workingPut(u, f, 2000))).toBe(true);
    expect(await workingUsersOf(f)).toEqual([u]);

    // Stale del — the guarded DELETE matches nothing, and the unconditional
    // recompute that follows re-derives the array from the SURVIVING pointer row.
    await apply(del('working-set', `${u}/${f}`, 1000));
    expect(await workingExists(u, f)).toBe(true);
    expect(await workingUsersOf(f)).toEqual([u]); // not wrongly cleared

    // A newer del removes the row → recompute empties the array.
    await apply(del('working-set', `${u}/${f}`, 2000));
    expect(await workingExists(u, f)).toBe(false);
    expect(await workingUsersOf(f)).toEqual([]);
  });

  it('shared_presence: stale del keeps the row; newer del removes it', async () => {
    const u = 1004;
    const m = 'laptop-1';
    expect(await apply(presencePut(u, m, 2000))).toBe(true);
    expect(await presenceExists(u, m)).toBe(true);

    await apply(del('presence', `${u}/${m}`, 1000));
    expect(await presenceExists(u, m)).toBe(true);

    await apply(del('presence', `${u}/${m}`, 2000));
    expect(await presenceExists(u, m)).toBe(false);
  });
});

// ── D6: working-set recompute idempotency ────────────────────────────────────

describe('D6 — feature_working_set recompute is idempotent + order-stable', () => {
  it('put(u100)→[100]; re-apply same put→still [100]; put(u200)→[100,200] ordered; re-apply→no dup', async () => {
    const f = 'F-idem';
    await seedConsolidated(f);

    // First worker (started_at=1000).
    expect(await apply(workingPut(100, f, 1000))).toBe(true);
    expect(await workingUsersOf(f)).toEqual([100]);

    // Re-applying the SAME put (a replay / duplicate merge pass) must not double
    // the user — recompute re-derives from the live pointer rows (array_agg of a
    // single surviving row), so it stays [100].
    await apply(workingPut(100, f, 1000));
    expect(await workingUsersOf(f)).toEqual([100]);

    // A second worker (started_at=2000) appends — ordered by started_at ASC so
    // working_users[0] (== current_worker per D-016) is the EARLIEST worker.
    expect(await apply(workingPut(200, f, 2000))).toBe(true);
    expect(await workingUsersOf(f)).toEqual([100, 200]);

    // Re-applying either put never duplicates.
    await apply(workingPut(200, f, 2000));
    await apply(workingPut(100, f, 1000));
    expect(await workingUsersOf(f)).toEqual([100, 200]);
  });

  it('ordering is by started_at, not insertion order (a later-arriving earlier worker sorts first)', async () => {
    const f = 'F-order';
    await seedConsolidated(f);
    // The user who STARTED later (3000) is applied FIRST…
    expect(await apply(workingPut(300, f, 3000))).toBe(true);
    expect(await workingUsersOf(f)).toEqual([300]);
    // …then the user who started EARLIER (2500) arrives — they must sort to [0].
    expect(await apply(workingPut(250, f, 2500))).toBe(true);
    expect(await workingUsersOf(f)).toEqual([250, 300]);
  });
});
