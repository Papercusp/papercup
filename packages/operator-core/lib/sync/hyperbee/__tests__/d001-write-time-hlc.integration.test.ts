/**
 * d001-write-time-hlc.integration.test.ts — Brief J (shared-hive-release-testing),
 * the LOCAL-vs-REMOTE half of the D-001 fix that the comparator change alone does
 * NOT close (findings-J "the crux").
 *
 * The comparator fix (guard orders by fed_hlc) only converges if a LOCAL row also
 * carries an HLC. A local write never goes through an op, so before migration 314
 * its PG row had NO fed_hlc → an incoming remote op fell back to fed_ts → the
 * exact D-001 split-brain where the local write W (recv-advanced high HLC, low
 * wall-ts) loses to a remote L (low HLC, high wall-ts), and `skipOwnOps` means W
 * never re-folds to recover.
 *
 * This test drives the REAL write-time stamp (the mig-314 stamp_local_federated_write
 * trigger calling harness_shared.hlc_now()) on a REAL migrated Postgres, then
 * applies a conflicting remote op through the REAL projection, and asserts the
 * LOCAL write (higher HLC) WINS — i.e. the local row carried the HLC ordering key
 * and the guard ordered by it, not by the (lower) wall-clock fed_ts.
 *
 * Docker-gated (`*.integration.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import postgres from 'postgres';
import { createFreshTestDb, type MigratedTestDb } from '@papercusp/test-config';
import { encodeHlc } from '@papercusp/locks-core';
import { buildHarnessProjectionApply } from '../projections/register-all';
import { createMergeCursor, mergeAdmittedLogsIncremental, type AdmittedLog } from '../read-merge';
import { stampOpHlc } from '../hlc-stamp';
import { HlcClock } from '@papercusp/locks-core';
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

const WS = 'ws-d001-wt';
const HARNESS = 'cell-wt';
const FID = 'F-wt-contested';

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'd001wt',
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

async function rowOf(): Promise<{ status: string | null; fed_ts: string | null; fed_hlc: string | null } | null> {
  const rows = await sql<{ status: string | null; fed_ts: string | null; fed_hlc: string | null }[]>`
    SELECT status, fed_ts, fed_hlc FROM harness_shared.harness_features_consolidated
    WHERE harness_slug = ${HARNESS} AND feature_id = ${FID}`;
  return rows.length ? rows[0] : null;
}

function singleOpLog(keyHex: string, op: PeerLogOp): AdmittedLog {
  return { keyHex, length: 1, get: async (i) => (i === 0 ? op : null) };
}

describe('D-001 write-time HLC — a LOCAL write (mig-314 stamp) beats a higher-fed_ts remote op by HLC', () => {
  it('the PG hlc_now()/hlc_recv() clock functions exist and are monotone', async () => {
    const a = (await sql<{ h: string }[]>`SELECT harness_shared.hlc_now() AS h`)[0].h;
    const b = (await sql<{ h: string }[]>`SELECT harness_shared.hlc_now() AS h`)[0].h;
    expect(typeof a).toBe('string');
    expect(b > a).toBe(true); // strictly monotone
    // recv of an admissible-future HLC (WITHIN the mig-460 ε drift clamp, 10min)
    // advances the clock above it. An offset BEYOND the clamp is refused — that
    // is pinned by the drift-clamp test below; keep this one inside ε.
    const future = encodeHlc({ ms: Date.now() + 300_000, count: 0 });
    await sql`SELECT harness_shared.hlc_recv(${future})`;
    const c = (await sql<{ h: string }[]>`SELECT harness_shared.hlc_now() AS h`)[0].h;
    expect(c > future).toBe(true); // a later local stamp causally-follows the recv'd op
  });

  it('recv of an ABSURD-future HLC (beyond the ε drift clamp) does NOT ratchet the clock (WI-1672 / mig-460)', async () => {
    // The poisoning defense: a remote frontier >10min ahead of wall-now is
    // outside the hive's ±5min admission skew contract, so hlc_recv REFUSES to
    // advance the singleton clock (the op still applies to its data; only the
    // clock ratchet is skipped). Without this, one absurd stamp pins the clock —
    // and, re-propagated, the whole hive — far ahead (the WI-1672 amplifier).
    const absurd = encodeHlc({ ms: Date.now() + 3_600_000, count: 0 }); // +1h ≫ 10min ε
    await sql`SELECT harness_shared.hlc_recv(${absurd})`;
    const after = (await sql<{ h: string }[]>`SELECT harness_shared.hlc_now() AS h`)[0].h;
    const afterMs = Number(after.slice(0, after.indexOf(':')));
    expect(afterMs).toBeLessThan(Date.now() + 600_000); // clock stayed within ε, did NOT jump to +1h
    expect(after < absurd).toBe(true); // the absurd stamp sorts above our (un-ratcheted) clock
  });

  it('local write with a recv-advanced (high) HLC + low fed_ts is NOT clobbered by a higher-fed_ts remote op', async () => {
    // 1. PRIME: this peer observed a remote op whose HLC physical is a forward
    //    clock excursion (far ABOVE wall-now). The recv-advance sticks (HLC is
    //    monotone), so the NEXT local write is stamped with that high HLC even
    //    though its fed_ts (wall clock) is ~now.
    const excursionMs = Date.now() + 400_000; // +6.7min: a recv-advance WITHIN the mig-460 ε clamp (10min), so it still ratchets
    await sql`SELECT harness_shared.hlc_recv(${encodeHlc({ ms: excursionMs, count: 0 })})`;

    // 2. LOCAL WRITE W — a direct INSERT firing the mig-314 stamp trigger (NO
    //    fed_ts / fed_hlc / origin supplied → it stamps fed_ts=wall-now and
    //    fed_hlc=hlc_now() [the high, recv-advanced HLC], origin='local').
    await sql`
      INSERT INTO harness_shared.harness_features_consolidated
        (workspace_id, harness_slug, feature_id, status, item_kind)
      VALUES (${WS}, ${HARNESS}, ${FID}, 'W', 'feature')`;
    const w = await rowOf();
    expect(w?.status).toBe('W');
    // The trigger stamped both keys: fed_ts ≈ wall-now (low), fed_hlc ≈ excursion (high).
    expect(w?.fed_hlc).not.toBeNull();
    expect(w?.fed_ts).not.toBeNull();
    const wFedTs = Number(w!.fed_ts);
    expect(w!.fed_hlc! > encodeHlc({ ms: excursionMs, count: 0 })).toBe(true); // HLC is the excursion-high value
    expect(wFedTs).toBeLessThan(excursionMs); // wall-clock fed_ts is far below it

    // 3. REMOTE OP L — concurrent, LOWER HLC but HIGHER fed_ts than W. Applied
    //    through the REAL projection. ts (= L's fed_ts) is between W.fed_ts and
    //    the excursion; L's HLC physical is also between, so L.fed_hlc < W.fed_hlc.
    const lTs = wFedTs + 100_000; // L.fed_ts > W.fed_ts (the OLD guard would let L win)
    const lHlc = encodeHlc({ ms: wFedTs + 100_000, count: 0 }); // but L.fed_hlc < W.fed_hlc (excursion-high)
    expect(lHlc < w!.fed_hlc!).toBe(true); // sanity: L is the HLC loser
    const opL: PeerLogOp = {
      type: 'put',
      table: 'features-by-id',
      hbKey: FID,
      value: {
        harness_slug: HARNESS, feature_id: FID, title: null, summary: null, status: 'L',
        attempts: 0, claims: null, notes: null, metadata: null, kind: null, project_id: null,
        expected_cost_cents: null, tags: null, needs_human_review: false,
        ts: lTs, created_ts: lTs, updated_ts: lTs, parent_id: null, goal_id: null,
        taken_by: null, taken_at: null, expires_at: null,
      },
      ts: lTs,
      schema_version: 1,
      hlc: lHlc,
      author_pubkey: 'pk-remote-L',
      // a DIFFERENT source log than this peer's own → applied as a remote op.
      sourceLogKeyHex: 'remote-log-L',
    } as PeerLogOp;
    const apply = buildHarnessProjectionApply({ workspaceId: WS, harnessSlug: HARNESS, sql });
    const cursor = createMergeCursor();
    await mergeAdmittedLogsIncremental([singleOpLog('remote-log-L', opL)], cursor, {
      applyImpl: apply,
      getTimeoutMs: 0,
    });

    // 4. ASSERT: W wins (higher HLC), even though L.fed_ts > W.fed_ts. Under the
    //    pre-314 fed_ts guard L would have clobbered W → the D-001 local-vs-remote
    //    split-brain. The write-time fed_hlc stamp + the fed_hlc guard converge it.
    const after = await rowOf();
    expect(after?.status).toBe('W');
  });

  it('CONTROL — a remote op that is BOTH higher-fed_ts AND higher-HLC correctly wins (no false-pin)', async () => {
    // Guards against "the new guard just always keeps the local row". A genuinely
    // newer remote op (higher HLC) must still win.
    const w = await rowOf();
    const baseHlc = w!.fed_hlc!;
    const newerTs = Number(w!.fed_ts) + 2_000_000;
    // a clock strictly above the stored fed_hlc's ms.
    const storedMs = Number(baseHlc.slice(0, baseHlc.indexOf(':')));
    const newerHlc = encodeHlc({ ms: storedMs + 1, count: 0 });
    const opNewer: PeerLogOp = {
      type: 'put', table: 'features-by-id', hbKey: FID,
      value: {
        harness_slug: HARNESS, feature_id: FID, title: null, summary: null, status: 'NEWER',
        attempts: 0, claims: null, notes: null, metadata: null, kind: null, project_id: null,
        expected_cost_cents: null, tags: null, needs_human_review: false,
        ts: newerTs, created_ts: newerTs, updated_ts: newerTs, parent_id: null, goal_id: null,
        taken_by: null, taken_at: null, expires_at: null,
      },
      ts: newerTs, schema_version: 1, hlc: newerHlc, author_pubkey: 'pk-remote-newer',
      sourceLogKeyHex: 'remote-log-newer',
    } as PeerLogOp;
    const apply = buildHarnessProjectionApply({ workspaceId: WS, harnessSlug: HARNESS, sql });
    const cursor = createMergeCursor();
    await mergeAdmittedLogsIncremental([singleOpLog('remote-log-newer', opNewer)], cursor, {
      applyImpl: apply, getTimeoutMs: 0,
    });
    expect((await rowOf())?.status).toBe('NEWER');
  });
});

// keep the unused import honest (HlcClock/stampOpHlc are imported for parity with
// the sibling twin and may be used by future cases); reference them no-op.
void HlcClock;
void stampOpHlc;
