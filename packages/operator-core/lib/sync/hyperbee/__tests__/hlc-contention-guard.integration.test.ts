/**
 * hlc-contention-guard.integration.test.ts — WI-38304.
 *
 * Migration 813 replaced the singleton-row HLC clock (which took
 * `hlc_clock WHERE id=1 FOR UPDATE` inside `hlc_now()`) with a sequence-backed
 * frontier guarded by a short-lived SESSION advisory lock. The bug it fixed:
 * `hlc_now()` normally runs inside a caller's larger transaction (usually from a
 * BEFORE trigger), so Postgres retained that ROW lock until the OUTER transaction
 * committed — one slow federated write serialized every unrelated federated write
 * and the 5s workspace lock_timeout failed with 55P03 under fleet bursts.
 *
 * `d001-write-time-hlc.integration.test.ts` asserts the fixed behaviour (a peer
 * connection can still stamp while a caller transaction is open). That assertion
 * passes today — but a guard whose live assertion is green proves nothing about
 * the GUARD. This file adds what was missing:
 *
 *  1. CONTROL — install the real pre-813 `hlc_now()` and prove the scenario
 *     ACTUALLY detects it (55P03). Without this, "the peer stamped fine" is
 *     equally consistent with a scenario that could never fail.
 *  2. SUBJECT — the shipped 813 function passes the same scenario.
 *  3. The lock-release contract the 813 design depends on, tested as a PROPERTY
 *     of the pattern rather than by trying to win a microsecond race.
 *
 * Every mutation here happens inside this file's OWN throwaway database
 * (`createFreshTestDb`), never the shared tree or the shared operator DB.
 *
 * Docker-gated (`*.integration.test.ts`).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
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

/**
 * The REAL pre-813 implementation, lifted verbatim from migration
 * 466-hlc-node-id-strong-entropy.sql (the last definition before 813). This is
 * the deliberately-wrong control the repo's mutation-probe guidance prescribes:
 * a known-bad implementation kept permanently in the TEST file, so falsifiability
 * is proven without ever mutating the shared tree.
 */
const LEGACY_PRE_813_HLC_NOW = `
CREATE OR REPLACE FUNCTION harness_shared.hlc_now() RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  AS $fn$
DECLARE
  now_ms  bigint := floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint;
  l_ms    bigint;
  l_count integer;
  l_node  text;
  n_ms    bigint;
  n_count integer;
BEGIN
  SELECT last_ms, last_count, node_id INTO l_ms, l_count, l_node
    FROM harness_shared.hlc_clock WHERE id = 1 FOR UPDATE;
  IF l_ms IS NULL THEN
    INSERT INTO harness_shared.hlc_clock (id, last_ms, last_count) VALUES (1, 0, 0)
      ON CONFLICT (id) DO NOTHING;
    l_ms := 0; l_count := 0; l_node := NULL;
  END IF;
  IF COALESCE(l_node, '') = '' THEN
    l_node := lower(encode(gen_random_bytes(8), 'hex'));
    UPDATE harness_shared.hlc_clock SET node_id = l_node WHERE id = 1;
  END IF;
  IF now_ms > l_ms THEN
    n_ms := now_ms; n_count := 0;
  ELSIF l_count >= 65535 THEN
    n_ms := l_ms + 1; n_count := 0;
  ELSE
    n_ms := l_ms; n_count := l_count + 1;
  END IF;
  UPDATE harness_shared.hlc_clock SET last_ms = n_ms, last_count = n_count WHERE id = 1;
  RETURN lpad(n_ms::text, 15, '0') || ':' || lpad(n_count::text, 5, '0') || ':' || l_node;
END;
$fn$;
`;

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'hlccontend',
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

/**
 * Restore the SHIPPED clock after the control mutates it.
 *
 * Re-applies every migration that defines `hlc_now`, in numeric order, rather
 * than naming one file: the definition has moved between migrations before
 * (314 → 459 → 466 → 813 → …), and pinning this to a single file would silently
 * restore a SUPERSEDED implementation the day another one lands. All of them are
 * idempotent (IF NOT EXISTS / GREATEST / CREATE OR REPLACE).
 */
function hlcDefiningMigrations(): string[] {
  const files = readdirSync(SQL_DIR)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => readFileSync(resolve(SQL_DIR, f), 'utf8').includes('FUNCTION harness_shared.hlc_now'))
    .sort((a, b) => Number.parseInt(a, 10) - Number.parseInt(b, 10));
  // An empty list would make the control's restore a silent no-op, leaving the
  // legacy function installed and every later assertion answering about it.
  if (files.length === 0) throw new Error(`no migration in ${SQL_DIR} defines harness_shared.hlc_now`);
  return files;
}

async function restoreShippedHlcNow(): Promise<void> {
  for (const f of hlcDefiningMigrations()) {
    await sql.unsafe(readFileSync(resolve(SQL_DIR, f), 'utf8'));
  }
}

/**
 * The WI-38304 scenario: hold an open caller transaction that has already
 * stamped an HLC, then have an INDEPENDENT connection try to stamp one under a
 * short lock_timeout. Resolves to the peer's HLC, or throws the peer's error.
 */
async function peerStampWhileCallerTxnOpen(): Promise<string> {
  const peer = postgres(db.url, { max: 1, onnotice: () => {}, prepare: false });
  try {
    return await sql.begin(async (outer) => {
      await outer<{ h: string }[]>`SELECT harness_shared.hlc_now() AS h`;
      return await peer.begin(async (p) => {
        await p.unsafe(`SET LOCAL lock_timeout = '1s'`);
        return (await p<{ h: string }[]>`SELECT harness_shared.hlc_now() AS h`)[0].h;
      });
    });
  } finally {
    await peer.end({ timeout: 5 });
  }
}

describe('WI-38304 — the HLC clock must not serialize unrelated federated writes', () => {
  it('CONTROL — the pre-813 FOR UPDATE clock IS caught by this scenario (proves the guard can fail)', async () => {
    await sql.unsafe(LEGACY_PRE_813_HLC_NOW);
    try {
      await expect(peerStampWhileCallerTxnOpen()).rejects.toMatchObject({ code: '55P03' });
    } finally {
      await restoreShippedHlcNow();
    }
  }, 60_000);

  it('SUBJECT — the shipped sequence-backed clock (mig 813) does not block the peer', async () => {
    // Guards against the control above leaking: this must run against the REAL function.
    const src = (
      await sql<{ s: string }[]>`
        SELECT p.prosrc AS s FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'harness_shared' AND p.proname = 'hlc_now'`
    )[0].s;
    expect(src).not.toContain('FOR UPDATE');
    expect(src).toContain('hlc_packed_seq');

    const stamped = await peerStampWhileCallerTxnOpen();
    expect(typeof stamped).toBe('string');
    expect(stamped.length).toBeGreaterThan(0);
  }, 60_000);

  /**
   * 813 takes a SESSION-level advisory lock (not a transaction one — a txn lock
   * would be held until the caller's outer transaction committed, which is the
   * very bug being fixed) and relies on releasing it before returning, with an
   * `EXCEPTION WHEN others` handler as the failure path.
   *
   * A session advisory lock is NOT released by transaction rollback — only by an
   * explicit unlock or backend exit. So if any error can escape that handler
   * while the lock is held, a pooled backend keeps the lock forever and every
   * later hlc_now() fleet-wide blocks on it: the ORIGINAL 55P03 symptom, made
   * permanent instead of transient.
   *
   * These two cases test the handler's reach as a property of the pattern —
   * deterministically, instead of trying to win the microsecond race inside the
   * real function. Both use the identical structure; only the error TYPE differs,
   * which is what makes the pair a controlled comparison rather than one reading.
   */
  describe('the advisory-lock release contract 813 depends on', () => {
    const PROBE_KEY = 48452354999;

    async function runProbe(
      failure: 'divide_by_zero' | 'statement_timeout',
      handler: 'others' | 'others+canceled' = 'others',
    ): Promise<{
      errorCode: string | null;
      leakedLocks: number;
    }> {
      const c = postgres(db.url, { max: 1, onnotice: () => {}, prepare: false });
      try {
        // Same shape as harness_shared.hlc_now(): take the session lock, do the
        // protected work, unlock on the way out AND from the failure handler.
        const canceledArm =
          handler === 'others+canceled'
            ? `WHEN query_canceled THEN
                 PERFORM pg_catalog.pg_advisory_unlock(lock_key);
                 RAISE;`
            : '';
        await c.unsafe(`
          CREATE OR REPLACE FUNCTION public.hlc_lock_probe(mode text) RETURNS void
            LANGUAGE plpgsql AS $fn$
          DECLARE lock_key constant bigint := ${PROBE_KEY};
          BEGIN
            PERFORM pg_catalog.pg_advisory_lock(lock_key);
            BEGIN
              IF mode = 'divide_by_zero' THEN PERFORM 1 / 0; END IF;
              IF mode = 'statement_timeout' THEN PERFORM pg_sleep(5); END IF;
            EXCEPTION
              ${canceledArm}
              WHEN others THEN
                PERFORM pg_catalog.pg_advisory_unlock(lock_key);
                RAISE;
            END;
            PERFORM pg_catalog.pg_advisory_unlock(lock_key);
          END;
          $fn$;`);

        await c.unsafe(`SET statement_timeout = '400ms'`);
        let errorCode: string | null = null;
        try {
          await c.unsafe(`SELECT public.hlc_lock_probe('${failure}')`);
        } catch (e) {
          errorCode = (e as { code?: string }).code ?? null;
        }
        // Clear the timeout so the bookkeeping read itself cannot be cancelled.
        await c.unsafe(`SET statement_timeout = 0`);
        const leakedLocks = Number(
          (
            await c.unsafe(
              `SELECT count(*)::int AS n FROM pg_locks
                 WHERE locktype = 'advisory' AND pid = pg_backend_pid()`,
            )
          )[0].n,
        );
        return { errorCode, leakedLocks };
      } finally {
        await c.end({ timeout: 5 });
      }
    }

    it('CALIBRATION — an ordinary error IS trapped, and the session lock is released', async () => {
      const { errorCode, leakedLocks } = await runProbe('divide_by_zero');
      expect(errorCode).toBe('22012'); // division_by_zero, raised on through the handler
      expect(leakedLocks).toBe(0); // the handler ran → no lock survives
    }, 60_000);

    it('HAZARD — `WHEN others` alone does NOT reach query_canceled, and the session lock LEAKS', async () => {
      const { errorCode, leakedLocks } = await runProbe('statement_timeout', 'others');
      expect(errorCode).toBe('57014'); // query_canceled — the timeout really fired
      // Postgres excludes QUERY_CANCELED (and ASSERT_FAILURE) from `OTHERS`, so
      // the unlock arm never runs. Measured, not recalled: this is exactly the
      // shape migration 813 shipped, and the leaked lock is permanent for that
      // backend — every later hlc_now() fleet-wide then blocks on it and fails
      // 55P03, i.e. the ORIGINAL symptom made permanent instead of transient.
      expect(leakedLocks).toBe(1);
    }, 60_000);

    it('FIX — naming query_canceled explicitly releases the lock on cancellation', async () => {
      const { errorCode, leakedLocks } = await runProbe('statement_timeout', 'others+canceled');
      expect(errorCode).toBe('57014'); // still cancelled — the fix must not swallow it
      expect(leakedLocks).toBe(0); // ...but the lock is now released on the way out
    }, 60_000);

    it('the SHIPPED harness_shared.hlc_now()/hlc_recv() use the safe handler', async () => {
      // Structural trip-wire: the behavioural probe above proves the IDIOM, but
      // the real function's protected block is far too fast to cancel on demand.
      // This pins the deployed functions to the idiom the probe validated, so a
      // future edit that drops the query_canceled arm fails here.
      const rows = await sql<{ proname: string; prosrc: string }[]>`
        SELECT p.proname, p.prosrc FROM pg_proc p
        JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'harness_shared' AND p.proname IN ('hlc_now', 'hlc_recv')`;
      expect(rows.map((r) => r.proname).sort()).toEqual(['hlc_now', 'hlc_recv']);
      for (const { proname, prosrc } of rows) {
        // Only functions that actually take the session lock need the arm.
        if (!prosrc.includes('pg_advisory_lock')) continue;
        expect(prosrc, `${proname} must trap query_canceled to release its session advisory lock`)
          .toContain('query_canceled');
      }
    }, 60_000);
  });
});
