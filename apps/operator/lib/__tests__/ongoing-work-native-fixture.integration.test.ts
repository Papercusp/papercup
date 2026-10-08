import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrgTestDb, type OrgTestDb } from '../../../../packages/operator-core/test/_org-test-db';
import { insertNativeCollectionGoal } from '../../e2e/_ongoing-work-native-fixture';

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
});
