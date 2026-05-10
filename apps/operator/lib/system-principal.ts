/**
 * System-principal lookup — bearer + capabilities for `system:<name>`.
 *
 * The bearer lives in `harness_shared.token_index` (`kind='system'`, `harness_slug='system:<name>'`)
 * and the capability list lives in `harness_shared.system_principals`. Both
 * are written by `provisionSystemPrincipal` (packages/agent-mcp/src/provisioning.ts).
 *
 * Was previously also duplicated to `<workspace>/system/<name>/config.json`
 * for read-access by the operator's dispatch routes. That file is now gone;
 * routes call this module instead. The bearer hash in `system_principals`
 * is preserved for audit/rotation but the routes only need the live bearer
 * which lives in `token_index`.
 *
 * Note on encryption: `token_index.token` is plaintext today. Adding
 * column-level encryption breaks the auth middleware's `WHERE token = $1`
 * lookup pattern; would require either (a) a hash index for incoming-token
 * verification + a separate ciphertext column for retrieval, or (b) a
 * different lookup model entirely. Tracked as future work.
 */

import { getOrgPg } from '@restart/db-org';
import { activeWorkspaceId } from './workspace-registry';

export interface SystemPrincipal {
  bearer: string;
  name: string;
  workspaceId: string;
  capabilities: string[];
}

/**
 * Read the system principal for `name` ('operator' | 'oracle' | …) in the
 * active workspace. Returns null when not provisioned (caller surfaces a
 * "POST /api/agent-mcp/provision first" error per established route convention).
 */
export async function readSystemPrincipal(name: string): Promise<SystemPrincipal | null> {
  const { sql } = getOrgPg();
  const ws = activeWorkspaceId();
  const slug = `system:${name}`;
  const rows = await sql<
    { token: string; capabilities: string[] }[]
  >`
    SELECT ti.token AS token, sp.capabilities AS capabilities
      FROM harness_shared.token_index ti
      JOIN harness_shared.system_principals sp
        ON sp.workspace_id = ti.workspace_id AND sp.name = ${name}
     WHERE ti.kind = 'system'
       AND ti.harness_slug = ${slug}
       AND ti.workspace_id = ${ws}
     LIMIT 1
  `;
  if (rows.length === 0) return null;
  return {
    bearer: rows[0].token,
    name,
    workspaceId: ws,
    capabilities: rows[0].capabilities ?? [],
  };
}
