/**
 * Acceptance-author identity continuity.
 *
 * Coordination identities are intentionally ephemeral, while an acceptance rubric
 * can outlive the session that authored it. `coord:rebind-identity` is the canonical
 * recovery operation: it verifies the predecessor is no longer live, migrates its
 * owner-keyed state, and leaves an audited `tool_invocations` row. Spawned agents
 * also carry durable launcher edges: current su/desktop agents in
 * `adv_sessions.launch_spec.launchedBy`, and operator spawns in
 * `spawned_agents.parent_spawn_id`. This module keeps author-successor continuity
 * (rebinds) distinct from evaluator-independence lineage (rebinds plus launches).
 * Historical rubric/scorecard attribution remains untouched.
 */
import type { Sql } from 'postgres';
import { getOrgPg } from '@papercusp/db-org';
import { activeWorkspaceId } from './workspace-registry';

export interface AcceptanceAuthorIdentityOpts {
  sql?: Sql;
  workspaceId?: string;
}

/**
 * Whether two identities are in a direct ancestor/descendant chain.
 *
 * Rebind edges and both agent-launch parent edges are directed. We walk from each
 * candidate in turn, so an ancestor grader is excluded just like a descendant
 * grader, while siblings remain eligible (sharing a parent is not lineage).
 * Spawn ids and session owners are aliases in the spawned-agent table; both
 * representations are bridged. The recursive walk is bounded and cycle-safe.
 */
export async function areAcceptanceLineageRelated(
  firstId: string | null | undefined,
  secondId: string | null | undefined,
  opts: AcceptanceAuthorIdentityOpts = {},
): Promise<boolean> {
  const first = firstId?.trim() ?? '';
  const second = secondId?.trim() ?? '';
  if (!first || !second) return false;
  if (first === second) return true;

  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  const sql = opts.sql ?? getOrgPg().sql;
  const rows = await sql<Array<{ matches: boolean }>>`
      WITH RECURSIVE identity_edges(from_id, to_id) AS (
        SELECT args_json->>'from',
               COALESCE(NULLIF(args_json->>'to', ''), coord_owner_id)
          FROM harness_shared.tool_invocations
         WHERE workspace_id = ${workspaceId}
           AND tool_name = 'coord:rebind-identity'
           AND status = 'ok'
           AND args_json->>'from' IS NOT NULL
           AND COALESCE(NULLIF(args_json->>'to', ''), coord_owner_id) IS NOT NULL
        UNION
        SELECT launch_spec->>'launchedBy', coord_owner_id
          FROM harness_shared.adv_sessions
         WHERE workspace_id = ${workspaceId}
           AND NULLIF(launch_spec->>'launchedBy', '') IS NOT NULL
           AND NULLIF(coord_owner_id, '') IS NOT NULL
        UNION
        SELECT parent_spawn_id, spawn_id
          FROM harness_shared.spawned_agents
         WHERE workspace_id = ${workspaceId}
           AND NULLIF(parent_spawn_id, '') IS NOT NULL
        UNION
        SELECT parent_spawn_id, session_owner
          FROM harness_shared.spawned_agents
         WHERE workspace_id = ${workspaceId}
           AND NULLIF(parent_spawn_id, '') IS NOT NULL
           AND NULLIF(session_owner, '') IS NOT NULL
        UNION
        SELECT spawn_id, session_owner
          FROM harness_shared.spawned_agents
         WHERE workspace_id = ${workspaceId}
           AND NULLIF(session_owner, '') IS NOT NULL
        UNION
        SELECT session_owner, spawn_id
          FROM harness_shared.spawned_agents
         WHERE workspace_id = ${workspaceId}
           AND NULLIF(session_owner, '') IS NOT NULL
      ),
      walk(node, path, depth) AS (
        SELECT ${first}::text, ARRAY[${first}::text], 0
        UNION ALL
        SELECT edge.to_id, walk.path || edge.to_id, walk.depth + 1
          FROM walk
          JOIN identity_edges AS edge ON edge.from_id = walk.node
         WHERE walk.depth < 64
           AND NOT edge.to_id = ANY(walk.path)
      ),
      reverse_walk(node, path, depth) AS (
        SELECT ${second}::text, ARRAY[${second}::text], 0
        UNION ALL
        SELECT edge.to_id, reverse_walk.path || edge.to_id, reverse_walk.depth + 1
          FROM reverse_walk
          JOIN identity_edges AS edge ON edge.from_id = reverse_walk.node
         WHERE reverse_walk.depth < 64
           AND NOT edge.to_id = ANY(reverse_walk.path)
      )
      SELECT EXISTS (SELECT 1 FROM walk WHERE node = ${second})
          OR EXISTS (SELECT 1 FROM reverse_walk WHERE node = ${first}) AS matches
  `;
  return rows[0]?.matches === true;
}

/**
 * Whether `candidateId` is the recorded author or a successor reachable through
 * one or more successful `coord:rebind-identity` operations. Spawn descendants
 * are deliberately NOT author successors; callers that need evaluator
 * independence use {@link areAcceptanceLineageRelated} separately.
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

  const workspaceId = opts.workspaceId ?? activeWorkspaceId();
  try {
    const sql = opts.sql ?? getOrgPg().sql;
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
