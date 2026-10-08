import type { Sql } from 'postgres';

/** Exercise archival disappearance/rediscovery without requesting shipment. */
export async function setNativeCollectionPlanArchived(sql: Sql, input: {
  workspaceId: string;
  harness: string;
  slug: string;
  archived: boolean;
}) {
  // Archiving is independent of lifecycle status. `done` is an item alias,
  // while `shipped` requires an acceptance receipt; neither belongs in this fixture.
  await sql`UPDATE harness_shared.harness_plans
    SET archived=${input.archived}
    WHERE workspace_id=${input.workspaceId} AND harness_slug=${input.harness} AND plan_slug=${input.slug}`;
}

/** Seed through the same SQL path in the cheap PG guard and owned native run. */
export async function insertNativeCollectionGoal(sql: Sql, input: {
  workspaceId: string;
  goalId: string;
  title: string;
  schema: Record<string, unknown>;
}) {
  // An explicit text parameter avoids default postgres-js JSONB serialization
  // double-encoding this already-stringified declaration.
  await sql`INSERT INTO harness_shared.goals (workspace_id,id,install_slug,title,status,property_schema)
    VALUES (${input.workspaceId},${input.goalId},${input.goalId},${input.title},'active',
            ${JSON.stringify(input.schema)}::text::jsonb)`;
}

/** Seed the normalized item source that the real portfolio admission reader uses. */
export async function insertNativeCollectionPlan(sql: Sql, input: {
  workspaceId: string;
  harness: string;
  slug: string;
  title: string;
  status: 'active' | 'draft';
}) {
  const item = { id: 'P-001', status: 'todo', text: `Native ${input.slug} work`, blockedBy: [] };
  await sql.begin(async tx => {
    await tx`INSERT INTO harness_shared.harness_plans
      (workspace_id,harness_slug,plan_slug,title,status,op_status,items)
      VALUES (${input.workspaceId},${input.harness},${input.slug},${input.title},${input.status},NULL,
              ${JSON.stringify([item])}::text::jsonb)`;
    await tx`INSERT INTO harness_shared.plan_items
      (workspace_id,harness_slug,plan_slug,item_id,seq,item_text,status,blocked_by)
      VALUES (${input.workspaceId},${input.harness},${input.slug},${item.id},1,${item.text},'todo',ARRAY[]::text[])`;
  });
}
