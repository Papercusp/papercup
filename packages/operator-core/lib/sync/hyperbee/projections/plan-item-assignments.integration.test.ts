/**
 * plan-item-assignments.integration.test.ts — the FEDERATION round-trip for the
 * plan-item ASSIGNMENT record (plan-item-assignment-claim-liveness-2026-06-04 D-002).
 *
 * Single-process leg of Phase-4 verification: a local write → captured outbox row →
 * `outboxRowToLocalWriteOp` (the drain mapping) → `decodeValue` + `writeToPg` (the
 * peer's projection apply), exactly the path the existing features/issues/plans
 * federation tests cover. The real two-PEER (two-VM) leg + the authority-failover
 * leg are the documented seams (VM rig + a peer-RPC transport — neither exists yet).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFreshPgDb, type FreshPgDb } from '../../../../test/_pg-helpers';
import { outboxRowToLocalWriteOp, type OutboxRow } from '../feature-issue-op-keys';
import {
  buildPlanItemAssignmentsProjection,
  composeAssignmentKey,
  _testing,
  type PlanItemAssignmentRow,
} from './plan-item-assignments';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SQL_DIR = resolve(__dirname, '../../../../../../libs/papercusp/libs/db/sql');
const readMigration = (f: string) =>
  readFileSync(resolve(SQL_DIR, f), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*\\/.test(l) && !/\bGRANT\b/.test(l) && !/^\s*(BEGIN|COMMIT);\s*$/.test(l))
    .join('\n');

const WS = 'default';
const HARNESS = 'papercup';

/** A `to_jsonb`-shaped outbox row for an assignment put (ISO timestamps + fed_key). */
function outboxPut(overrides: Partial<Record<string, unknown>> = {}): OutboxRow {
  const row = {
    workspace_id: WS,
    harness_slug: HARNESS,
    plan_slug: 'demo-plan',
    item_id: 'P-001',
    assignee_name: 'builder-1',
    assigned_by_user: 'user-x',
    assigned_ts: '2026-06-04T21:00:00.000Z',
    released_ts: null,
    strategy: null,
    note: null,
    fed_key: 'demo-plan:P-001',
    origin: 'local',
    ...overrides,
  };
  return { table_name: 'plan_item_assignments', op: 'put', key: 'demo-plan:P-001', ts: 1_700_000_000_000, row };
}

let db: FreshPgDb;

beforeAll(async () => {
  db = await createFreshPgDb('pi-fed');
  await db.sql.unsafe(readMigration('140-plan-item-assignments.sql')).simple();
  // EI-79 step 2 (mig 181): the PG-level LWW guard column the writer stamps.
  await db.sql.unsafe(`ALTER TABLE harness_shared.plan_item_assignments ADD COLUMN IF NOT EXISTS fed_ts BIGINT`);
}, 90_000);

afterAll(async () => {
  await db.cleanup();
});

beforeEach(async () => {
  await db.sql`TRUNCATE harness_shared.plan_item_assignments`;
});

describe('drain mapping (outboxRowToLocalWriteOp)', () => {
  it('maps a plan_item_assignments put to tableTag "item-assignments" with the fed_key', () => {
    const op = outboxRowToLocalWriteOp(outboxPut());
    expect(op.type).toBe('put');
    expect(op.table).toBe('item-assignments');
    expect(op.hbKey).toBe('demo-plan:P-001');
    expect(op.hbKey).toBe(composeAssignmentKey('demo-plan', 'P-001'));
    if (op.type === 'put') {
      const v = op.value as PlanItemAssignmentRow;
      expect(v.assignee_name).toBe('builder-1');
      expect(v.assigned_ts).toBe('2026-06-04T21:00:00.000Z');
    }
  });

  it('maps a del to a del op carrying only the key', () => {
    const op = outboxRowToLocalWriteOp({ table_name: 'plan_item_assignments', op: 'del', key: 'demo-plan:P-001', ts: 1, row: null });
    expect(op.type).toBe('del');
    expect(op.hbKey).toBe('demo-plan:P-001');
  });
});

describe('projection apply (peer side)', () => {
  // Apply a captured put through the full drain→projection path, as a peer would.
  async function applyPut(overrides: Partial<Record<string, unknown>> = {}, authorPubkey = 'peerA'): Promise<void> {
    const proj = buildPlanItemAssignmentsProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql });
    const op = outboxRowToLocalWriteOp(outboxPut(overrides));
    const decoded = proj.decodeValue(op.type === 'put' ? op.value : null);
    expect(decoded).not.toBeNull();
    await proj.writeToPg(decoded!, { origin: 'remote', authorPubkey });
  }

  it('a remote put lands in the peer\'s PG stamped origin="remote" (echo-guard prevents re-capture)', async () => {
    await applyPut();

    const rows = await db.sql`
      SELECT assignee_name, assigned_by_user, origin, author_pubkey, released_ts, fed_key
        FROM harness_shared.plan_item_assignments
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS} AND plan_slug = 'demo-plan' AND item_id = 'P-001'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assignee_name).toBe('builder-1');
    expect(rows[0]!.origin).toBe('remote'); // a remote apply is stamped 'remote' → the capture trigger will skip it
    expect(rows[0]!.author_pubkey).toBe('peerA');
    expect(rows[0]!.fed_key).toBe('demo-plan:P-001'); // generated column matches the wire key
  });

  it('a later assignment wins (LWW): re-apply with a new assignee updates the row', async () => {
    await applyPut({}, 'peerA');
    await applyPut({ assignee_name: 'builder-2' }, 'peerB');
    const rows = await db.sql`SELECT assignee_name FROM harness_shared.plan_item_assignments WHERE plan_slug='demo-plan' AND item_id='P-001'`;
    expect(rows[0]!.assignee_name).toBe('builder-2');
  });

  it('a released assignment federates as a put with released_ts set (soft-release)', async () => {
    await applyPut({ released_ts: '2026-06-04T22:00:00.000Z' });
    const rows = await db.sql`SELECT released_ts FROM harness_shared.plan_item_assignments WHERE plan_slug='demo-plan' AND item_id='P-001'`;
    expect(rows[0]!.released_ts).not.toBeNull();
  });

  it('deleteFromPg removes the row by the composite fed_key', async () => {
    const proj = buildPlanItemAssignmentsProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql });
    await applyPut();
    await proj.deleteFromPg('demo-plan:P-001');
    const rows = await db.sql`SELECT 1 FROM harness_shared.plan_item_assignments WHERE plan_slug='demo-plan' AND item_id='P-001'`;
    expect(rows).toHaveLength(0);
  });

  it('decodeValue rejects a malformed wire row', () => {
    expect(_testing.decodeValue({})).toBeNull();
    expect(_testing.decodeValue({ harness_slug: 'h', plan_slug: 'p', item_id: 'P-1', assignee_name: 42 })).toBeNull();
  });
});
