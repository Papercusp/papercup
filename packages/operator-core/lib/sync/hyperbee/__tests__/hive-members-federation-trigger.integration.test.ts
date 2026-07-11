/**
 * Integration test for the pot_members (nee pot_members) CUSTOM capture trigger
 * (mig 189, column-renamed by mig 557 Phase 3, function body fixed by mig 565 —
 * cup-lexicon-full-rename-2026-07-09 P-011) — the local-write → outbox leg of
 * multi-Swarm admission federation (shared-hive-federation-2026-06-08 P-006). Real
 * Postgres. Mirrors plan-item-assignment-federation-trigger.integration.test.ts.
 *
 * pot_members' scope column is `pot_home_slug` (not `harness_slug`), so mig 189
 * uses a BESPOKE capture fn (capture_pot_members_outbox — name unchanged by 557,
 * only the table/column it targets renamed) that sets outbox.harness_slug :=
 * NEW.pot_home_slug. This proves that bridge end-to-end:
 *   1. CAPTURE: a local INSERT enqueues one put keyed by github_user_id, SCOPED to
 *      pot_home_slug; a remote-origin row enqueues nothing (echo-loop guard); a
 *      revoked_pubkeys UPDATE captures; a non-federated UPDATE (last_seen_at) does
 *      NOT (amplification guard); a DELETE enqueues a del.
 *   2. RESHAPE: outboxRowToLocalWriteOp turns the row into a 'hive-members'
 *      LocalWriteOp carrying the federated subset (wire/projection TAG, kept as-is
 *      across the rename — see feature-issue-op-keys.ts's TABLE_NAME_TO_TABLE_TAG).
 *
 * Owns its schema (184 hives→pots + 185 pot_members→pot_members + 189 fed/trigger
 * + 557's rename DDL + the archive outbox); does not touch the dev DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { outboxRowToLocalWriteOp, type OutboxRow } from '../feature-issue-op-keys';
import type { HiveMemberRow } from '../projections/hive-members';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(HERE, '../../../../../../libs/papercusp/libs/db/sql');

function stripMeta(sql: string): string {
  return sql
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      if (t.startsWith('\\')) return false;
      if (/^(begin|commit);$/i.test(t)) return false;
      return true;
    })
    .join('\n');
}

const WS = 'ws_hm';
const HIVE = 'acme-hive';
const UID = 12345;

interface OutboxDbRow {
  workspace_id: string;
  harness_slug: string;
  table_name: string;
  op: string;
  key: string;
  row: Record<string, unknown> | null;
  ts: number;
}

describe('pot_members federation capture trigger (real PG, mig 189)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('pot_members_fed_trg');

    await db.sql.unsafe(`
      DO $r$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
      END $r$;
    `);

    // Mig 102 attaches generic capture triggers to these consolidated tables, so
    // they must exist before it loads (column-faithful stubs, like the sibling test).
    await db.sql.unsafe(`
      CREATE TABLE harness_shared.harness_features_consolidated (
        workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
        feature_id TEXT NOT NULL, author_pubkey TEXT,
        origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, feature_id)
      );
      CREATE TABLE harness_shared.harness_issues_consolidated (
        workspace_id TEXT NOT NULL DEFAULT '', harness_slug TEXT NOT NULL,
        issue_id TEXT NOT NULL, author_pubkey TEXT,
        origin TEXT NOT NULL DEFAULT 'local', PRIMARY KEY (harness_slug, issue_id)
      );
    `);

    // The outbox table + generic capture fn (archive 102), then the Hive schema
    // (184 hives → 185 pot_members FK→hives) + my fed cols + the custom trigger (189).
    await db.sql.unsafe(readFileSync(resolve(SQL_DIR, 'archive/102-substrate-outbox.sql'), 'utf8'));
    await db.sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '184-hives-table.sql'), 'utf8')));
    await db.sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '185-hive-members-admission.sql'), 'utf8')));
    await db.sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '189-hive-members-federation-cols.sql'), 'utf8')));
    // Replay the Phase-3 rename (mig 557, idempotent/existence-guarded per-block so
    // it's safe against this narrow schema): hives/pot_members → pots/pot_members,
    // pot_home_slug → pot_home_slug.
    await db.sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '557-cup-lexicon-db-rename-phase3.sql'), 'utf8')));

    // 557 renames the TABLE/COLUMN but (correctly) does not touch the function BODY —
    // that's mig 565's job on the real dev DB. But 565 replaces the function with the
    // mig-477 shape (op_hlc/fed_hlc), which needs infra this deliberately-narrow schema
    // never replays (mig 314's op_hlc column etc.). So patch the ORIGINAL mig-189 (simple)
    // shape in place with the one renamed column, matching what THIS schema can support —
    // the live/prod fix is covered separately by outbox-drain-rekey / feature-issue-op-keys
    // unit coverage, not this test.
    await db.sql.unsafe(`
      CREATE OR REPLACE FUNCTION harness_shared.capture_pot_members_outbox() RETURNS trigger
          LANGUAGE plpgsql AS $fn$
          DECLARE
            v_op      TEXT;
            v_rec     RECORD;
            v_origin  TEXT;
            v_key     TEXT;
            v_row     JSONB;
            v_ws      TEXT;
            v_slug    TEXT;
            v_keycol  TEXT := TG_ARGV[0];
          BEGIN
            IF (TG_OP = 'DELETE') THEN
              v_op := 'del';
              v_rec := OLD;
            ELSE
              v_op := 'put';
              v_rec := NEW;
            END IF;

            v_row := to_jsonb(v_rec);
            v_origin := v_row ->> 'origin';

            IF COALESCE(v_origin, 'local') <> 'local' THEN
              RETURN v_rec;
            END IF;

            v_key  := v_row ->> v_keycol;
            v_ws   := COALESCE(v_row ->> 'workspace_id', '');
            v_slug := v_row ->> 'pot_home_slug';  -- renamed from pot_home_slug by mig 557

            INSERT INTO harness_shared.substrate_outbox
              (workspace_id, harness_slug, table_name, op, key, row, ts)
            VALUES
              (v_ws, v_slug, TG_TABLE_NAME, v_op, v_key, v_row,
               (extract(epoch from now()) * 1000)::bigint);

            PERFORM pg_notify('substrate_outbox', v_ws || '::' || v_slug);

            RETURN v_rec;
          END;
          $fn$;
    `);

    // FK parent: the Pot identity row (public_key is bytea NOT NULL).
    await db.sql`INSERT INTO harness_shared.pots (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
      VALUES (${WS}, ${HIVE}, ${Buffer.from([0])}, 'kc-test', 0)`;
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  async function countOutbox(): Promise<number> {
    const [r] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.substrate_outbox`;
    return r.n;
  }

  it('a local-origin member INSERT enqueues one put keyed by github_user_id, scoped to pot_home_slug', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`INSERT INTO harness_shared.pot_members
      (workspace_id, pot_home_slug, github_user_id, github_username)
      VALUES (${WS}, ${HIVE}, ${UID}, 'alice')`;
    const rows = await db.sql<OutboxDbRow[]>`
      SELECT workspace_id, harness_slug, table_name, op, key, row, ts FROM harness_shared.substrate_outbox`;
    expect(rows).toHaveLength(1);
    expect(rows[0].table_name).toBe('pot_members');
    expect(rows[0].op).toBe('put');
    expect(rows[0].key).toBe(String(UID)); // keyed by github_user_id (TG_ARGV[0])
    // THE custom bridge: the outbox scope is the Hive home slug, NOT a harness_slug col.
    expect(rows[0].harness_slug).toBe(HIVE);
    expect(rows[0].workspace_id).toBe(WS);
  });

  it('a remote-origin member row enqueues NOTHING (echo-loop guard)', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`INSERT INTO harness_shared.pot_members
      (workspace_id, pot_home_slug, github_user_id, github_username, origin)
      VALUES (${WS}, ${HIVE}, 777, 'peer', 'remote')`;
    expect(await countOutbox()).toBe(0);
  });

  it('a revoked_pubkeys UPDATE enqueues a put; reshape builds a hive-members op', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`UPDATE harness_shared.pot_members
      SET revoked_pubkeys = ARRAY['ed25519:bad']
      WHERE workspace_id = ${WS} AND pot_home_slug = ${HIVE} AND github_user_id = ${UID}`;
    const rows = await db.sql<OutboxDbRow[]>`
      SELECT workspace_id, harness_slug, table_name, op, key, row, ts FROM harness_shared.substrate_outbox`;
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe('put');

    const op = outboxRowToLocalWriteOp({
      table_name: rows[0].table_name,
      op: rows[0].op as 'put',
      key: rows[0].key,
      ts: rows[0].ts,
      row: rows[0].row,
    } as OutboxRow);
    expect(op.type).toBe('put');
    expect(op.table).toBe('hive-members');
    expect(op.hbKey).toBe(String(UID));
    if (op.type === 'put') {
      const v = op.value as HiveMemberRow;
      expect(v.pot_home_slug).toBe(HIVE);
      expect(v.github_user_id).toBe(UID);
      expect(v.revoked_pubkeys).toEqual(['ed25519:bad']);
    }
  });

  it('a non-federated-field UPDATE (last_seen_at) does NOT capture (amplification guard)', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`UPDATE harness_shared.pot_members
      SET last_seen_at = now()
      WHERE workspace_id = ${WS} AND pot_home_slug = ${HIVE} AND github_user_id = ${UID}`;
    expect(await countOutbox()).toBe(0);
  });

  it('a member DELETE enqueues a del keyed by github_user_id', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`DELETE FROM harness_shared.pot_members
      WHERE workspace_id = ${WS} AND pot_home_slug = ${HIVE} AND github_user_id = ${UID}`;
    const rows = await db.sql<OutboxDbRow[]>`SELECT op, key FROM harness_shared.substrate_outbox`;
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe('del');
    expect(rows[0].key).toBe(String(UID));
  });
});
