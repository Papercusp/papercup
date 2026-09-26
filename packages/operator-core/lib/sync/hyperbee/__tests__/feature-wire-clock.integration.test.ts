/**
 * feature-wire-clock.integration.test.ts — WI-10002882 (mig 1226).
 *
 * A FEATURE-family work_items row federates as `harness_features_consolidated`; a peer
 * applies a fixed set of its columns (harness-features.ts writeToPg). Until mig 1226,
 * `stamp_local_federated_write` decided "content changed" for a feature row over EVERY
 * column, so a write to a column no peer applies (embedding set, verifier/rank/schedule
 * bookkeeping, release history, ...) minted a fresh local HLC, flipped the row to
 * origin='local', and `capture_work_items_feature_upd_trg` shipped it.
 *
 * That is the op feedback loop of WI-10003230: after a concurrent same-key write both
 * live-fed frames held the SAME value while its fed_hlc kept advancing with alternating
 * node ids (~600 ops in 5 min), because each frame's local-only reaction to the other's
 * applied op re-stamped the row and shipped it back.
 *
 * Mig 1226 makes `harness_shared.feature_wire_row()` the one projection both triggers
 * judge feature content with. These cases pin the contract against the REAL migration
 * chain; before mig 1226 the first, third and fourth cases fail (measured with the same
 * statements against the live pre-fix functions, 2026-09-26: the local-only write moved
 * fed_hlc and added an outbox op).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../../../../..');
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

const WS = 'ws-feature-wire-clock';
const HARNESS = 'feature-wire-clock-cell';

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'featwireclock',
    provision: async (url) => {
      const { applyPendingMigrations } = (await import(pathToFileURL(MIGRATION_RUNNER).href)) as {
        applyPendingMigrations: (opts: { client: postgres.Sql; sqlDir: string }) => Promise<unknown>;
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
}, 240_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

let seq = 0;
function nextId(): string {
  seq += 1;
  return `F-FEATWIRE-${seq}`;
}

async function insertFeature(id: string): Promise<void> {
  await sql`
    INSERT INTO harness_shared.work_items
      (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin, payload)
    VALUES (${WS}, ${HARNESS}, ${id}, 'feature wire clock', 'body', 'todo', 'feature', 'local', ${sql.json({})})`;
}

type Clock = { fed_ts: string | null; fed_hlc: string | null; origin: string | null };

async function clockOf(id: string): Promise<Clock> {
  const [r] = await sql<Clock[]>`
    SELECT fed_ts::text AS fed_ts, fed_hlc, origin FROM harness_shared.work_items
     WHERE workspace_id = ${WS} AND feature_id = ${id}`;
  return r;
}

async function outboxCount(id: string): Promise<number> {
  const [r] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM harness_shared.substrate_outbox
     WHERE workspace_id = ${WS} AND table_name = 'harness_features_consolidated' AND key = ${id}`;
  return r.n;
}

/** Every column the 33-column local-only set exercises that a plain UPDATE can write. */
async function localOnlyWrite(id: string): Promise<void> {
  await sql`
    UPDATE harness_shared.work_items
       SET verifier_last_checked_at = now(),
           verifier_last_error = 'sha_not_found',
           requeue_count = COALESCE(requeue_count, 0) + 1,
           last_released_at = now(),
           last_released_by = 'reaper:dead',
           worked_by_history = COALESCE(worked_by_history, '[]'::jsonb) || '["agent-x"]'::jsonb,
           condition_key = ${`cond-${id}`}, -- unique: work_items_condition_key_uq
           embedding_mode = 'inline',
           embedding_profile = 'gemma',
           embedding_recipe = 2
     WHERE workspace_id = ${WS} AND feature_id = ${id}`;
}

describe('feature wire row drives the stamp clock (WI-10002882, mig 1226, real PG)', () => {
  it('a local-only column write keeps the clock and origin and emits NO wire op', async () => {
    const id = nextId();
    await insertFeature(id);
    const before = await clockOf(id);
    expect(before.fed_hlc).not.toBeNull();
    expect(await outboxCount(id)).toBe(1); // the INSERT

    await localOnlyWrite(id);

    expect(await clockOf(id)).toEqual(before);
    expect(await outboxCount(id)).toBe(1);
  });

  it('an applied column still stamps and emits exactly one op (no under-federation)', async () => {
    for (const set of [
      sql`title = 'renamed'`,
      sql`last_progress_at = now()`,
      sql`claims = COALESCE(claims, '') || 'agent-x'`,
      sql`status = 'done'`,
    ]) {
      const id = nextId();
      await insertFeature(id);
      const before = await clockOf(id);
      await sql`UPDATE harness_shared.work_items SET ${set} WHERE workspace_id = ${WS} AND feature_id = ${id}`;
      const after = await clockOf(id);
      expect(after.fed_hlc).not.toBe(before.fed_hlc);
      expect(after.origin).toBe('local');
      expect(await outboxCount(id)).toBe(2);
    }
  });

  it('a ts/updated_ts-only write keeps the clock and emits NO wire op', async () => {
    const id = nextId();
    await insertFeature(id);
    const before = await clockOf(id);
    await sql`
      UPDATE harness_shared.work_items
         SET ts = COALESCE(ts, 0) + 1, updated_ts = COALESCE(updated_ts, 0) + 1
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    expect(await clockOf(id)).toEqual(before);
    expect(await outboxCount(id)).toBe(1);
  });

  it('the ping-pong edge: a local-only reaction to a REMOTE apply stays remote and ships nothing', async () => {
    const id = nextId();
    await insertFeature(id);
    // A projection apply: the wire clock moves (peer HLC) and origin becomes 'remote'.
    // The capture's echo guard ships nothing for it.
    const peerHlc = '009999999999999:peerbbbb';
    await sql`
      UPDATE harness_shared.work_items
         SET status = 'done', title = 'B-side-write', fed_hlc = ${peerHlc},
             fed_ts = 9999999999999, origin = 'remote'
       WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    const applied = await clockOf(id);
    expect(applied).toEqual({ fed_ts: '9999999999999', fed_hlc: peerHlc, origin: 'remote' });
    expect(await outboxCount(id)).toBe(1);

    // This host then reacts locally (embedding backfill, verifier, release bookkeeping).
    // Before mig 1226 this minted a local HLC, flipped origin to 'local' and shipped the
    // row back to the peer, whose own reaction shipped it back again, forever.
    await localOnlyWrite(id);

    expect(await clockOf(id)).toEqual(applied);
    expect(await outboxCount(id)).toBe(1);
  });

  it('feature_wire_row keeps NULL-valued keys, so a column moving to NULL is content', async () => {
    const id = nextId();
    await insertFeature(id);
    await sql`UPDATE harness_shared.work_items SET wave = 'w3' WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    const before = await clockOf(id);
    await sql`UPDATE harness_shared.work_items SET wave = NULL WHERE workspace_id = ${WS} AND feature_id = ${id}`;
    expect((await clockOf(id)).fed_hlc).not.toBe(before.fed_hlc);
    expect(await outboxCount(id)).toBe(3);
  });

  it('the issue family is unaffected: a local-only write still keeps the clock (mig 1208)', async () => {
    const id = `WI-FEATWIRE-ISSUE-${Date.now()}`;
    await sql`
      INSERT INTO harness_shared.work_items
        (workspace_id, harness_slug, feature_id, title, summary, status, item_kind, origin, payload)
      VALUES (${WS}, ${HARNESS}, ${id}, 'issue', 'body', 'open', 'bug', 'local', ${sql.json({ _ei: { severity: 'minor' } })})`;
    const before = await clockOf(id);
    await localOnlyWrite(id);
    expect(await clockOf(id)).toEqual(before);
  });
});
