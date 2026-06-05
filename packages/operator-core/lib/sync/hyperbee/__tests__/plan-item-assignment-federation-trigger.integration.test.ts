/**
 * Integration test for the plan_item_assignments CAPTURE trigger (the local-write →
 * outbox leg of federation; plan-item-assignment-claim-liveness-2026-06-04 D-002).
 * Real Postgres. Mirrors the coord_conversations federation test.
 *
 * Proves:
 *   1. CAPTURE: a local-origin assignment insert/update enqueues exactly one
 *      substrate_outbox row keyed by the generated fed_key ('<plan_slug>:<item_id>');
 *      a remote-origin (projected) row enqueues NOTHING (echo-loop guard); a DELETE
 *      enqueues a del.
 *   2. RESHAPE: outboxRowToLocalWriteOp turns that outbox row into an
 *      'item-assignments' LocalWriteOp carrying the federated subset.
 *
 * Owns its schema (mig 140 + the real archive/102 outbox/capture fn + mig 145);
 * does not touch the dev DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { outboxRowToLocalWriteOp, type OutboxRow } from '../feature-issue-op-keys';
import type { PlanItemAssignmentRow } from '../projections/plan-item-assignments';

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

const WS = 'ws_pia';
const HARNESS = 'fed';

interface OutboxDbRow {
  workspace_id: string;
  harness_slug: string;
  table_name: string;
  op: string;
  key: string;
  row: Record<string, unknown> | null;
  ts: number;
}

describe('plan_item_assignments federation capture (real PG)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('pia_fed_trg');

    await db.sql.unsafe(`
      DO $r$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
      END $r$;
    `);

    // Migration 102 attaches capture triggers to these two consolidated tables, so
    // they must exist first. Minimal column-faithful stubs (the trigger only reads
    // origin / workspace_id / harness_slug + the key column).
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

    // The real outbox table + capture_substrate_outbox function (archive mig 102),
    // then my table (140) + my capture triggers (145).
    await db.sql.unsafe(readFileSync(resolve(SQL_DIR, 'archive/102-substrate-outbox.sql'), 'utf8'));
    await db.sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '140-plan-item-assignments.sql'), 'utf8')));
    await db.sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, '145-plan-item-assignments-federation.sql'), 'utf8')));
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  async function countOutbox(): Promise<number> {
    const [r] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.substrate_outbox`;
    return r.n;
  }

  it('a local-origin assignment insert enqueues one put keyed by fed_key', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`
      INSERT INTO harness_shared.plan_item_assignments
        (workspace_id, harness_slug, plan_slug, item_id, assignee_name, assigned_by_user, assigned_ts)
      VALUES (${WS}, ${HARNESS}, 'demo-plan', 'P-001', 'builder-1', 'user-x', now())`;
    const rows = await db.sql<OutboxDbRow[]>`
      SELECT workspace_id, harness_slug, table_name, op, key, row, ts FROM harness_shared.substrate_outbox`;
    expect(rows).toHaveLength(1);
    expect(rows[0].table_name).toBe('plan_item_assignments');
    expect(rows[0].op).toBe('put');
    expect(rows[0].key).toBe('demo-plan:P-001'); // the generated fed_key
    expect(rows[0].harness_slug).toBe(HARNESS);
  });

  it('a remote-origin row enqueues NOTHING (echo-loop guard)', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`
      INSERT INTO harness_shared.plan_item_assignments
        (workspace_id, harness_slug, plan_slug, item_id, assignee_name, assigned_by_user, assigned_ts, origin)
      VALUES (${WS}, ${HARNESS}, 'demo-plan', 'P-002', 'peer-name', 'peer-user', now(), 'remote')`;
    expect(await countOutbox()).toBe(0);
  });

  it('a federated-field UPDATE enqueues another put; reshape builds an item-assignments op', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`UPDATE harness_shared.plan_item_assignments
       SET assignee_name = 'builder-2'
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = 'demo-plan' AND item_id = 'P-001'`;
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
    expect(op.table).toBe('item-assignments');
    expect(op.hbKey).toBe('demo-plan:P-001');
    if (op.type === 'put') {
      const v = op.value as PlanItemAssignmentRow;
      expect(v.assignee_name).toBe('builder-2');
      expect(v.harness_slug).toBe(HARNESS);
    }
  });

  it('an updated_at-only bump does NOT capture (amplification guard)', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    // Touch only a non-federated field path: a no-op UPDATE of assignee_name to its
    // current value is DISTINCT-FROM-false → the WHEN guard skips it.
    await db.sql`UPDATE harness_shared.plan_item_assignments
       SET assignee_name = assignee_name
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = 'demo-plan' AND item_id = 'P-001'`;
    expect(await countOutbox()).toBe(0);
  });

  it('a DELETE enqueues a del keyed by fed_key', async () => {
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`DELETE FROM harness_shared.plan_item_assignments
     WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = 'demo-plan' AND item_id = 'P-001'`;
    const rows = await db.sql<OutboxDbRow[]>`SELECT op, key FROM harness_shared.substrate_outbox`;
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe('del');
    expect(rows[0].key).toBe('demo-plan:P-001');
  });
});
