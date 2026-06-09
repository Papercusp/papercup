/**
 * Integration test for the engineer_issues CUSTOM capture trigger (mig 197) — the
 * local-write → outbox leg of work-queue federation (fed-reanchor brief B5; closes
 * engineer-issues-2026-06-03 D-009). Real Postgres. Mirrors
 * hive-members-federation-trigger.integration.test.ts.
 *
 * engineer_issues = work_items[kind ∈ bug|change|task], and its federation SCOPE
 * lives in the `scope` column ('harness:<slug>' | 'operator'), not a harness_slug
 * column — so mig 197 uses a BESPOKE capture fn (capture_engineer_issues_outbox)
 * that DERIVES the federation slug from scope and STAMPS it into the outbox row as
 * harness_slug. This proves that derivation end-to-end:
 *   1. CAPTURE: a harness-scoped local INSERT enqueues one put SCOPED to <slug>; an
 *      operator-scoped INSERT resolves to the workspace's single Hive home (0/>1 →
 *      stays local); a remote-origin row enqueues nothing (echo guard); workspace '*'
 *      (SU meta) stays local; a federated-field UPDATE captures, a non-federated one
 *      (fed_ts) does NOT (amplification guard); a DELETE enqueues a del.
 *   2. RESHAPE: outboxRowToLocalWriteOp turns the row into an 'engineer-issues'
 *      LocalWriteOp carrying the federated subset (incl. the stamped harness_slug).
 *
 * Owns its schema (131 engineer_issues + 142 kind/seq + 152 task/payload + 184 hives
 * + 197 fed/trigger, over the archive outbox); does not touch the dev DB. Skips 159/178
 * (the work_items view + rank) — the capture trigger is on the BASE table, and the
 * federated subset deliberately excludes the per-bee rank.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { outboxRowToLocalWriteOp, type OutboxRow } from '../feature-issue-op-keys';
import { isEngineerIssueRow, type EngineerIssueRow } from '../projections/engineer-issues';

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

const WS = 'ws_ei';

interface OutboxDbRow {
  workspace_id: string;
  harness_slug: string;
  table_name: string;
  op: string;
  key: string;
  row: Record<string, unknown> | null;
  ts: number;
}

describe('engineer_issues federation capture trigger (real PG, mig 197)', () => {
  let db: FreshPgDb;

  beforeAll(async () => {
    db = await createFreshPgDb('engineer_issues_fed_trg');

    await db.sql.unsafe(`
      DO $r$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_app') THEN CREATE ROLE harness_app NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_admin') THEN CREATE ROLE harness_admin NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'harness_zero') THEN CREATE ROLE harness_zero NOLOGIN; END IF;
      END $r$;
    `);

    // Mig 102 (archive) attaches generic capture triggers to these consolidated
    // tables, so they must exist before it loads (column-faithful stubs).
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

    // outbox + generic capture fn (archive 102) → engineer_issues (131) + kind/seq
    // (142) + task/payload (152) → hives (184, for the operator-scope resolution) →
    // my fed col + custom trigger (197).
    await db.sql.unsafe(readFileSync(resolve(SQL_DIR, 'archive/102-substrate-outbox.sql'), 'utf8'));
    for (const m of [
      '131-engineer-issues.sql',
      '142-work-items-unify.sql',
      '152-delegate-task-workitems.sql',
      '184-hives-table.sql',
      '197-engineer-issues-federation.sql',
    ]) {
      await db.sql.unsafe(stripMeta(readFileSync(resolve(SQL_DIR, m), 'utf8')));
    }
  }, 60_000);

  afterAll(async () => {
    await db?.cleanup();
  });

  beforeEach(async () => {
    // Clear the SOURCE tables first — deleting engineer_issues fires the capture
    // trigger (a 'del' op) — then clear the outbox LAST so those dels don't linger.
    await db.sql`DELETE FROM harness_shared.engineer_issues`;
    await db.sql`DELETE FROM harness_shared.hives`;
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
  });

  async function outbox(): Promise<OutboxDbRow[]> {
    return db.sql<OutboxDbRow[]>`
      SELECT workspace_id, harness_slug, table_name, op, key, row, ts
        FROM harness_shared.substrate_outbox ORDER BY ts, key`;
  }
  async function countOutbox(): Promise<number> {
    const [r] = await db.sql<{ n: number }[]>`SELECT count(*)::int AS n FROM harness_shared.substrate_outbox`;
    return r.n;
  }
  let pkCounter = 0;
  async function seedHive(homeSlug: string) {
    // public_key is globally UNIQUE — give each seeded hive a distinct 32-byte key.
    const pk = Buffer.alloc(32);
    pk.writeUInt32BE(++pkCounter, 0);
    await db.sql`INSERT INTO harness_shared.hives (workspace_id, home_slug, public_key, keychain_id, created_at)
      VALUES (${WS}, ${homeSlug}, ${pk}, ${'kc-' + homeSlug}, 0)`;
  }
  async function insertIssue(over: { issue_id?: string; scope?: string; title?: string; origin?: string; workspace_id?: string } = {}) {
    await db.sql`INSERT INTO harness_shared.engineer_issues
      (workspace_id, issue_id, scope, title, origin)
      VALUES (${over.workspace_id ?? WS}, ${over.issue_id ?? 'EI-1'}, ${over.scope ?? 'operator'},
              ${over.title ?? 'a work item'}, ${over.origin ?? 'local'})`;
  }

  it('a harness-scoped local INSERT enqueues one put keyed by issue_id, scoped to <slug>; reshape builds an engineer-issues op', async () => {
    await insertIssue({ issue_id: 'EI-10', scope: 'harness:papercup', title: 'fix the thing' });
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].table_name).toBe('engineer_issues');
    expect(rows[0].op).toBe('put');
    expect(rows[0].key).toBe('EI-10'); // keyed by issue_id (TG_ARGV[0])
    expect(rows[0].workspace_id).toBe(WS);
    // THE derivation: the outbox scope is the harness slug from `scope`.
    expect(rows[0].harness_slug).toBe('papercup');
    // ...and stamped into the wire row so the projection can demux.
    expect(rows[0].row?.harness_slug).toBe('papercup');

    const op = outboxRowToLocalWriteOp(rows[0] as OutboxRow);
    expect(op.type).toBe('put');
    expect(op.table).toBe('engineer-issues');
    expect(op.hbKey).toBe('EI-10');
    if (op.type === 'put') {
      const v = op.value as EngineerIssueRow;
      expect(isEngineerIssueRow(v)).toBe(true);
      expect(v.harness_slug).toBe('papercup');
      expect(v.scope).toBe('harness:papercup');
      expect(v.issue_id).toBe('EI-10');
      expect(v.kind).toBe('bug'); // default
      expect(v.title).toBe('fix the thing');
    }
  });

  it('an operator-scope INSERT with NO Hive home stays local (0 outbox)', async () => {
    await insertIssue({ issue_id: 'EI-20', scope: 'operator' });
    expect(await countOutbox()).toBe(0);
  });

  it('an operator-scope INSERT with exactly ONE Hive home enqueues a put scoped to the Hive home', async () => {
    await seedHive('myhive');
    await insertIssue({ issue_id: 'EI-21', scope: 'operator', title: 'delegated task' });
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].harness_slug).toBe('myhive'); // resolved to the Hive home
    expect(rows[0].row?.harness_slug).toBe('myhive');
    expect(rows[0].row?.scope).toBe('operator'); // the row keeps its operator scope
  });

  it('an operator-scope INSERT with TWO Hive homes is ambiguous → stays local (0 outbox)', async () => {
    await seedHive('hive-a');
    await seedHive('hive-b');
    await insertIssue({ issue_id: 'EI-22', scope: 'operator' });
    expect(await countOutbox()).toBe(0);
  });

  it('a remote-origin row enqueues NOTHING (echo-loop guard)', async () => {
    await insertIssue({ issue_id: 'EI-30', scope: 'harness:papercup', origin: 'remote' });
    expect(await countOutbox()).toBe(0);
  });

  it("an SU cross-workspace row (workspace_id '*') stays local (0 outbox)", async () => {
    await insertIssue({ issue_id: 'EI-40', scope: 'harness:papercup', workspace_id: '*' });
    expect(await countOutbox()).toBe(0);
  });

  it('a federated-field UPDATE (state) enqueues a put', async () => {
    await insertIssue({ issue_id: 'EI-50', scope: 'harness:papercup' });
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`UPDATE harness_shared.engineer_issues SET state = 'resolved', origin = 'local'
      WHERE workspace_id = ${WS} AND issue_id = 'EI-50'`;
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe('put');
    expect(rows[0].harness_slug).toBe('papercup');
  });

  it('a non-federated-field UPDATE (fed_ts) does NOT capture (amplification guard)', async () => {
    await insertIssue({ issue_id: 'EI-60', scope: 'harness:papercup' });
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`UPDATE harness_shared.engineer_issues SET fed_ts = 123456
      WHERE workspace_id = ${WS} AND issue_id = 'EI-60'`;
    expect(await countOutbox()).toBe(0);
  });

  it('a DELETE enqueues a del keyed by issue_id', async () => {
    await insertIssue({ issue_id: 'EI-70', scope: 'harness:papercup' });
    await db.sql`DELETE FROM harness_shared.substrate_outbox`;
    await db.sql`DELETE FROM harness_shared.engineer_issues WHERE workspace_id = ${WS} AND issue_id = 'EI-70'`;
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0].op).toBe('del');
    expect(rows[0].key).toBe('EI-70');
    expect(rows[0].harness_slug).toBe('papercup');
  });
});
