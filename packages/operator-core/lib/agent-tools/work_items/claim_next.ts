/**
 * work_items:claim_next — self-selection over central assignment (D-004 / D-007).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. The tuple-space associative `in`:
 * atomically claim the OLDEST unclaimed work-item in a harness via SELECT … FOR UPDATE
 * SKIP LOCKED. Competing idle agents each grab a different item (no double-claim), and
 * oldest-first steals the most-starved tail of the queue. Leaning to self-selection
 * (the Oct-2025 LLM-blackboard result: +13–57% task success) — named assignment stays
 * the deliberate exception (work_items:claim with an explicit assignee).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { claimNextWorkItem, releaseWorkItem } from '../../work-items';
import { workItemClaimLeaseEnabled, leaseClaimedWorkItem } from '../../work-item-claim-lease-wiring';
import { workItemRedundancyEnabled } from '../../work-item-redundancy';
import { localSwarmId } from '../../fleet/swarm-identity';
import { activeWorkspaceId } from '../../workspace-registry';

export default defineTool({
  name: 'work_items:claim_next',
  profile: 'engineer',
  description:
    'Self-select: atomically claim the OLDEST unclaimed work-item in a harness (tuple-space `in` via SKIP LOCKED + work-stealing). Competing agents never double-claim. Returns the claimed item or null.',
  guidance: {
    when: 'You are an idle agent picking up work — prefer this self-selection over waiting to be assigned. Returns the oldest claimable feature-family item, now yours.',
    notWhen: 'When a SPECIFIC item must go to a SPECIFIC agent — that is work_items:claim with an explicit assignee (named assignment, the exception).',
    chaining: 'work_items:claim_next → work_items:set_state → work_items:release.',
  },
  capability: 'work_items:write',
  // tool-call-batching-wrappers-2026-06-21 P-011 — composite marker: atomic self-select
  // replaces a manual work_items:claim (find-oldest + claim, race-free).
  replaces: ['work_items:claim'],
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1),
    kind: z.enum(['feature', 'research-task', 'chunk']).optional(),
    assignee: z.string().max(120).optional().describe('default: you'),
    states: z.array(z.string()).max(20).optional().describe('claimable states (default ["todo"])'),
    count: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe(
        'How many of the OLDEST unclaimed items to claim (default 1, max 25). >1 loops the same race-free SKIP-LOCKED claim path N times, stopping at the first miss — so you may get FEWER than `count` when the queue runs dry. count>1 returns { ok, claimed: [...] }; omitted/1 keeps the single-item { ok, workItem } shape (backward-compatible).',
      ),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const assignee = args.assignee ?? ident.ownerId;
    // P-002 co-location lever: under the per-Hive claim lease, honor each item's
    // swarm_affinity by passing THIS Swarm's id — the claim then skips work affined to
    // another Swarm and prefers work affined to us. Flag OFF (default) ⇒ swarmId omitted
    // ⇒ affinity-blind, claim is byte-identical to before.
    const leaseOn = workItemClaimLeaseEnabled();
    const swarmId = leaseOn ? localSwarmId(activeWorkspaceId(), args.harness) : undefined;
    // P-014: under the redundancy flag, skip high-stakes items here — they fan out to N
    // Swarms via work_items:claim_replica, not an exactly-once claim. Flag OFF ⇒ omitted.
    const excludeRedundant = workItemRedundancyEnabled();

    /** One race-free claim (the existing path) incl. the cross-Swarm lease arbitration.
     *  Returns the claimed item, or null when nothing was (or could be) claimed. */
    const claimOne = async () => {
      const wi = await claimNextWorkItem({
        harness: args.harness,
        assignee,
        kind: args.kind,
        states: args.states,
        swarmId,
        excludeRedundant,
      });
      // P-004 / D-002 (D-007 hybrid), flag-gated default-OFF: once the owner ratifies
      // (the WORKITEM_CLAIM_LEASE flag), the local SKIP-LOCKED claim is arbitrated by
      // the per-Hive authority lease. On a single box this is a no-op (authority = self);
      // cross-Swarm, only one Swarm wins the Hive lease — the loser releases its local
      // claim so the item returns to the backlog (work-stealing across machines).
      if (wi && leaseOn) {
        const leased = await leaseClaimedWorkItem({ harness: args.harness, workItemId: wi.id, owner: assignee });
        if (!leased) {
          await releaseWorkItem(wi.id, { harness: args.harness });
          return null;
        }
      }
      return wi;
    };

    const count = args.count ?? 1;
    // Backward-compatible single-item shape when count is omitted/1.
    if (count === 1) {
      const wi = await claimOne();
      return { content: [{ type: 'text' as const, text: JSON.stringify(wi ? { ok: true, workItem: wi } : { ok: false, error: 'no claimable work-item' }) }] };
    }

    // count>1: loop the same atomic claim up to N times, STOPPING at the first miss
    // (queue dry / all leases lost) — each iteration claims a DIFFERENT oldest row
    // (SKIP LOCKED), so this batches a self-select sweep without a double-claim. Returns
    // an array (possibly shorter than `count`, possibly empty).
    const claimed = [];
    for (let i = 0; i < count; i += 1) {
      const wi = await claimOne();
      if (!wi) break;
      claimed.push(wi);
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: claimed.length > 0, claimed }) }] };
  },
});
