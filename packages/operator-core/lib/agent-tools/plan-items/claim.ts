/**
 * plan_items:claim — take the live, leased grip on a plan item (Phase 1/2).
 *
 * Enforces the policy: an ASSIGNED item may only be claimed by its assignee-NAME
 * (so adopt that name first); an UNASSIGNED item is a pool pull (gated by work-group
 * membership when the plan has a work-group). The lease's liveness mode is resolved
 * from the harness (LOCAL=availability / SHARED=activity) unless forced.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { bestEffortOwnerUser, resolveAdoptedName } from '../../plan-items/agent-names';
import { claimPlanItem } from '../../plan-items/liveness';

export default defineTool({
  name: 'plan_items:claim',
  description:
    'Take the live, heartbeat-leased grip on a plan item — what you call when you actually START it. Refused if the item is assigned to a different agent-name, or unassigned in a plan whose work-group you have not joined. Returns the claim (with claim_id + lease expiry); keep it alive with plan_items:heartbeat, drop it with plan_items:release.',
  guidance: {
    when: 'You are about to begin work on an item (yours via assignment, or pulled from the pool).',
    notWhen: 'You only want to mark intent for later without starting — that is assignment, not a claim. Renewing an existing claim — that is plan_items:heartbeat.',
    chaining: 'plan_items:claim { harness, plan, item } → work → plan_items:heartbeat (per turn) → plan_items:release when done.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    plan: z.string().min(1).describe('plan slug'),
    item: z.string().min(1).describe('plan-item id (P-NNN)'),
    harness: z.string().max(120).optional().describe('harness the plan lives in (default: papercup)'),
    intent: z.string().max(400).optional().describe('one line on what you are doing'),
    mode: z.enum(['availability', 'activity']).optional().describe('force the liveness mode (default: resolved from the harness — LOCAL=availability, SHARED=activity)'),
    ttl_sec: z.number().int().positive().max(7200).optional().describe('lease TTL seconds (default 1200 availability / 1800 activity)'),
  }),
  async handler(args, ctx) {
    const id = resolveAgentIdentity(ctx);
    const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: args.harness });
    const ownerName = await resolveAdoptedName(workspaceId, id.ownerId);
    const result = await claimPlanItem({
      workspaceId,
      harnessSlug,
      planSlug: args.plan,
      itemId: args.item,
      owner: id.ownerId,
      ownerLabel: id.ownerLabel,
      ownerName,
      ownerUser: bestEffortOwnerUser(ctx),
      intent: args.intent,
      livenessMode: args.mode,
      ttlSec: args.ttl_sec,
    });
    const ok = result.status === 'claimed';
    return { content: [{ type: 'text' as const, text: JSON.stringify({ ok, result }) }] };
  },
});
