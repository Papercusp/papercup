/**
 * work_items:release — Claimable (D-003). Unassigns the work-item.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): release ONE inline
 * ({ id }), or MANY (ids:[…] / items:[{ id, harness? }]) → { ok, results:[{ ok, id,
 * workItem? | error }], counts }. Each result self-describes its id; one not-found
 * item never fails the rest. The plan-item reflect rules (flip the converted plan
 * item back to todo + drop the lease) fire per released item (D-007).
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { releaseWorkItem, setWorkItemClaimHold } from '../../work-items';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  id: z.string().min(1),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
  claimHold: z
    .boolean()
    .optional()
    .describe('per-item claim-hold override (else the batch `claimHold` default)'),
});

export default defineTool({
  name: 'work_items:release',
  profile: 'engineer',
  description:
    'Release one OR many work-items (clear assignee / taken_by) so another agent can pick them up. Single: { id }. Many: { ids:[…] } or items:[{ id, harness? }]. Returns { ok, results:[{ ok, id, workItem? | error }], counts } — correlate by id; a not-found item never fails the rest. A voluntary release records short cooldown provenance so the releasing agent does not immediately re-claim the same row. Pass `claimHold:true` (issue-family only) to ALSO durably park the item out of claim_next/scheduler:get_next self-select — for a do-not-opportunistically-claim item (needs a dedicated owner, out of repo scope, …) that would otherwise keep resurfacing to the next self-selecting agent (WI-2797); it stays directly claimable by id. `claimHold:false` clears a prior hold.',
  guidance: {
    when: 'You claimed work-item(s) but are no longer working them. Release several at once via ids:[…]. Add claimHold:true when the item must NOT be opportunistically re-claimed by the next self-selecting agent (a recurring do-not-pick-up ticket) — plain release lets it re-surface immediately.',
    chaining: 'work_items:claim → … → work_items:release.',
    seeAlso: [
      'work_items:set_state { state:"blocked" } (feature-family park with a reason; issue-family aliases blocked back to open — release { claimHold:true } is the durable self-select exclusion for issue-family)',
      'work_items:claim (re-take it later, or claim a held item directly by id — a hold only excludes self-select)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-release shorthand: the work-item id'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('release many work-items at once (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('release many, each { id, harness?, claimHold? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / ids / items that omit one'),
      claimHold: z
        .boolean()
        .optional()
        .describe(
          'default claim-hold for the inline id / every id in `ids` (issue-family only): true excludes the item from claim_next/scheduler:get_next self-select until cleared; false clears a prior hold.',
        ),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    }),
  async handler(args) {
    const list = args.items?.length
      ? args.items
      : args.ids?.length
        ? args.ids.map((id) => ({ id, harness: args.harness, claimHold: args.claimHold }))
        : [{ id: args.id as string, harness: args.harness, claimHold: args.claimHold }];
    const env = await runBulk(
      list,
      async (it) => {
        const workItem = await releaseWorkItem(it.id, { harness: it.harness ?? args.harness });
        if (!workItem) return { ok: false as const, id: it.id, error: `work_item '${it.id}' not found` };
        const claimHold = it.claimHold ?? args.claimHold;
        if (claimHold === undefined) return { ok: true as const, id: it.id, workItem };
        const held = await setWorkItemClaimHold(it.id, claimHold, { harness: it.harness ?? args.harness });
        return {
          ok: true as const,
          id: it.id,
          workItem,
          claimHold: held?.applicable ? held.hold : undefined,
        };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
