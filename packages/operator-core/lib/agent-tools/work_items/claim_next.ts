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
import { claimNextWorkItem } from '../../work-items';

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
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    harness: z.string().min(1),
    kind: z.enum(['feature', 'research-task', 'chunk']).optional(),
    assignee: z.string().max(120).optional().describe('default: you'),
    states: z.array(z.string()).max(20).optional().describe('claimable states (default ["todo"])'),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const wi = await claimNextWorkItem({
      harness: args.harness,
      assignee: args.assignee ?? ident.ownerId,
      kind: args.kind,
      states: args.states,
    });
    return { content: [{ type: 'text' as const, text: JSON.stringify(wi ? { ok: true, workItem: wi } : { ok: false, error: 'no claimable work-item' }) }] };
  },
});
