/**
 * fleet:cancel — transitive cancellation of one OR many spawn subtrees (P0, D-003).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. The human/operator-cancel entry
 * point for the structured-concurrency nursery: cancelling a node fans cancellation
 * DOWN the entire spawn subtree and releases each descendant's work-item/plan-item
 * claims + file/resource locks immediately — instead of burning tokens for minutes
 * while N leases independently expire.
 *
 * Bulk by default (the house keyed-array contract,
 * bulk-endpoint-standardization-2026-06-21 P-006): pass `spawn_id` for one or
 * `spawn_ids` for several → { ok, results:[{ ok, spawn_id, cancelled, … | error }],
 * counts }. Each result self-describes its spawn_id, so one bad root never poisons
 * the rest and the caller correlates by spawn_id (not array position). `reason` /
 * `workspace` are batch-level.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { getOrgPg } from '@papercusp/db-org';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { activeWorkspaceId } from '../../workspace-registry';
import { cancelSubtree } from '../../fleet/nursery';
import { mergeIds, runBulk, bulkContent } from '@papercusp/agent-mcp/_bulk';
import { softText, clampText } from '../limits';

export default defineTool({
  name: 'fleet:cancel',
  profile: 'engineer',
  description:
    'Cancel one OR many spawn subtrees: mark every active descendant cancelled and release its claims + locks NOW. Pass `spawn_id` for one or `spawn_ids` for several. The structured-concurrency abort — use it instead of waiting for leases to expire. Returns { ok, results:[{ ok, spawn_id, cancelled, … | error }], counts } — correlate by spawn_id, not position; one failure never fails the rest.',
  guidance: {
    when: 'A human/operator aborts a unit of work, or a supervisor tears down a doomed subtree. Cancels the named spawn(s) AND all descendants transitively, freeing their locks + work-item/plan-item claims immediately. Tearing down several at once? Pass them all via `spawn_ids`.',
    notWhen: 'To cancel a single leaf with no children — that is the same call with a leaf spawn_id, but prefer it when you specifically mean the whole subtree.',
    chaining: 'fleet:tree (inspect the subtree) → fleet:cancel { spawn_id } | { spawn_ids:[…] }. Bulk: correlate each result by spawn_id, not position; one failure never fails the rest.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      spawn_id: z.string().min(1).optional().describe('Root of one subtree to cancel (this node + all descendants; n=1 shorthand for spawn_ids:[id]).'),
      spawn_ids: z.array(z.string().min(1)).min(1).max(100).optional().describe('Roots of the subtrees to cancel (1–100).'),
      reason: softText(4000).optional().describe('Why — surfaced in the coord cancellation notice + audit (batch-level). Auto-truncated to 4000 chars if longer.'),
      workspace: z.string().max(120).optional(),
    })
    .refine((a) => Boolean(a.spawn_id) || (a.spawn_ids?.length ?? 0) > 0, {
      message: 'pass `spawn_id` (one) or `spawn_ids` (many)',
    }),
  async handler(args, ctx) {
    const actor = resolveAgentIdentity(ctx);
    const workspaceId = args.workspace ?? actor.workspaceId ?? activeWorkspaceId();
    const { sql } = getOrgPg();
    const ids = mergeIds(args.spawn_id, args.spawn_ids);

    // Local-process abort is best-effort and shared across the batch; resolve the
    // abort fn ONCE (the dynamic import statically pulls DBOS featurePipeline, which
    // must not load at tool-mount — mirrors fleet/spawn + operator/converse).
    let abortLocalSpawn: ((id: string) => boolean) | null = null;
    try {
      ({ abortLocalSpawn } = await import('../../fleet/operator-spawn'));
    } catch (err) {
      console.warn('[fleet:cancel] local process abort failed', err);
    }

    const env = await runBulk(
      ids,
      async (spawn_id) => {
        const res = await cancelSubtree(sql, {
          workspaceId,
          rootSpawnId: spawn_id,
          reason: clampText(args.reason, 4000) ?? 'fleet:cancel',
          actor,
        });
        let processes_aborted = 0;
        if (abortLocalSpawn) {
          for (const c of res.cancelled) {
            if (abortLocalSpawn(c.spawnId)) processes_aborted++;
          }
        }
        return {
          ok: true as const,
          spawn_id: res.rootSpawnId,
          cancelled: res.cancelled.map((c) => c.spawnId),
          processes_aborted,
          already_terminal: res.alreadyTerminal,
          claims_released: res.claimsReleased,
          plan_claims_released: res.planClaimsReleased,
          file_locks_released: res.locks.filePathsReleased,
          resource_locks_released: res.locks.resourcesReleased,
          notified: res.notified,
        };
      },
      { keyOf: (spawn_id) => ({ spawn_id }) },
    );
    return bulkContent(env);
  },
});
