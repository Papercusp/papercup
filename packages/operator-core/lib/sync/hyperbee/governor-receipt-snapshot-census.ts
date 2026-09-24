/** PostgreSQL census for P-530's own-log snapshot receipt filter. */

import { getOrgPg } from '@papercusp/db-org';
import type postgres from 'postgres';
import { composeEngineerIssueKey } from './feature-issue-op-keys';

export async function loadLiveGovernorReceiptSnapshotKeys(
  workspaceId: string,
  sql: postgres.Sql = getOrgPg().sql,
): Promise<string[]> {
  const rows = await sql<Array<{ harness_slug: string; feature_id: string }>>`
    SELECT harness_slug, feature_id
      FROM harness_shared.work_items
     WHERE workspace_id = ${workspaceId}
       AND jsonb_exists(COALESCE(payload, '{}'::jsonb), 'resource_governor')
     ORDER BY harness_slug, feature_id
  `;
  return rows.map((row) => composeEngineerIssueKey(row.harness_slug, row.feature_id));
}
