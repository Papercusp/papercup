/**
 * capture-outbox-wire-ts.integration.test.ts — mig 446 (P-013 / WI-1544 rig,
 * scenario concurrent_lww).
 *
 * A local write's LWW clock is stamped by the mig-314 BEFORE trigger with
 * `clock_timestamp()` (fed_ts + fed_hlc, atomic), but the AFTER capture trigger
 * used to enqueue the op with ts = `now()` — the transaction-START time, an
 * earlier read of a different clock. The drain threads outbox.ts → op.ts and the
 * remote projection persists op.ts as fed_ts, so the author's row and every
 * receiver's row held PERMANENTLY different fed_ts for the same op (live: 8ms
 * apart on the WI-1544 rig — winner tuple byte-identical except fed_ts, forever).
 *
 * Mig 446 fixes the capture to thread the ROW's fed_ts as the put-op's wire ts
 * (same one-clock treatment op_hlc already got from mig 314). This test drives
 * the REAL triggers on a REAL migrated Postgres and asserts the invariant at the
 * capture boundary: put wire ts == the row's stored fed_ts, byte-identical.
 *
 * Docker-gated (`*.integration.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';

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

const WS = 'ws-cap-wire-ts';
const HARNESS = 'cell-cap-wire-ts';
const FID = 'F-cap-wire-ts';

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'capwts',
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
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

async function featureRow(): Promise<{ fed_ts: string; fed_hlc: string } | null> {
  const rows = await sql<{ fed_ts: string; fed_hlc: string }[]>`
    SELECT fed_ts, fed_hlc FROM harness_shared.harness_features_consolidated
    WHERE harness_slug = ${HARNESS} AND feature_id = ${FID}`;
  return rows.length ? rows[0] : null;
}

async function outboxOps(): Promise<{ op: string; ts: string; op_hlc: string | null }[]> {
  return sql<{ op: string; ts: string; op_hlc: string | null }[]>`
    SELECT op, ts, op_hlc FROM harness_shared.substrate_outbox
    WHERE key = ${FID} ORDER BY id`;
}

describe('mig 446 — the capture boundary stamps the put-op wire ts from the ROW fed_ts', () => {
  it('local INSERT: the captured op carries ts == the stamped fed_ts and op_hlc == fed_hlc, byte-identical', async () => {
    // No fed_ts/fed_hlc/origin supplied → the mig-314 BEFORE trigger stamps both.
    await sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, status, item_kind)
      VALUES (${WS}, ${HARNESS}, ${FID}, 'v1', 'feature')`;
    const row = await featureRow();
    expect(row?.fed_ts).toBeTruthy();
    expect(row?.fed_hlc).toBeTruthy();

    const ops = await outboxOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('put');
    // THE invariant: the wire ts is the row's stamp — not a second clock read.
    // Pre-446 this was now() (txn start), permanently diverging author-vs-receiver
    // fed_ts (the concurrent_lww byte-identical-tuple failure).
    expect(ops[0].ts).toBe(row!.fed_ts);
    expect(ops[0].op_hlc).toBe(row!.fed_hlc);
  });

  it('local UPDATE (content change → re-stamp): the second op carries the NEW fed_ts', async () => {
    const before = await featureRow();
    await sql`
      UPDATE harness_shared.harness_features_consolidated
      SET status = 'v2'
      WHERE harness_slug = ${HARNESS} AND feature_id = ${FID}`;
    const after = await featureRow();
    expect(after!.fed_ts >= before!.fed_ts).toBe(true);
    expect(after!.fed_hlc > before!.fed_hlc).toBe(true); // hlc_now() is strictly monotone

    const ops = await outboxOps();
    expect(ops).toHaveLength(2);
    expect(ops[1].op).toBe('put');
    expect(ops[1].ts).toBe(after!.fed_ts);
    expect(ops[1].op_hlc).toBe(after!.fed_hlc);
  });

  it('DELETE: the del op keeps a fresh capture-time ts (its own event — NOT the stale row fed_ts)', async () => {
    const row = await featureRow();
    await sql`
      DELETE FROM harness_shared.harness_features_consolidated
      WHERE harness_slug = ${HARNESS} AND feature_id = ${FID}`;

    const ops = await outboxOps();
    expect(ops).toHaveLength(3);
    expect(ops[2].op).toBe('del');
    // A del is causally-after the row's last state; its wire ts must not be the
    // row's (older) put stamp, and its op_hlc is a fresh hlc_now() above the row's.
    expect(Number(ops[2].ts)).toBeGreaterThanOrEqual(Number(row!.fed_ts));
    expect(ops[2].op_hlc! > row!.fed_hlc).toBe(true);
  });
});
