/**
 * fleet:cancel — transitive cancellation of a spawn subtree (P0, D-003).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. The human/operator-cancel entry
 * point for the structured-concurrency nursery: cancelling a node fans cancellation
 * DOWN the entire spawn subtree and releases each descendant's work-item/plan-item
 * claims + file/resource locks immediately — instead of burning tokens for minutes
 * while N leases independently expire.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { cancelSubtree } from '../../fleet/nursery';

export default defineTool({
  name: 'fleet:cancel',
  profile: 'engineer',
  description:
    'Cancel a spawn subtree: mark every active descendant cancelled and release its claims + locks NOW. The structured-concurrency abort — use it instead of waiting for leases to expire.',
  guidance: {
    when: 'A human/operator aborts a unit of work, or a supervisor tears down a doomed subtree. Cancels the named spawn AND all its descendants transitively, freeing their locks + work-item/plan-item claims immediately.',
    notWhen: 'To cancel a single leaf with no children — that is the same call with a leaf spawn_id, but prefer it when you specifically mean the whole subtree.',
    chaining: 'fleet:tree (inspect the subtree) → fleet:cancel { spawn_id }.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    spawn_id: z.string().min(1).describe('Root of the subtree to cancel (this node + all descendants).'),
    reason: z.string().max(500).optional().describe('Why — surfaced in the coord cancellation notice + audit.'),
    workspace: z.string().max(120).optional(),
  }),
  async handler(args, ctx) {
    const actor = resolveAgentIdentity(ctx);
    const workspaceId = args.workspace ?? actor.workspaceId ?? activeWorkspaceId();
    const { sql } = getOrgPg();
    const res = await cancelSubtree(sql, {
      workspaceId,
      rootSpawnId: args.spawn_id,
      reason: args.reason ?? 'fleet:cancel',
      actor,
    });
    // EI-40: the subtree flip + lock/claim release above is the DURABLE half.
    // The other half — actually SIGTERM/SIGKILL the running child so a cancelled
    // operator-spawn stops making edits instead of running to INVOKE_TIMEOUT — is
    // the in-process abort registry in fleet/operator-spawn. Only spawns THIS host
    // launched are locally tracked; others' rows still flipped, and their
    // lease/timeout reclaims them (unchanged). Dynamic import: operator-spawn
    // statically pulls the DBOS featurePipeline registration, which must not load
    // at tool-mount (mirrors fleet/spawn + operator/converse).
    let processesAborted = 0;
    try {
      const { abortLocalSpawn } = await import('../../fleet/operator-spawn');
      for (const c of res.cancelled) {
        if (abortLocalSpawn(c.spawnId)) processesAborted++;
      }
    } catch (err) {
      console.warn('[fleet:cancel] local process abort failed', err);
    }
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            root: res.rootSpawnId,
            cancelled: res.cancelled.map((c) => c.spawnId),
            processes_aborted: processesAborted,
            already_terminal: res.alreadyTerminal,
            claims_released: res.claimsReleased,
            plan_claims_released: res.planClaimsReleased,
            file_locks_released: res.locks.filePathsReleased,
            resource_locks_released: res.locks.resourcesReleased,
            notified: res.notified,
          }),
        },
      ],
    };
  },
});
