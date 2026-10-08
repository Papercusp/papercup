import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../../packages/operator-core/test/_org-test-db';
import { insertNativeCollectionGoal, insertNativeCollectionPlan } from '../../e2e/_ongoing-work-native-fixture';
import { readGoalPortfolioBrief } from '../../../../packages/operator-core/lib/goal-launch-settings';

describe('native collection fixture against migrated private PG', () => {
  let db: OrgTestDb;
  let sql: ReturnType<typeof postgres>;
  const schema = {
    tea_choices: { datatype: 'string-list', editable_by: 'both', default: ['mint', 'rooibos'],
      collection: { source: 'manual', policy: 'tea_policy', order: 'display', selectable: true, defaultSelected: true } },
    tea_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner', default: { order: [], excluded: [] } },
  };

  beforeAll(async () => {
    db = await createOrgTestDb();
    // Use the native fixture's DEFAULT driver, rather than the org fixture's
    // restored raw JSONB serializer, which would hide this defect.
    sql = postgres(db.adminDsn, { max: 1, connect_timeout: 5 });
  }, 120_000);

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await db?.cleanup();
  });

  it('persists the actual native seed as a JSONB object with the original declaration', async () => {
    await insertNativeCollectionGoal(sql, { workspaceId: 'native-seed-test', goalId: 'native-seed-positive',
      title: 'Native tea collection', schema });
    const [row] = await sql`SELECT jsonb_typeof(property_schema) AS kind, property_schema
      FROM harness_shared.goals WHERE workspace_id='native-seed-test' AND id='native-seed-positive'`;
    expect(row.kind).toBe('object');
    expect(row.property_schema).toEqual(schema);
  });

  it('distinguishes default-driver double encoding from an invalid declaration', async () => {
    const [row] = await sql`SELECT jsonb_typeof(${JSON.stringify(schema)}::jsonb) AS kind`;
    expect(row.kind).toBe('string');
    await expect(sql`INSERT INTO harness_shared.goals
      (workspace_id,id,install_slug,title,status,property_schema)
      VALUES ('native-seed-test','native-seed-negative','native-seed-negative','Native tea collection','active',
              ${JSON.stringify(schema)}::jsonb)`).rejects.toMatchObject({
        code: '23514', constraint_name: 'goals_property_schema_object',
      });
  });

  it('makes the real native plan seed actionable through canonical portfolio admission', async () => {
    const workspaceId = 'native-admission-test', goalId = 'native-admission-positive', harness = 'native-admission';
    const ids = ['alpha', 'beta', 'blocked'].map(slug => `plan:${harness}/${slug}`);
    await insertNativeCollectionGoal(sql, { workspaceId, goalId, title: 'Native admission', schema: {
      worklist: { datatype: 'plan-ref-list', editable_by: 'both', default: ids,
        collection: { source: 'active-workspace-plans', policy: 'worklist_policy', order: 'priority',
          selectable: true, defaultSelected: true } },
      worklist_policy: { datatype: 'ordered-selection-policy', editable_by: 'owner',
        default: { order: [ids[1], ids[0], ids[2]], excluded: [] } },
    } });
    for (const slug of ['alpha', 'beta', 'blocked']) {
      await insertNativeCollectionPlan(sql, { workspaceId, harness, slug, title: slug,
        status: slug === 'blocked' ? 'draft' : 'active' });
    }
    const read = () => readGoalPortfolioBrief({ workspaceId, goalId, sql, claimability: 'skip' });
    const brief = await read();
    expect(brief?.worklist.map(plan => plan.slug)).toEqual(['beta', 'alpha', 'blocked']);
    expect(brief?.worklist.find(plan => plan.slug === 'beta')).toMatchObject({
      next: { id: 'P-001' }, counts: { todo: 1 },
      placement: { state: 'unplaced', reconciliation: { toolCall: { tool: 'fleet:launch-on-plan' } } },
    });
    expect(brief?.worklist.find(plan => plan.placement.reconciliation.toolCall !== null)?.slug).toBe('beta');
    expect(brief?.worklist.find(plan => plan.slug === 'blocked')?.placement.reconciliation.toolCall).toBeNull();

    // Keep the legacy metadata intact while removing the canonical source.
    // This distinguishes a fixture-source defect from ordering/admission logic.
    await sql`DELETE FROM harness_shared.plan_items
      WHERE workspace_id=${workspaceId} AND harness_slug=${harness} AND plan_slug='beta'`;
    const [metadata] = await sql`SELECT jsonb_array_length(items) AS count FROM harness_shared.harness_plans
      WHERE workspace_id=${workspaceId} AND harness_slug=${harness} AND plan_slug='beta'`;
    expect(metadata.count).toBe(1);
    expect((await read())?.worklist.find(plan => plan.slug === 'beta')).toMatchObject({
      next: null, counts: { todo: 0 },
      placement: { state: 'blocked', reconciliation: { toolCall: null } },
    });
  });
});
