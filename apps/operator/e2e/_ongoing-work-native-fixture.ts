import type { Sql } from 'postgres';

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
