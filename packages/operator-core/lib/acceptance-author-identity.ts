/**
 * Acceptance-author identity continuity.
 *
 * Coordination identities are intentionally ephemeral, while an acceptance rubric
 * can outlive the session that authored it. `coord:rebind-identity` is the canonical
 * recovery operation: it verifies the predecessor is no longer live, migrates its
 * owner-keyed state, and leaves an audited `tool_invocations` row. Reuse that ledger
 * as the proof that a later identity is the rubric author's successor. Historical
 * rubric/scorecard attribution remains untouched.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

export interface AcceptanceAuthorIdentityOpts {
  sql?: Sql;
  workspaceId?: string;
}

/**
 * Whether `candidateId` is the recorded author or a successor reachable through
 * one or more successful `coord:rebind-identity` operations.
 *
 * Fail closed: if the audit ledger is unavailable, only raw identity equality is
 * accepted. The recursive walk is cycle-safe and bounded so malformed historical
 * rows cannot turn an acceptance check into an unbounded query.
 */
export async function isAcceptanceAuthorIdentity(
  recordedAuthorId: string | null | undefined,
  candidateId: string | null | undefined,
  opts: AcceptanceAuthorIdentityOpts = {},
): Promise<boolean> {
  const author = recordedAuthorId?.trim() ?? '';
  const candidate = candidateId?.trim() ?? '';
  if (!author || !candidate) return false;
  if (author === candidate) return true;

  const sql = opts.sql ?? getOrgPg().sql;
  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  try {
    const rows = await sql<Array<{ matches: boolean }>>`
      WITH RECURSIVE rebind_edges AS (
        SELECT args_json->>'from' AS from_id,
               COALESCE(NULLIF(args_json->>'to', ''), coord_owner_id) AS to_id
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${workspaceId}
           AND tool_name = 'coord:rebind-identity'
           AND status = 'ok'
           AND args_json->>'from' IS NOT NULL
           AND COALESCE(NULLIF(args_json->>'to', ''), coord_owner_id) IS NOT NULL
      ), author_lineage(owner_id, path, depth) AS (
        SELECT ${author}::text, ARRAY[${author}::text], 0
        UNION ALL
        SELECT edge.to_id, lineage.path || edge.to_id, lineage.depth + 1
          FROM author_lineage AS lineage
          JOIN rebind_edges AS edge ON edge.from_id = lineage.owner_id
         WHERE lineage.depth < 32
           AND NOT edge.to_id = ANY(lineage.path)
      )
      SELECT EXISTS(
        SELECT 1 FROM author_lineage WHERE owner_id = ${candidate}
      ) AS matches
    `;
    return rows[0]?.matches === true;
  } catch {
    return false;
  }
}
