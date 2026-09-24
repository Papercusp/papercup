/** Legacy scheduled blueprint work-item admission against the migrated org schema. */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Sql } from 'postgres';
import { BlueprintSchema, type Blueprint } from '@papercusp/orchestrator/blueprint';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { runWithWorkspace } from '../workspace-als';
import { handleBlueprintRun, setBlueprintResolver, setOrphanRoutineSeams } from './blueprint-run-action';

const db = vi.hoisted(() => ({ sql: undefined as unknown as Sql }));
vi.mock('@papercusp/db-org', async (orig) => {
  const actual = await orig<typeof import('@papercusp/db-org')>();
  return { ...actual, getOrgPg: () => ({ sql: db.sql }) };
});
vi.mock('@papercusp/flags/server', async (orig) => {
  const actual = await orig<typeof import('@papercusp/flags/server')>();
  return { ...actual, getFlag: async () => false };
});

const WS = 'ws-blueprint-scheduled';
const HARNESS = 'blueprint-scheduled-it';
const blueprint = BlueprintSchema.parse({
  id: 'scheduled-v1', workItem: { kind: 'feature' },
  roles: [{ id: 'worker' }], spine: { edges: { DONE: { to: 'done' } } },
});
let org: OrgTestDb;
let sql: Sql;

beforeAll(async () => {
  org = await createOrgTestDb();
  sql = org.adminSql;
  db.sql = sql;
  await sql`
    INSERT INTO harness_shared.pots
      (workspace_id, pot_home_slug, public_key, keychain_id, created_at)
    VALUES (${WS}, ${HARNESS}, ${Buffer.from([0])}, 'kc-blueprint-scheduled-it', 0)
    ON CONFLICT (workspace_id, pot_home_slug) DO NOTHING
  `;
});
afterAll(async () => { await org?.cleanup(); });
beforeEach(() => {
  setOrphanRoutineSeams({ installGone: async () => false });
  setBlueprintResolver(async () => blueprint);
});
afterEach(() => {
  setBlueprintResolver(null);
  setOrphanRoutineSeams({ installGone: null, disarm: null });
});

function fire(workflowId: string | undefined, title: string, id?: string) {
  return runWithWorkspace(WS, () => handleBlueprintRun({
    installSlug: HARNESS, workspaceId: WS, workflowId, triggerConfig: {},
    payloadTemplate: { mode: 'work-item', workItem: { title, ...(id ? { id } : {}) } },
  }));
}

describe('system:blueprint-run scheduled work-item receipt', () => {
  it('replays one workflow fire from its saved input and creates no plan records', async () => {
    await Promise.all([fire('routine-fire-1', 'Original'), fire('routine-fire-1', 'Original')]);
    const receipts = await sql<Array<{ target_ref: string; request_payload: Record<string, unknown> }>>`
      SELECT target_ref, request_payload
        FROM harness_shared.blueprint_operation_invocations
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
         AND caller_id = 'system:blueprint-run' AND request_key = 'routine-fire-1'
    `;
    expect(receipts).toHaveLength(1);
    expect(receipts[0].request_payload).toMatchObject({ title: 'Original', blueprintId: 'scheduled-v1' });
    expect(receipts[0].target_ref).toMatch(/^WI-/);

    // Simulate a crash after receipt reservation but before canonical creation.
    // Recovery can resolve a newer definition and payload after that point.
    await sql`
      DELETE FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
         AND feature_id = ${receipts[0].target_ref}
    `;
    setBlueprintResolver(async () => ({ ...blueprint, id: 'scheduled-v2' }) as Blueprint);
    await fire('routine-fire-1', 'Changed after receipt');
    const rows = await sql<Array<{ feature_id: string; title: string; status: string; payload: Record<string, unknown> }>>`
      SELECT feature_id, title, status, payload
        FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ feature_id: receipts[0].target_ref, title: 'Original', status: 'open' });
    expect(rows[0].payload._blueprintScheduled).toMatchObject({ requestKey: 'routine-fire-1' });
    const plans = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM harness_shared.harness_plans
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
    `;
    const runs = await sql<Array<{ count: number }>>`
      SELECT count(*)::int AS count FROM harness_shared.plan_runs
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
    `;
    expect(plans[0].count).toBe(0);
    expect(runs[0].count).toBe(0);
  });

  it('uses an explicit item id as the stable key outside a DBOS workflow', async () => {
    await fire(undefined, 'Manual item', 'WI-SCHEDULED-EXPLICIT');
    await fire(undefined, 'Manual item', 'WI-SCHEDULED-EXPLICIT');
    const rows = await sql<Array<{ feature_id: string }>>`
      SELECT feature_id FROM harness_shared.work_items
       WHERE workspace_id = ${WS} AND harness_slug = ${HARNESS}
         AND feature_id = 'WI-SCHEDULED-EXPLICIT'
    `;
    expect(rows).toHaveLength(1);
    await expect(fire(undefined, 'Changed manual item', 'WI-SCHEDULED-EXPLICIT'))
      .rejects.toThrow('reused with different input');
    await expect(fire(undefined, 'No stable identity')).rejects.toThrow('stable workflowId or explicit item id');
  });
});
