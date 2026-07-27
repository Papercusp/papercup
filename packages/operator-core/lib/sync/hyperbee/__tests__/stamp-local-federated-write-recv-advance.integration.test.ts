/**
 * stamp-local-federated-write-recv-advance.integration.test.ts — WI-6249.
 *
 * `stamp_local_federated_write()` (the mig-314 BEFORE trigger) is defined by a
 * chain of full-body `CREATE OR REPLACE` migrations: 314/490 -> 517 -> 528 -> 653
 * -> 681. Migration 528 added the D-001 causal recv-advance contract: on either
 * REMOTE path (an UPDATE that moves fed_ts, or a remote INSERT carrying an HLC),
 * the trigger calls `harness_shared.hlc_recv(NEW.fed_hlc)` so THIS process's
 * logical clock advances past the observed remote op's clock — guaranteeing a
 * later LOCAL write is stamped strictly-after it.
 *
 * Migration 653 replaced the whole function body from a stale pre-528 copy and
 * silently dropped both hlc_recv calls (kept everything else 528 added). 681
 * replaced the body again from 653's copy, carrying the regression forward
 * un-noticed (681's own header documents this as a known, deliberately-deferred
 * gap). Migration 699 restores both calls on the CURRENT (681) body.
 *
 * This is the META-PATTERN guard the WI-6249 filing asked for: this function has
 * now been damaged TWICE by a full-body clobber (517 dropped 314's HLC insert
 * stamp; 653/681 dropped 528's recv-advance). Rather than parse the DDL text,
 * this drives the REAL trigger on a REAL migrated Postgres and proves the clock
 * actually moves — so a future full-body replace that drops the recv-advance
 * again fails HERE, not silently.
 *
 * Docker-gated (`*.integration.test.ts`).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config/pg';
import { encodeHlc } from '@papercusp/locks-core';

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

const WS = 'ws-recv-advance';
const HARNESS = 'cell-recv-advance';

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'recvadv',
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

async function hlcNow(): Promise<string> {
  return (await sql<{ h: string }[]>`SELECT harness_shared.hlc_now() AS h`)[0].h;
}

describe('stamp_local_federated_write — D-001 recv-advance on the two REMOTE paths (mig-528, restored by mig-699)', () => {
  beforeEach(async () => {
    await sql`DELETE FROM harness_shared.harness_features_consolidated WHERE harness_slug = ${HARNESS}`;
  });

  it('the live function body still calls hlc_recv (regression guard — mig-653/681 both silently dropped this)', async () => {
    const rows = await sql<{ src: string }[]>`
      SELECT pg_get_functiondef(p.oid) AS src
        FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'harness_shared' AND p.proname = 'stamp_local_federated_write'`;
    expect(rows).toHaveLength(1);
    expect(
      rows[0].src,
      'stamp_local_federated_write() no longer calls hlc_recv — the D-001 causal ' +
        'recv-advance (mig-528) was dropped again by a full-body CREATE OR REPLACE. ' +
        'See migration 699.',
    ).toContain('hlc_recv');
  });

  it('a remote UPDATE that moves fed_ts (projection apply) recv-advances the clock past its fed_hlc', async () => {
    const fid = 'F-recv-update';
    // Seed a row with an ordinary local INSERT.
    await sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, status, item_kind)
      VALUES (${WS}, ${HARNESS}, ${fid}, 'seed', 'feature')`;

    const before = await hlcNow();
    // A remote op whose HLC is far in the future relative to our current clock
    // (within the mig-460 admission-skew clamp) — simulates a projection apply
    // moving fed_ts on an UPDATE.
    const remoteHlc = encodeHlc({ ms: Date.now() + 400_000, count: 0 });
    await sql`
      UPDATE harness_shared.harness_features_consolidated
         SET status = 'remote-applied', fed_ts = ${Date.now() + 400_000}, fed_hlc = ${remoteHlc}, origin = 'remote'
       WHERE harness_slug = ${HARNESS} AND feature_id = ${fid}`;

    const after = await hlcNow();
    expect(after > before, 'clock did not advance at all across the remote UPDATE').toBe(true);
    expect(
      after > remoteHlc,
      'hlc_now() after the remote UPDATE must sort strictly ABOVE the remote fed_hlc — ' +
        'proves hlc_recv(NEW.fed_hlc) actually ran on the fed_ts-moved UPDATE branch',
    ).toBe(true);
  });

  it('a remote INSERT carrying fed_hlc recv-advances the clock, even though it is not a local stamp', async () => {
    const fid = 'F-recv-insert';
    const before = await hlcNow();
    const remoteHlc = encodeHlc({ ms: Date.now() + 500_000, count: 0 });
    await sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, status, item_kind, fed_ts, fed_hlc, origin)
      VALUES (${WS}, ${HARNESS}, ${fid}, 'remote-insert', 'feature', ${Date.now() + 500_000}, ${remoteHlc}, 'remote')`;

    const after = await hlcNow();
    expect(after > before, 'clock did not advance at all across the remote INSERT').toBe(true);
    expect(
      after > remoteHlc,
      'hlc_now() after the remote INSERT must sort strictly ABOVE the remote fed_hlc — ' +
        'proves hlc_recv(NEW.fed_hlc) actually ran on the remote-INSERT branch',
    ).toBe(true);

    // The remote INSERT itself must be left untouched by the local-stamp branch —
    // fed_hlc stays exactly what the caller supplied, not overwritten by hlc_now().
    const row = (
      await sql<{ fed_hlc: string }[]>`
      SELECT fed_hlc FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${HARNESS} AND feature_id = ${fid}`
    )[0];
    expect(row.fed_hlc).toBe(remoteHlc);
  });

  it('a genuinely LOCAL insert/update still stamps fed_ts + fed_hlc as before (no regression to the local-stamp path)', async () => {
    const fid = 'F-recv-local';
    await sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, status, item_kind)
      VALUES (${WS}, ${HARNESS}, ${fid}, 'local', 'feature')`;
    const row = (
      await sql<{ fed_ts: string | null; fed_hlc: string | null; origin: string | null }[]>`
      SELECT fed_ts, fed_hlc, origin FROM harness_shared.harness_features_consolidated
       WHERE harness_slug = ${HARNESS} AND feature_id = ${fid}`
    )[0];
    expect(row.fed_ts).not.toBeNull();
    expect(row.fed_hlc).not.toBeNull();
  });
});
