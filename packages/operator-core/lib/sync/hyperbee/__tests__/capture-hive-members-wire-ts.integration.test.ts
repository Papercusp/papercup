/**
 * capture-hive-members-wire-ts.integration.test.ts — mig 477.
 *
 * The third `substrate_outbox` capture function, `capture_pot_members_outbox`
 * (mig 189, the bespoke per-Hive admission/revocation capture), was the sole live
 * enqueue path that threaded NEITHER the row's `fed_ts` NOR any `op_hlc` onto the
 * wire op — it stamped `ts = now()` (txn start) and omitted `op_hlc`, so the drain
 * re-derived a fallback HLC from its OWN process clock and the receiver persisted an
 * inflated `fed_ts/fed_hlc` as the member row's provenance. That is the exact
 * mig-446 bug class (fixed there for the generic + work-items captures, which
 * mig-446's header claimed were the only TWO carrying it), on a third table —
 * `pot_members` — where an inflated ordering key can let a stale admission/
 * revocation op win LWW over a newer one.
 *
 * Mig 477 gives this capture the same one-clock treatment as mig 446: a put on a
 * stamped row threads the ROW's fed_ts + fed_hlc; a del keeps a fresh
 * hlc_now()+now() (its own causal event). This test drives the REAL triggers on a
 * REAL fully-migrated Postgres and asserts the invariant at the capture boundary:
 * the put wire ts/op_hlc are byte-identical to the row's stored fed_ts/fed_hlc.
 *
 * pot_members is confirmed to be in the mig-314 stamp regime by the INSERT case
 * itself (fed_ts/fed_hlc come back non-null after a bare local insert).
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

const WS = 'ws-hm-wire-ts';
const HIVE = 'hive-hm-wire-ts'; // pot_members.pot_home_slug (the outbox scope)
const UID = 424242; // github_user_id — the outbox key (TG_ARGV[0])

let db: MigratedTestDb;
let sql: postgres.Sql;

beforeAll(async () => {
  db = await createFreshTestDb({
    prefix: 'hmwts',
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

  // FK parent: the Hive identity row (public_key is bytea NOT NULL).
  await sql`INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${HIVE}, ${Buffer.from([0])}, 'kc-hm-wts', 0)`;
}, 180_000);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await db?.drop();
});

async function memberRow(): Promise<{ fed_ts: string; fed_hlc: string } | null> {
  const rows = await sql<{ fed_ts: string; fed_hlc: string }[]>`
    SELECT fed_ts, fed_hlc FROM harness_shared.pot_members
    WHERE workspace_id = ${WS} AND pot_home_slug = ${HIVE} AND github_user_id = ${UID}`;
  return rows.length ? rows[0] : null;
}

async function outboxOps(): Promise<{ op: string; ts: string; op_hlc: string | null }[]> {
  return sql<{ op: string; ts: string; op_hlc: string | null }[]>`
    SELECT op, ts, op_hlc FROM harness_shared.substrate_outbox
    WHERE table_name = 'pot_members' AND key = ${String(UID)} ORDER BY id`;
}

describe('mig 477 — capture_pot_members_outbox stamps the put-op wire ts/op_hlc from the ROW', () => {
  it('local INSERT: the captured op carries ts == the stamped fed_ts and op_hlc == fed_hlc, byte-identical', async () => {
    // No fed_ts/fed_hlc/origin supplied → the mig-314 BEFORE trigger stamps both
    // (which also proves pot_members is in the stamp regime).
    await sql`
      INSERT INTO harness_shared.pot_members
        (workspace_id, pot_home_slug, github_user_id, github_username)
      VALUES (${WS}, ${HIVE}, ${UID}, 'alice')`;
    const row = await memberRow();
    expect(row?.fed_ts).toBeTruthy();
    expect(row?.fed_hlc).toBeTruthy();

    const ops = await outboxOps();
    expect(ops).toHaveLength(1);
    expect(ops[0].op).toBe('put');
    // THE invariant: the wire ts/op_hlc are the row's stamp — not a second clock
    // read. Pre-477 the ts was now() (txn start) and op_hlc was NULL (drain-clock
    // fallback), permanently diverging author-vs-receiver ordering key.
    expect(ops[0].ts).toBe(row!.fed_ts);
    expect(ops[0].op_hlc).toBe(row!.fed_hlc);
  });

  it('local UPDATE (revoked_pubkeys — a federated content change): the 2nd put carries the CURRENT row stamp', async () => {
    const before = await memberRow();
    await sql`
      UPDATE harness_shared.pot_members
      SET revoked_pubkeys = ARRAY['ed25519:bad']
      WHERE workspace_id = ${WS} AND pot_home_slug = ${HIVE} AND github_user_id = ${UID}`;
    const after = await memberRow();
    // The stamp is monotonic (a re-stamp advances it; no re-stamp leaves it equal) —
    // never goes backwards.
    expect(after!.fed_ts >= before!.fed_ts).toBe(true);
    expect(after!.fed_hlc >= before!.fed_hlc).toBe(true);

    const ops = await outboxOps();
    expect(ops).toHaveLength(2);
    expect(ops[1].op).toBe('put');
    // The regression invariant, again: wire ts/op_hlc == the row's current stamp.
    expect(ops[1].ts).toBe(after!.fed_ts);
    expect(ops[1].op_hlc).toBe(after!.fed_hlc);
  });

  it('DELETE: the del op keeps a fresh capture-time ts + hlc_now() (its own event — NOT the stale row stamp)', async () => {
    const row = await memberRow();
    await sql`
      DELETE FROM harness_shared.pot_members
      WHERE workspace_id = ${WS} AND pot_home_slug = ${HIVE} AND github_user_id = ${UID}`;

    const ops = await outboxOps();
    expect(ops).toHaveLength(3);
    expect(ops[2].op).toBe('del');
    // A del is causally-after the row's last state; its wire ts must not be the
    // row's (older) put stamp, and its op_hlc is a fresh hlc_now() above the row's.
    expect(Number(ops[2].ts)).toBeGreaterThanOrEqual(Number(row!.fed_ts));
    expect(ops[2].op_hlc! > row!.fed_hlc).toBe(true);
  });
});
