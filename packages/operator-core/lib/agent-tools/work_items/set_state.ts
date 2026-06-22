/**
 * work_items:set_state — Lifecycle (D-003). Sets the kind-specific lifecycle state
 * (feature-family → status e.g. todo|in_progress|passed|failing; issue-family →
 * open|resolved|closed). Dispatches to the right kind-table.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): set ONE inline
 * ({ id, state }), MANY to the SAME state (ids:[…] + state), or MANY heterogeneous
 * (items:[{ id, state, harness?, decision? }]) → { ok, results:[{ ok, id, workItem?
 * | error }], counts }. The P-114 arm tripwire is evaluated PER item; the
 * plan-item reflect + rationale-reproject reactions fire per item (D-007).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { resolveAgentIdentity } from '../coordination/identity';
import { COORD_ROLES } from '../coordination/roles';
import { setWorkItemState } from '../../work-items';
import { planWorkItemArm, commitWorkItemArm } from './arm-reversible-work-item';
import { runBulk, bulkContent } from '../_bulk';

// P-114: an AUTONOMOUS agent declares the action's risk/authority so the auto-revert
// tripwire arms faithfully to the upstream decision (the verb has no inherent item
// risk). Absent ⇒ fail-safe `critical`. Ignored for human callers.
const decisionSpec = z.object({
  riskTier: z.enum(['trivial', 'low', 'moderate', 'high', 'critical']).optional(),
  authority: z.enum(['system', 'owner']).optional(),
});

const itemSpec = z.object({
  id: z.string().min(1),
  state: z.string().min(1).max(40),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  decision: decisionSpec.optional(),
});

export default defineTool({
  name: 'work_items:set_state',
  profile: 'engineer',
  description:
    'Set the lifecycle state of one OR many work-items. feature-family: a feature status (todo|in_progress|passed|failing|deprecated…). issue-family: open|resolved|closed. Single: { id, state }. Many same state: { ids:[…], state }. Many heterogeneous: items:[{ id, state, harness?, decision? }]. Returns { ok, results:[{ ok, id, workItem? | error }], counts } — correlate by id; a not-found item never fails the rest.',
  guidance: {
    when: 'You moved one or more work-items along the lifecycle (started, resolved, etc.). Flip a whole wave at once via { ids:[…], state } or items:[…].',
    chaining: 'work_items:claim → … → work_items:set_state { state }.',
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single shorthand: the work-item id (use with `state`)'),
      state: z.string().min(1).max(40).optional().describe('the lifecycle state applied to the inline id / every id in `ids`'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / ids / items that omit one'),
      decision: decisionSpec.optional().describe('P-114 risk/authority for the inline id / every id in `ids`'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('set MANY items to the same `state` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('set many work-items at once — each { id, state, harness?, decision? }'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (Boolean(a.state) && ((a.ids?.length ?? 0) > 0 || Boolean(a.id))), {
      message: 'pass { id, state } for one, { ids:[…], state } for many of the same state, or items:[{ id, state }] for many',
    }),
  async handler(args, ctx) {
    const ident = resolveAgentIdentity(ctx);
    const list = args.items?.length
      ? args.items
      : args.ids?.length
        ? args.ids.map((id) => ({ id, state: args.state as string, harness: args.harness, decision: args.decision }))
        : [{ id: args.id as string, state: args.state as string, harness: args.harness, decision: args.decision }];
    const env = await runBulk(
      list,
      async (it) => {
        const harness = it.harness ?? args.harness;
        // P-114 arm-call-site: gate-FIRST (before the mutation) so the captured prior-state
        // handle is faithful; best-effort (never fails the verb); null on the common path.
        const armPlan = await planWorkItemArm(
          ctx,
          'work_items:set_state',
          'state',
          it.id,
          harness,
          it.decision,
        ).catch(() => null);
        const workItem = await setWorkItemState(it.id, it.state, { harness, by: ident.ownerId });
        if (armPlan && workItem) await commitWorkItemArm(armPlan).catch(() => {});
        return workItem
          ? { ok: true as const, id: it.id, workItem }
          : { ok: false as const, id: it.id, error: `work_item '${it.id}' not found` };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
