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
import { releaseWorkItem } from '../../work-items';
import { runBulk, bulkContent } from '../_bulk';

const itemSpec = z.object({
  id: z.string().min(1),
  harness: z.string().max(80).optional().describe('per-item harness (else the batch `harness` default)'),
});

export default defineTool({
  name: 'work_items:release',
  profile: 'engineer',
  description:
    'Release one OR many work-items (clear assignee / taken_by) so another agent can pick them up. Single: { id }. Many: { ids:[…] } or items:[{ id, harness? }]. Returns { ok, results:[{ ok, id, workItem? | error }], counts } — correlate by id; a not-found item never fails the rest. A voluntary release records short cooldown provenance so the releasing agent does not immediately re-claim the same row.',
  guidance: {
    when: 'You claimed work-item(s) but are no longer working them. Release several at once via ids:[…].',
    chaining: 'work_items:claim → … → work_items:release.',
    seeAlso: [
      'work_items:set_state { state:"blocked" } (feature-family park with a reason; issue-family aliases blocked back to open, so release/cooldown is the current safe deferral path there)',
      'work_items:claim (re-take it later)',
    ],
  },
  capability: 'work_items:write',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('single-release shorthand: the work-item id'),
      ids: z.array(z.string().min(1)).min(1).max(200).optional().describe('release many work-items at once (homogeneous)'),
      items: z.array(itemSpec).min(1).max(200).optional().describe('release many, each { id, harness? }'),
      harness: z.string().max(80).optional().describe('default harness for the inline id / ids / items that omit one'),
    })
    .refine((a) => (a.items?.length ?? 0) > 0 || (a.ids?.length ?? 0) > 0 || Boolean(a.id), {
      message: 'pass { id } for one, or { ids:[…] } / items:[{ id }] for many',
    }),
  async handler(args) {
    const list = args.items?.length
      ? args.items
      : args.ids?.length
        ? args.ids.map((id) => ({ id, harness: args.harness }))
        : [{ id: args.id as string, harness: args.harness }];
    const env = await runBulk(
      list,
      async (it) => {
        const workItem = await releaseWorkItem(it.id, { harness: it.harness ?? args.harness });
        return workItem
          ? { ok: true as const, id: it.id, workItem }
          : { ok: false as const, id: it.id, error: `work_item '${it.id}' not found` };
      },
      { keyOf: (it) => ({ id: it.id }) },
    );
    return bulkContent(env);
  },
});
