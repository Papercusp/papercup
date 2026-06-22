/**
 * plan_items:assign — push-assign a plan item to a stable agent-NAME (D-002/D-005).
 *
 * Intra-user push only: you assign to a name YOU own (your tokens). Assigning to a
 * fresh name claims it for you; assigning to a name owned by ANOTHER user is refused
 * (cross-user is pull-only — they claim from the pool). The assignment is durable
 * (survives sleep/interrupt) and federates as content.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): assign ONE inline
 * ({ plan, item, assignee, … }), MANY in the SAME plan to the SAME assignee
 * ({ plan, itemIds:[…], assignee }), or MANY heterogeneous
 * (items:[{ plan, item, assignee, … }]) → { ok, results:[{ ok, plan, item,
 * assignment? | refused | error }], counts }. Each result self-describes its
 * { plan, item }; one refusal/error never fails the rest.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { resolvePlanScope } from '../plans/source';
import { bestEffortOwnerUser, agentNameOwner, registerAgentName } from '../../plan-items/agent-names';
import { assignItem } from '../../plan-items/assignments';
import { runBulk, bulkContent, type BulkItemResult } from '../_bulk';

interface AssignSpecItem {
  plan: string;
  item: string;
  assignee: string;
  harness?: string;
  strategy?: string;
  note?: string;
}

const itemSpec = z.object({
  plan: z.string().min(1).describe('plan slug'),
  item: z.string().min(1).describe('plan-item id (P-NNN)'),
  assignee: z.string().min(1).max(80).describe('the agent-name to assign to'),
  harness: z.string().max(120).optional().describe('per-item harness (else the batch `harness` default)'),
  strategy: z.string().max(200).optional().describe('optional execution-strategy/blueprint hint'),
  note: z.string().max(2000).optional(),
});

export default defineTool({
  name: 'plan_items:assign',
  description:
    'Push-assign one OR many plan items (P-NNN) to a stable agent-NAME. Durable intent — survives interruption; the named agent reads it via plan_items:my_items and claims it. Intra-user only: a name you own (a fresh name is claimed for you); a name owned by another user is refused (cross-user is pull-only). Single: { plan, item, assignee }. Many same plan+assignee: { plan, itemIds:[…], assignee }. Many heterogeneous: items:[{ plan, item, assignee, harness?, strategy?, note? }]. Returns { ok, results:[{ ok, plan, item, assignment? | refused | error }], counts } — correlate by { plan, item }; one refusal never fails the rest.',
  guidance: {
    when: 'You are dividing your own plan work across your named agents — "builder-1 takes P-001..P-003". Assign several at once via itemIds:[…] or items:[…].',
    notWhen: 'You want to start working on an item right now — that is plan_items:claim (the live grip). Handing work to another USER\'s agents — they pull it (you cannot push onto their machine).',
    chaining: 'plan_items:assign { harness, plan, item, assignee } → the named agent: plan_items:my_items → plan_items:claim.',
  },
  capability: 'coord:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      plan: z.string().min(1).optional().describe('plan slug (use with `item` / `itemIds`)'),
      item: z.string().min(1).optional().describe('single-assign shorthand: the plan-item id (P-NNN)'),
      assignee: z.string().min(1).max(80).optional().describe('the agent-name to assign to (the inline item / every id in `itemIds`)'),
      itemIds: z.array(z.string().min(1)).min(1).max(200).optional().describe('assign MANY items in `plan` to the same `assignee` (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('assign many plan items at once — each { plan, item, assignee, harness?, strategy?, note? }'),
      harness: z.string().max(120).optional().describe('default harness for the inline item / itemIds / items that omit one (default: papercup)'),
      strategy: z.string().max(200).optional().describe('optional execution-strategy/blueprint hint (the inline item / every id in `itemIds`)'),
      note: z.string().max(2000).optional().describe('note for the inline item / every id in `itemIds`'),
    })
    .refine(
      (a) =>
        (a.items?.length ?? 0) > 0 ||
        (Boolean(a.plan) && Boolean(a.assignee) && ((a.itemIds?.length ?? 0) > 0 || Boolean(a.item))),
      {
        message:
          'pass { plan, item, assignee } for one, { plan, itemIds:[…], assignee } for many of the same plan, or items:[{ plan, item, assignee }] for many',
      },
    ),
  async handler(args, ctx) {
    const ownerUser = bestEffortOwnerUser(ctx);
    const list: AssignSpecItem[] = args.items?.length
      ? args.items.map((it) => ({
          plan: it.plan,
          item: it.item,
          assignee: it.assignee,
          harness: it.harness ?? args.harness,
          strategy: it.strategy ?? args.strategy,
          note: it.note ?? args.note,
        }))
      : args.itemIds?.length
        ? args.itemIds.map((item) => ({
            plan: args.plan as string,
            item,
            assignee: args.assignee as string,
            harness: args.harness,
            strategy: args.strategy,
            note: args.note,
          }))
        : [
            {
              plan: args.plan as string,
              item: args.item as string,
              assignee: args.assignee as string,
              harness: args.harness,
              strategy: args.strategy,
              note: args.note,
            },
          ];
    const env = await runBulk(
      list,
      async (it): Promise<BulkItemResult> => {
        const { workspaceId, harnessSlug } = await resolvePlanScope({ harnessSlug: it.harness });
        const existingOwner = await agentNameOwner(workspaceId, it.assignee);
        if (existingOwner && existingOwner !== ownerUser) {
          return {
            ok: false,
            plan: it.plan,
            item: it.item,
            refused: `agent-name '${it.assignee}' is owned by another user — cross-user assignment is pull-only (D-005). They join the work-group and claim it.`,
          };
        }
        if (!existingOwner) await registerAgentName(workspaceId, it.assignee, ownerUser);
        const assignment = await assignItem({
          workspaceId,
          harnessSlug,
          planSlug: it.plan,
          itemId: it.item,
          assigneeName: it.assignee,
          assignedByUser: ownerUser,
          strategy: it.strategy ?? null,
          note: it.note ?? null,
        });
        return { ok: true, plan: it.plan, item: it.item, assignment };
      },
      { keyOf: (it) => ({ plan: it.plan, item: it.item }) },
    );
    return bulkContent(env);
  },
});
