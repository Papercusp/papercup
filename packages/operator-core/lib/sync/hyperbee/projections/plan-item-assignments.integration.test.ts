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
  await db.sql.unsafe(`ALTER TABLE harness_shared.plan_item_assignments ADD COLUMN IF NOT EXISTS fed_hlc TEXT`);
  // WI-971-followup: this table is also a REAL carrier of `stamp_local_federated_write_trg`
  // (mig 214 attached it to plan_item_assignments; mig 653 is the live function body) — but
  // that trigger lives in ~11 OTHER tables' migration files too, most of which this minimal
  // fixture doesn't create, so we can't just `readMigration('214-...')`'s DO-block (it would
  // 42P01 on e.g. harness_plans). Attach the CURRENT (mig 653) function body verbatim to JUST
  // this table, mirroring engineer-issues.integration.test.ts's identical stub-and-attach
  // pattern for work_items, so this test exercises the real prod trigger stack.
  await db.sql.unsafe(`
    CREATE OR REPLACE FUNCTION harness_shared.hlc_now() RETURNS text
      LANGUAGE sql AS $hlc_stub$
        SELECT (extract(epoch FROM clock_timestamp()) * 1000)::bigint::text || ':stub';
      $hlc_stub$;

    CREATE OR REPLACE FUNCTION harness_shared.stamp_local_federated_write() RETURNS trigger
        LANGUAGE plpgsql
        AS $fn$
    BEGIN
      IF TG_OP = 'UPDATE' AND NEW.fed_ts IS DISTINCT FROM OLD.fed_ts THEN
        RETURN NEW;
      END IF;
      IF TG_OP = 'INSERT' THEN
        IF NEW.fed_ts IS NULL AND COALESCE(NEW.origin, 'local') = 'local' THEN
          NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
        END IF;
        RETURN NEW;
      END IF;
      -- mig 653: exclude fed_key (this table's GENERATED ALWAYS ... STORED key) --
      -- NEW.fed_key reads NULL pre-generation inside a BEFORE trigger while OLD.fed_key
      -- is already populated, so omitting it here spuriously flip-flops on every UPDATE.
      IF (to_jsonb(NEW) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition' - 'fed_key')
         IS DISTINCT FROM
         (to_jsonb(OLD) - 'fed_ts' - 'fed_hlc' - 'origin' - 'author_pubkey' - 'updated_at' - '_search' - 'version' - 'local_disposition' - 'fed_key')
      THEN
        NEW.fed_ts := (extract(epoch FROM clock_timestamp()) * 1000)::bigint;
        NEW.fed_hlc := harness_shared.hlc_now();
        NEW.origin := 'local';
      END IF;
      RETURN NEW;
    END;
    $fn$;

    DROP TRIGGER IF EXISTS stamp_local_federated_write_trg ON harness_shared.plan_item_assignments;
    CREATE TRIGGER stamp_local_federated_write_trg
      BEFORE INSERT OR UPDATE ON harness_shared.plan_item_assignments
      FOR EACH ROW EXECUTE FUNCTION harness_shared.stamp_local_federated_write();
  `);
}, 90_000);

afterAll(async () => {
  await db?.cleanup();
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

  // WI-971-followup (live gate 2026-07-20 13:40:25 run — backfill + incr-A→B both showed
  // src outbox=0/N drained-but-never-crossed for item-assignments while the other 9 CDC
  // types passed): direct DB inspection of the live two-peer rig found the peer's row DID
  // exist with correct content + a real author_pubkey/fed_ts, but `origin='local'` instead
  // of 'remote' — so the smoke's `WHERE origin='remote'` poll never matched. Root cause:
  // unlike engineer-issues/work_items (mig 517 fixed this exact class for THAT table),
  // plan_item_assignments still carries mig-214's ORIGINAL `stamp_local_federated_write_trg`
  // behavior — a same-op re-fold whose fed_ts is byte-identical to OLD is (correctly) treated
  // as "not a fresh projection apply", falls into the local-write branch, and — because this
  // table ALSO has its own unconditional `plan_item_assignments_updated_at_trg` (mig 140)
  // touching `updated_at` on every UPDATE, and `updated_at` IS masked out — should be a no-op
  // for byte-identical content. This test proves whether it actually is.
  it('WI-971-followup: a same-op double-apply (identical remote op re-folded) does NOT flip origin/fed_ts', async () => {
    const proj = buildPlanItemAssignmentsProjection({ workspaceId: WS, harnessSlug: HARNESS, sql: db.sql });
    const op = outboxRowToLocalWriteOp(outboxPut());
    const decoded = proj.decodeValue(op.type === 'put' ? op.value : null)!;
    const provenance = { ts: 500, fedHlc: '500:00000:peer', origin: 'remote' as const, authorPubkey: 'peerA' };

    await proj.writeToPg(decoded, provenance);
    const first = await db.sql`SELECT origin, fed_ts FROM harness_shared.plan_item_assignments WHERE plan_slug='demo-plan' AND item_id='P-001'`;
    expect(first[0]!.origin).toBe('remote');
    expect(Number(first[0]!.fed_ts)).toBe(500);

    // Re-fold the IDENTICAL op a second time (a retry / backfill re-scan re-applying the
    // same wire op) — must be a no-op on origin/fed_ts.
    await proj.writeToPg(decoded, provenance);
    const second = await db.sql`SELECT origin, fed_ts FROM harness_shared.plan_item_assignments WHERE plan_slug='demo-plan' AND item_id='P-001'`;
    expect(second[0]!.origin).toBe('remote'); // must NOT flip to 'local'
    expect(Number(second[0]!.fed_ts)).toBe(500); // must NOT advance
  });
});
