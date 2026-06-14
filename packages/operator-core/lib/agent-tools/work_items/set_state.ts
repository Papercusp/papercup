/**
 * work_items:set_state — Lifecycle (D-003). Sets the kind-specific lifecycle state
 * (feature-family → status e.g. todo|in_progress|passed|failing; issue-family →
 * open|resolved|closed). Dispatches to the right kind-table.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { setWorkItemState } from '../../work-items';
import { planWorkItemArm, commitWorkItemArm } from './arm-reversible-work-item';

export default defineTool({
  name: 'work_items:set_state',
  profile: 'engineer',
  description: 'Set a work-item\'s lifecycle state. feature-family: a feature status (todo|in_progress|passed|failing|deprecated…). issue-family: open|resolved|closed.',
  guidance: {
    when: 'You moved a work-item along its lifecycle (started, resolved, etc.).',
    chaining: 'work_items:claim → … → work_items:set_state { state }.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z.object({
    id: z.string().min(1),
    state: z.string().min(1).max(40),
    harness: z.string().max(80).optional(),
    // P-114: an AUTONOMOUS agent declares the action's risk/authority so the
    // auto-revert tripwire arms faithfully to the upstream decision (the verb has
    // no inherent item risk). Absent ⇒ fail-safe `critical`. Ignored for human callers.
    decision: z
      .object({
        riskTier: z.enum(['trivial', 'low', 'moderate', 'high', 'critical']).optional(),
        authority: z.enum(['system', 'owner']).optional(),
      })
      .optional(),
  }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    // P-114 arm-call-site (queen-autonomy-policy): when an AUTONOMOUS agent auto-takes
    // this reversible action under an armed, below-never-auto ceiling, arm the B-16
    // revert-watch. Gate-FIRST (before the mutation) so the captured prior-state handle
    // is faithful; best-effort (never fails the verb); `null` on the common path (human
    // caller / disarmed policy / never-auto ceiling — today's whole population, D-007).
    const armPlan = await planWorkItemArm(
      ctx,
      'work_items:set_state',
      'state',
      args.id,
      args.harness,
      args.decision,
    ).catch(() => null);
    try {
      const workItem = await setWorkItemState(args.id, args.state, { harness: args.harness, by: ident.ownerId });
      if (armPlan && workItem) await commitWorkItemArm(armPlan).catch(() => {});
      return { content: [{ type: 'text' as const, text: JSON.stringify(workItem ? { ok: true, workItem } : { ok: false, error: `work_item '${args.id}' not found` }) }] };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error }) }] };
    }
  },
});
