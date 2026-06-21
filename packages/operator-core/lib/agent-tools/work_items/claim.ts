/**
 * work_items:claim — Claimable (D-003). Assigns the work-item to an agent
 * (feature-family → taken_by; issue-family → assignee) and subscribes the claimer.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { claimWorkItem, classifyClaimFailure, getWorkItem } from '../../work-items';

export default defineTool({
  name: 'work_items:claim',
  profile: 'engineer',
  description: 'Claim a work-item (assign it to yourself, or to `assignee`). Claiming a feature sets taken_by; an issue sets assignee.',
  guidance: {
    when: 'You are starting work on a work-item — claim it so peers do not duplicate.',
    notWhen: 'A `claim_conflict` means a LIVE peer already holds it — coordinate with the `holder` (coord:send) or pick another item; do not blind-retry. (If the holder is dead, the stale-claim reclaim lane frees it.)',
    chaining: 'work_items:list → work_items:claim → work_items:set_state → work_items:release/close.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    assignee: z.string().max(120).optional().describe('default: you'),
    harness: z.string().max(80).optional(),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const claimer = args.assignee ?? ident.ownerId;
    const workItem = await claimWorkItem(args.id, claimer, { harness: args.harness });
    if (workItem) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, workItem }) }] };
    }
    // EI-2197: claimWorkItem returns a bare null for THREE distinct outcomes; the
    // old code reported all of them as "not found", which is wrong for an item that
    // exists but is already held (the get/observe/comment/complete tools resolve it
    // fine — only claim's compare-and-claim lost). Re-read + classify so the agent
    // gets an accurate, actionable error instead of chasing a phantom resolver bug.
    const current = await getWorkItem(args.id, args.harness);
    const failure = classifyClaimFailure(current, claimer);
    if (failure.reason === 'not_found') {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: `work_item '${args.id}' not found` }) }], isError: true };
    }
    if (failure.reason === 'conflict') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({
          ok: false,
          error: 'claim_conflict',
          id: args.id,
          holder: failure.holder,
          workItem: current,
          hint: `Already claimed by ${failure.holder} — the item exists (get/observe/comment/complete resolve it). Coordinate with the holder via coord:send, or pick another item; if that agent is dead, the stale-claim reclaim lane frees it. Do not blind-retry with a different harness.`,
        }) }],
        isError: true,
      };
    }
    // gated: exists, unheld, but admission/trust refused the claim (or a race just released it).
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({
        ok: false,
        error: 'not_claimable',
        id: args.id,
        workItem: current,
        hint: 'Item exists but the claim was refused by a trust/admission gate, or it was released between the claim and this re-read — re-check with work_items:get / work_items:observe.',
      }) }],
      isError: true,
    };
  },
});
