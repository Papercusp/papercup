/**
 * assignments.integration.test.ts — the plan-item assignment store
 * (plan_item_assignments, migration 140), against a real Postgres.
 *
 * getOrgPg() and readPlanBySlug are mocked (the store reads the org/admin handle
 * and validates item existence against the plan); the table is FAITHFUL to mig 140
 * (generated fed_key + the updated_at BEFORE-UPDATE trigger).
 *
 * Behaviors a fake-sql unit test can't prove:
 *  - assignItem VALIDATES the item exists in the plan — a typo'd P-NNN throws and
 *    inserts nothing (TEETHED here); skipItemCheck bypasses for federated inserts;
 *  - re-assign is LWW via ON CONFLICT DO UPDATE — one row, new assignee, released_ts
 *    re-nulled;
 *  - unassign is a SOFT release (released_ts set, row kept) and the active reads
 *    (getAssignment/listFor*) are scoped to released_ts IS NULL;
 *  - unassign on an already-released item is a no-op (the released_ts IS NULL guard).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import { randomBytes } from 'node:crypto';
import { getTestPg } from '@papercusp/test-config';

const h = vi.hoisted(() => ({ sql: undefined as unknown as postgres.Sql, planItems: [{ id: 'P-001' }, { id: 'P-002' }] as { id: string }[] }));
vi.mock('@papercusp/db-org', async () => {
  const actual = await vi.importActual<typeof import('@papercusp/db-org')>('@papercusp/db-org');
  return { ...actual, getOrgPg: () => ({ sql: h.sql }) };
});
vi.mock('../agent-tools/plans/source', () => ({
  // a plan whose Stage-3 items are h.planItems (parsed empty → forces the row.items path)
  readPlanBySlug: async () => ({ row: { items: h.planItems }, parsed: { items: [] } }),
}));

const { assignItem, unassignItem, getAssignment, listAssignmentsForName, listAssignmentsForPlan } = await import('./assignments');

const WS = 'ws-pia';
let rootSql: postgres.Sql;
const base = { workspaceId: WS, harnessSlug: 'web', planSlug: 'plan-a', assignedByUser: 'user1' };

beforeAll(async () => {
  const adminUri = await getTestPg();
  const dbName = `pia_${randomBytes(5).toString('hex')}`;
  const admin = postgres(adminUri, { max: 1, onnotice: () => {} });
  try {
    await admin.unsafe(`CREATE DATABASE "${dbName}"`);
  } finally {
    await admin.end({ timeout: 5 });
  }
  const u = new URL(adminUri);
  u.pathname = `/${dbName}`;
  rootSql = postgres(u.toString(), { max: 2, onnotice: () => {} });
  await rootSql.unsafe(`CREATE SCHEMA harness_shared`);
  // FAITHFUL to migration 140 (generated fed_key + the updated_at trigger).
  await rootSql.unsafe(`
    CREATE TABLE harness_shared.plan_item_assignments (
      workspace_id text NOT NULL, harness_slug text NOT NULL, plan_slug text NOT NULL, item_id text NOT NULL,
      assignee_name text, assigned_by_user text, assigned_ts timestamptz, released_ts timestamptz,
      strategy text, note text,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      origin text NOT NULL DEFAULT 'local',
      fed_key text GENERATED ALWAYS AS ((plan_slug || ':') || item_id) STORED,
      CONSTRAINT plan_item_assignments_pkey PRIMARY KEY (workspace_id, harness_slug, plan_slug, item_id),
      CONSTRAINT plan_item_assignments_item_nonempty CHECK (item_id <> '')
    )`);
  await rootSql.unsafe(`
    CREATE FUNCTION harness_shared.set_pia_updated_at() RETURNS trigger AS $$
    BEGIN NEW.updated_at := now(); RETURN NEW; END; $$ LANGUAGE plpgsql`);
  await rootSql.unsafe(`
    CREATE TRIGGER pia_updated_at_trg BEFORE UPDATE ON harness_shared.plan_item_assignments
    FOR EACH ROW EXECUTE FUNCTION harness_shared.set_pia_updated_at()`);
  h.sql = rootSql;
}, 90_000);

afterAll(async () => {
  await rootSql?.end({ timeout: 5 });
});

beforeEach(async () => {
  await rootSql`TRUNCATE harness_shared.plan_item_assignments`;
  h.planItems = [{ id: 'P-001' }, { id: 'P-002' }];
});

describe('plan-item assignment store (PG)', () => {
  it('assignItem inserts an ACTIVE assignment (released_ts NULL); getAssignment reads it back', async () => {
    const a = await assignItem({ ...base, itemId: 'P-001', assigneeName: 'builder-1', strategy: 'mvp', note: 'go' });
    expect(a).toMatchObject({ itemId: 'P-001', assigneeName: 'builder-1', strategy: 'mvp', note: 'go', releasedTs: null });
    expect((await getAssignment(WS, 'web', 'plan-a', 'P-001'))!.assigneeName).toBe('builder-1');
  });

  it('VALIDATES item existence — a typo P-NNN throws and inserts nothing; skipItemCheck bypasses', async () => {
    await expect(assignItem({ ...base, itemId: 'P-999', assigneeName: 'x' })).rejects.toThrow(/not found/);
    expect(await rootSql`SELECT 1 FROM harness_shared.plan_item_assignments`).toHaveLength(0); // nothing written
    // a federated/test insert may bypass the check
    await expect(assignItem({ ...base, itemId: 'P-999', assigneeName: 'x', skipItemCheck: true })).resolves.toMatchObject({ itemId: 'P-999' });
  });

  it('re-assign is LWW (ON CONFLICT DO UPDATE): one row, new assignee, released_ts re-nulled', async () => {
    await assignItem({ ...base, itemId: 'P-001', assigneeName: 'alice' });
    await unassignItem(WS, 'web', 'plan-a', 'P-001'); // release it
    await assignItem({ ...base, itemId: 'P-001', assigneeName: 'bob' }); // re-assign to a new name
    const rows = await rootSql`SELECT assignee_name, released_ts FROM harness_shared.plan_item_assignments WHERE item_id='P-001'`;
    expect(rows).toHaveLength(1); // upsert, not a 2nd row
    expect(rows[0]!.assignee_name).toBe('bob'); // new name wins
    expect(rows[0]!.released_ts).toBeNull(); // re-assign clears the soft release → active again
    expect((await getAssignment(WS, 'web', 'plan-a', 'P-001'))!.assigneeName).toBe('bob');
  });

  it('unassign is a SOFT release: row kept, active reads skip it, re-release is a no-op', async () => {
    await assignItem({ ...base, itemId: 'P-001', assigneeName: 'alice' });
    const released = await unassignItem(WS, 'web', 'plan-a', 'P-001');
    expect(released!.releasedTs).not.toBeNull();
    expect(await rootSql`SELECT 1 FROM harness_shared.plan_item_assignments WHERE item_id='P-001'`).toHaveLength(1); // not deleted
    expect(await getAssignment(WS, 'web', 'plan-a', 'P-001')).toBeNull(); // active read skips a released row
    expect(await unassignItem(WS, 'web', 'plan-a', 'P-001')).toBeNull(); // already released → no-op (released_ts IS NULL guard)
  });

  it('listAssignmentsForName / listAssignmentsForPlan return only ACTIVE rows, scoped', async () => {
    await assignItem({ ...base, itemId: 'P-001', assigneeName: 'alice' });
    await assignItem({ ...base, itemId: 'P-002', assigneeName: 'alice' });
    await unassignItem(WS, 'web', 'plan-a', 'P-002'); // release P-002
    expect((await listAssignmentsForName(WS, 'alice')).map((r) => r.itemId)).toEqual(['P-001']); // released P-002 excluded
    expect((await listAssignmentsForPlan(WS, 'web', 'plan-a')).map((r) => r.itemId)).toEqual(['P-001']);
    // another workspace's assignment to the same name is invisible
    await assignItem({ ...base, workspaceId: 'other-ws', itemId: 'P-001', assigneeName: 'alice', skipItemCheck: true });
    expect((await listAssignmentsForName(WS, 'alice')).map((r) => r.itemId)).toEqual(['P-001']); // still only WS's
  });
});
