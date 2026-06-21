/**
 * work_items:observe — the tuple-space `rd` (D-004).
 *
 * Plan: fleet-as-supervised-blackboard-2026-06-04. Observe a work-item WITHOUT claiming
 * it — the read primitive kept distinct from the `in` of claim. Reports claimability so
 * a self-selecting agent can decide before taking.
 *
 * Bulk by default (bulk-endpoint-standardization-2026-06-21): pass `id` for one or
 * `ids` for several → { ok, results:[{ ok, id, …observation | error }], counts }.
 */
import { z } from 'zod';
import { defineTool } from '@papercusp/agent-mcp';
import { COORD_ROLES } from '../coordination/roles';
import { observeWorkItem } from '../../work-items';
import { mergeIds, runBulk, bulkContent } from '../_bulk';

export default defineTool({
  name: 'work_items:observe',
  profile: 'engineer',
  description:
    'Observe one OR many work-items WITHOUT claiming (tuple-space `rd`) — pass `id` for one or `ids` for several (1–100): reports each item\'s availability + who holds it. Distinct from claim (`in`). Returns { ok, results:[{ ok, id, …observation | error }], counts } — correlate by id, not position.',
  guidance: {
    when: 'Inspect one or more work-items\' claimability before deciding to claim — read without taking. Pass every id you are weighing at once.',
    chaining: 'work_items:observe → work_items:claim (if available).',
  },
  capability: 'work_items:read',
  requirePrincipal: false,
  agentRoles: [...COORD_ROLES],
  args: z
    .object({
      id: z.string().min(1).optional().describe('a single work-item id (n=1 shorthand for ids:[id])'),
      ids: z.array(z.string().min(1)).max(100).optional().describe('work-item ids to observe (1–100)'),
      harness: z.string().max(80).optional(),
    })
    .refine((a) => Boolean(a.id) || (a.ids?.length ?? 0) > 0, { message: 'pass `id` (one) or `ids` (many)' }),
  async handler(args) {
    const ids = mergeIds(args.id, args.ids);
    const env = await runBulk(
      ids,
      async (id) => {
        const obs = await observeWorkItem(id, { harness: args.harness });
        return obs
          ? { ...obs, ok: true as const, id }
          : { ok: false as const, id, error: `work_item '${id}' not found` };
      },
      { keyOf: (id) => ({ id }) },
    );
    return bulkContent(env);
  },
});
