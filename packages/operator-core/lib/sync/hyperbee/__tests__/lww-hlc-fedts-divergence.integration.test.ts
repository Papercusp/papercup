/**
 * lww-hlc-fedts-divergence.integration.test.ts — Brief D finding D-001, the
 * AIRTIGHT real-Postgres twin of `lww-hlc-fedts-divergence.test.ts`.
 *
 * Removes the only objection to the fast (in-memory) repro — "your fed_ts guard
 * model might be wrong" — by driving the REAL merge (`mergeAdmittedLogsIncremental`
 * → `beatsStored`/`lwwPick`) into the REAL `buildHarnessProjectionApply` against
 * a REAL migrated Postgres (the genuine `harness_features_consolidated` UPSERT
 * `WHERE EXCLUDED.fed_ts >= stored.fed_ts` clause + the migration-214
 * `stamp_local_federated_write` trigger, which respects a projection-supplied
 * fed_ts = op.ts verbatim).
 *
 * Two cells = two harness namespaces in one DB (PK is (harness_slug, feature_id),
 * so two slugs are two independent peer row-sets). Each cell folds the SAME two
 * contested ops in the order its OWN-log write lands first (the production-
 * realistic fold order). They MUST converge; they do not.
 *
 * Docker-gated (`*.integration.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { HlcClock } from '@papercusp/locks-core';
import { buildHarnessProjectionApply } from '../projections/register-all';
import { stampOpHlc } from '../hlc-stamp';
import { createMergeCursor, mergeAdmittedLogsIncremental, type AdmittedLog } from '../read-merge';
import type { PeerLogOp } from '../peer-log';

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

const WS = 'ws-hlc-fedts';
const FID = 'F-contested';

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'hlcfedts',
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

/** A feature `put` PeerLogOp, HLC-stamped through the REAL send seam on `clock`. */
function stampedFeaturePut(opts: {
  harnessSlug: string;
  status: string;
  ts: number;
  clock: HlcClock;
}): PeerLogOp {
  const base: PeerLogOp = {
    type: 'put',
    table: 'features-by-id',
    hbKey: FID,
    value: {
      harness_slug: opts.harnessSlug,
      feature_id: FID,
      title: `feat ${FID}`,
      summary: null,
      status: opts.status,
      attempts: 0,
      claims: null,
      notes: null,
      metadata: null,
      kind: null,
      project_id: null,
      expected_cost_cents: null,
      tags: null,
      needs_human_review: false,
      ts: opts.ts,
      created_ts: opts.ts,
      updated_ts: opts.ts,
      parent_id: null,
      goal_id: null,
      taken_by: null,
      taken_at: null,
      expires_at: null,
    },
    ts: opts.ts,
    schema_version: 1,
    author_pubkey: `pk-${opts.status}`,
  };
  return stampOpHlc(base, opts.clock);
}

function singleOpLog(keyHex: string, op: PeerLogOp): AdmittedLog {
  return { keyHex, length: 1, get: async (i) => (i === 0 ? op : null) };
}

async function statusOf(harnessSlug: string): Promise<string | null> {
  const rows = await sql<{ status: string | null }[]>`
    SELECT status FROM harness_shared.harness_features_consolidated
    WHERE harness_slug = ${harnessSlug} AND feature_id = ${FID}`;
  return rows.length ? rows[0].status : null;
}

/** Build the inverted pair for a given harness slug: winner W (high HLC via
 *  recv-advance, low fed_ts) and loser L (low HLC, high fed_ts). */
function invertedPair(harnessSlug: string): { opW: PeerLogOp; opL: PeerLogOp } {
  const clockW = new HlcClock({ physical: () => 1000 });
  clockW.recv({ ms: 9000, count: 0 }); // observed a high-HLC remote op
  const opW = stampedFeaturePut({ harnessSlug, status: 'W', ts: 1000, clock: clockW });
  const clockL = new HlcClock({ physical: () => 5000 });
  const opL = stampedFeaturePut({ harnessSlug, status: 'L', ts: 5000, clock: clockL });
  return { opW, opL };
}

/** Run the REAL merge of two logs in a given order into the REAL projection
 *  apply bound to `harnessSlug`'s rows. */
async function mergeIntoPg(harnessSlug: string, logs: AdmittedLog[]): Promise<void> {
  const apply = buildHarnessProjectionApply({ workspaceId: WS, harnessSlug, sql });
  const cursor = createMergeCursor();
  await mergeAdmittedLogsIncremental(logs, cursor, { applyImpl: apply, getTimeoutMs: 0 });
  await mergeAdmittedLogsIncremental(logs, cursor, { applyImpl: apply, getTimeoutMs: 0 });
}

describe('D-001 real-PG — HLC-merge vs fed_ts-guard divergence (FIXED: fed_hlc guard)', () => {
  // RELEASE INVARIANT, now GREEN (migration 314 + the projection fed_hlc guard):
  // the two cells fold the SAME contested ops in opposite orders and CONVERGE.
  // Flipped from `it.fails` once the comparators were unified onto `fed_hlc`.
  it('two peers (real PG projection) converge on the contested key', async () => {
    // Cell A (loser's author): folds its own write first → [logL, logW].
    const a = invertedPair('cellA');
    await mergeIntoPg('cellA', [singleOpLog('logL', a.opL), singleOpLog('logW', a.opW)]);
    // Cell B (winner's author): folds its own write first → [logW, logL].
    const b = invertedPair('cellB');
    await mergeIntoPg('cellB', [singleOpLog('logW', b.opW), singleOpLog('logL', b.opL)]);

    expect(await statusOf('cellA')).toBe(await statusOf('cellB'));
  });

  it('both cells materialise W (the HLC winner) — the guard now orders by fed_hlc', async () => {
    const a = invertedPair('cellA2');
    await mergeIntoPg('cellA2', [singleOpLog('logL', a.opL), singleOpLog('logW', a.opW)]);
    const b = invertedPair('cellB2');
    await mergeIntoPg('cellB2', [singleOpLog('logW', b.opW), singleOpLog('logL', b.opL)]);

    // cellA: applies L, then W — W.fed_hlc(9000…) >= L.fed_hlc(5000…) → W lands
    // (the guard no longer rejects the fold-winner on the lower fed_ts 1000<5000).
    expect(await statusOf('cellA2')).toBe('W');
    expect(await statusOf('cellB2')).toBe('W'); // merge suppressed L (HLC lower)
  });

  it('control — no inversion (HLC monotone with ts) converges on real PG', async () => {
    const clock = new HlcClock({ physical: () => 0 });
    const early = stampedFeaturePut({ harnessSlug: 'cellCtl', status: 'early', ts: 1000, clock });
    const late = stampedFeaturePut({ harnessSlug: 'cellCtl', status: 'late', ts: 2000, clock });
    const clock2 = new HlcClock({ physical: () => 0 });
    const early2 = stampedFeaturePut({ harnessSlug: 'cellCtl2', status: 'early', ts: 1000, clock: clock2 });
    const late2 = stampedFeaturePut({ harnessSlug: 'cellCtl2', status: 'late', ts: 2000, clock: clock2 });
    await mergeIntoPg('cellCtl', [singleOpLog('logE', early), singleOpLog('logLate', late)]);
    await mergeIntoPg('cellCtl2', [singleOpLog('logLate', late2), singleOpLog('logE', early2)]);
    expect(await statusOf('cellCtl')).toBe('late');
    expect(await statusOf('cellCtl2')).toBe('late'); // converges — late wins both keys
  });
});
