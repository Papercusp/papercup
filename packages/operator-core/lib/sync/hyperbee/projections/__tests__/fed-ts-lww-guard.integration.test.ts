/**
 * fed-ts-lww-guard.integration.test.ts — the EI-79 residual STEP 2 correctness
 * contract on REAL Postgres (the partner of the incremental merge cursor).
 *
 * The incremental merge cursor (`mergeAdmittedLogsIncremental`) only decodes the
 * DELTA of each grown log per pass. That is correct ONLY if applying an OLD op
 * to a row that already holds a NEWER value is a no-op AT THE PG LAYER — so a
 * late / out-of-order / backfilled op can never clobber a newer projected row.
 * The in-process `cursor.winners` fold guards this within one process; these
 * tests prove the SECOND, independent floor: every mutating projection writer is
 * PG-level last-write-wins via its `fed_ts` column guard
 * (`WHERE EXCLUDED.fed_ts >= <table>.fed_ts`), so correctness holds even when the
 * op arrives WITHOUT going through (or after a reset of) the cursor fold — e.g. a
 * fresh process replaying an old op, or two writers to the same shared row.
 *
 * Docker-gated (`*.integration.test.ts`) — needs a real migrated PG; the guard
 * is pure SQL, invisible to the SQL-mocked unit tests.
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

const WS = 'ws-fed-ts';
const HARNESS = 'fed-ts';
const AUTHOR = 'f'.repeat(64);

let db: MigratedTestDb;
let sql: postgres.Sql;
let apply: (op: OpEnvelope) => Promise<boolean>;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'fedts',
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

/** A `features-by-id` put op at a given wire ts. */
function featurePut(featureId: string, status: string, ts: number): OpEnvelope {
  return {
    type: 'put',
    table: 'features-by-id',
    hbKey: featureId,
    value: {
      harness_slug: HARNESS,
      feature_id: featureId,
      title: `feat ${featureId}`,
      summary: null,
      status,
      attempts: 0,
      claims: null,
      notes: null,
      metadata: null,
      kind: null,
      project_id: null,
      expected_cost_cents: null,
      tags: null,
      needs_human_review: false,
      ts,
      created_ts: ts,
      updated_ts: ts,
      parent_id: null,
      goal_id: null,
      taken_by: null,
      taken_at: null,
      expires_at: null,
    },
    ts,
    schema_version: 1,
    writerPubkey: AUTHOR,
  };
}

function featureDel(featureId: string, ts: number): OpEnvelope {
  return { type: 'del', table: 'features-by-id', hbKey: featureId, ts, schema_version: 1, writerPubkey: AUTHOR };
}

async function statusOf(featureId: string): Promise<string | null> {
  const rows = await sql<{ status: string | null }[]>`
    SELECT status FROM harness_shared.harness_features_consolidated
    WHERE harness_slug = ${HARNESS} AND feature_id = ${featureId}`;
  return rows.length ? rows[0].status : null;
}

describe('EI-79 step 2 — PG-level fed_ts LWW guard (out-of-order safety)', () => {
  it('a NEWER put then an OLDER put → the row keeps the NEWER value', async () => {
    const id = 'F-oo-1';
    expect(await apply(featurePut(id, 'newer', 2000))).toBe(true);
    expect(await statusOf(id)).toBe('newer');

    // The older op arrives late (out-of-order replication / a backfilling peer).
    // The writer's `WHERE EXCLUDED.fed_ts >= fed_ts` guard makes the UPDATE a
    // no-op — the row is NOT clobbered back to 'older'.
    await apply(featurePut(id, 'older', 1000));
    expect(await statusOf(id)).toBe('newer');
  });

  it('an OLDER put then a NEWER put → the newer applies (forward progress preserved)', async () => {
    const id = 'F-oo-2';
    expect(await apply(featurePut(id, 'older', 1000))).toBe(true);
    expect(await statusOf(id)).toBe('older');
    await apply(featurePut(id, 'newer', 2000));
    expect(await statusOf(id)).toBe('newer');
  });

  it('an equal-ts put applies (>= ; LWW ties never lose data either way)', async () => {
    const id = 'F-oo-eq';
    expect(await apply(featurePut(id, 'first', 1500))).toBe(true);
    await apply(featurePut(id, 'second', 1500));
    expect(await statusOf(id)).toBe('second');
  });

  it('a STALE del (older than the standing row) must NOT erase it', async () => {
    const id = 'F-oo-del';
    expect(await apply(featurePut(id, 'live', 3000))).toBe(true);
    // An older delete arrives out of order — the ts-guarded DELETE matches nothing.
    await apply(featureDel(id, 1000));
    expect(await statusOf(id)).toBe('live');
    // A newer delete DOES remove it.
    await apply(featureDel(id, 4000));
    expect(await statusOf(id)).toBeNull();
  });

  it('cross-process: a FRESH apply (empty fold) replaying an OLD op cannot clobber PG', async () => {
    const id = 'F-xproc';
    // Process A wrote the newer value.
    expect(await apply(featurePut(id, 'A-newer', 5000))).toBe(true);
    // Process B boots with an EMPTY cursor fold and happens to replay an OLD op
    // first (its in-memory guard sees no prior winner, so it WOULD apply it —
    // the PG fed_ts guard is the only thing protecting the row here).
    const freshApply = buildHarnessProjectionApply({ workspaceId: WS, harnessSlug: HARNESS, sql });
    await freshApply(featurePut(id, 'B-older', 2000));
    expect(await statusOf(id)).toBe('A-newer');
  });
});
