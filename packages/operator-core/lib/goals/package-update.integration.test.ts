import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../test/_org-test-db';
import { applyGoalPackageUpdate, planGoalPackageUpdate } from './package-update';
import { resolveLocalGoalPackage } from '../cupboard/goal-package-store';
import type { Sql } from 'postgres';

// Exercise the maintained bundled package, independent of any user-layer
// export on the developer's machine. The SQL reader/validator/writer stay real.
vi.mock('../cupboard/goal-package-store', async (original) => {
  const actual = await original<typeof import('../cupboard/goal-package-store')>();
  const { fileURLToPath } = await import('node:url');
  return { ...actual, resolveLocalGoalPackage: (ref: string) => actual.resolveLocalGoalPackage(ref,
    [{ dir: fileURLToPath(new URL('../../../../goal-packages', import.meta.url)), layer: 'bundled' }]) };
});

let db: OrgTestDb;
const WS = 'package-update-properties';
beforeAll(async () => { db = await createOrgTestDb(); }, 300_000);
afterAll(async () => { await db?.cleanup(); }, 120_000);

describe('accepted package declaration update (private Postgres)', () => {
  it.each(['active', 'paused'])('updates the installed schema and preserves stored choices and instance declarations (%s)', async (status) => {
    const sql = db.adminSql;
    const goalId = `package-update-${status}`;
    const pkg = resolveLocalGoalPackage('work-on-everything');
    expect(pkg?.version).toBe('1.2.0');
    const properties = {
      worklist: { value: ['plan:papercusp/saved-plan'], version: 7, edited_by: 'agent', edited_at: '2026-10-01T00:00:00Z' },
      worklist_policy: { value: { order: ['plan:papercusp/saved-plan'], excluded: ['plan:papercusp/excluded-plan'] },
        version: 4, edited_by: 'owner', edited_at: '2026-10-02T00:00:00Z' },
    };
    const metadata = { goalPackageRef: 'work-on-everything', packageVersion: '1.1.0',
      ...(status === 'active' ? { agentOwnerId: 'su-package-holder' } : {}), custom: { keep: true } };
    const instanceOnly = { datatype: 'plan-ref-list', default: [], editable_by: 'owner' };
    await sql`INSERT INTO harness_shared.goals
      (workspace_id, id, install_slug, title, status, standing, property_schema, properties, metadata)
      VALUES (${WS}, ${goalId}, 'papercusp', 'Prior title', ${status}, true,
        ${sql.json({ worklist: { datatype: 'plan-ref-list', default: [], editable_by: 'both' }, instance_only: instanceOnly })},
        ${sql.json(properties)}, ${sql.json(metadata)})`;
    await sql.begin(async (tx) => {
      const plan = await planGoalPackageUpdate(tx as unknown as Sql, { workspaceId: WS, goalId });
      expect(plan.ok && plan.changes.map((c) => c.field)).toContain('propertySchema');
      const [before] = await tx`SELECT metadata, properties, property_schema FROM harness_shared.goals
        WHERE workspace_id = ${WS} AND id = ${goalId}`;
      expect(before.metadata.packageVersion).toBe('1.1.0');
      expect(before.properties).toEqual(properties);
      const applied = await applyGoalPackageUpdate(tx as unknown as Sql, { workspaceId: WS, goalId });
      expect(applied).toMatchObject({ ok: true, mode: status === 'active' ? 'live-contract' : 'stub-refresh' });
    });
    const [after] = await sql`SELECT metadata, properties, property_schema FROM harness_shared.goals
      WHERE workspace_id = ${WS} AND id = ${goalId}`;
    expect(after.properties).toEqual(properties);
    expect(after.metadata).toEqual({ ...metadata, packageVersion: '1.2.0' });
    expect(after.property_schema).toEqual({ ...pkg?.propertySchema, instance_only: instanceOnly });
    const again = await planGoalPackageUpdate(sql, { workspaceId: WS, goalId });
    expect(again).toMatchObject({ ok: false, reason: 'up-to-date' });
  }, 60_000);
});
