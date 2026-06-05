/**
 * plan_items:heartbeat — renew a claim's lease (the liveness pulse, D-003).
 *
 * The MODE governs what renews: on a LOCAL (availability) harness ANY heartbeat
 * keeps the claim (the session proving it is alive); on a SHARED (activity) harness
 * only an 'activity' (a completed turn) or an explicit 'extend' renews it — a bare
 * 'keepalive' does NOT, so an idle shared claim lapses and returns to the pool.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { getClaim, heartbeatClaim } from '../../plan-items/claims';

export default defineTool({
  name: 'plan_items:heartbeat',
  description:
    'Renew your claim\'s lease. Send kind="activity" when you complete a unit of work (the turn-based pulse a SHARED harness needs), kind="extend" with a larger ttl_sec for a legitimately long single operation, or kind="keepalive" to prove liveness on a LOCAL harness. claim_id optional (resolved from your current claim).',
  guidance: {
    when: 'Periodically while holding a claim — ideally once per completed turn (kind="activity"), or kind="extend" before a long uninterrupted op.',
    notWhen: 'You are done — that is plan_items:release. The claim has already lapsed — re-acquire with plan_items:claim (a lapsed claim cannot be heartbeated back to life).',
    chaining: 'plan_items:claim → plan_items:heartbeat { kind: "activity" } per turn → plan_items:release.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    plan: z.string().min(1).describe('plan slug'),
    item: z.string().min(1).describe('plan-item id (P-NNN)'),
    harness: z.string().max(120).optional().describe('harness the plan lives in (default: papercup)'),
    kind: z.enum(['activity', 'extend', 'keepalive']).optional().describe('activity = a completed turn (default); extend = long op (+ttl_sec); keepalive = liveness-only'),
    ttl_sec: z.number().int().positive().max(7200).optional().describe('new lease TTL (use with kind="extend" for a long op)'),
    claim_id: z.string().uuid().optional().describe('the claim_id (default: your current claim on the item)'),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: args.harness });
    let claimId = args.claim_id;
    if (!claimId) {
      const current = await getClaim(workspaceId, harnessSlug, args.plan, args.item);
      if (!current || current.owner !== id.ownerId) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, renewed: false, held: false, note: 'you hold no claim on this item — re-acquire with plan_items:claim' }) }] };
      }
      claimId = current.claimId;
    }
    const result = await heartbeatClaim(
      workspaceId,
      harnessSlug,
      args.plan,
      args.item,
      claimId,
      id.ownerId,
      args.kind ?? 'activity',
      args.ttl_sec,
    );
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: result.held, ...result }) }] };
  },
});
